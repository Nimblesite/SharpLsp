//! Detection of a process's .NET diagnostics IPC endpoint.
//!
//! `dotnet-trace collect -p <pid>` against a non-.NET process fails fast on
//! Unix (`ServerNotAvailableException`) but simply hangs on Windows, leaking
//! the collector child and registering a zombie session that only surfaces an
//! error when the user later clicks Stop. The CLR advertises a diagnostics
//! endpoint for every live .NET process — a named pipe
//! `\\.\pipe\dotnet-diagnostic-{pid}` on Windows, a
//! `dotnet-diagnostic-{pid}-*` socket in the temp directory elsewhere — so
//! its absence is a deterministic "not a .NET process" signal that can be
//! checked before spawning any collector. [GitHub #110]

/// Whether `pid` exposes a .NET diagnostics IPC endpoint.
///
/// Returns `None` when the endpoint registry cannot be enumerated at all —
/// callers should fail open (spawn and rely on their own attach-failure
/// detection) rather than reject a potentially valid target.
pub fn has_endpoint(pid: u32) -> Option<bool> {
    endpoint_exists(pid)
}

/// Windows: look for the `dotnet-diagnostic-{pid}` named pipe.
#[cfg(windows)]
fn endpoint_exists(pid: u32) -> Option<bool> {
    // The named-pipe filesystem is enumerable like a directory; listing it
    // does not connect to (and therefore cannot disturb) any pipe server.
    let exact = format!("dotnet-diagnostic-{pid}");
    let prefixed = format!("{exact}-");
    let entries = std::fs::read_dir(r"\\.\pipe\").ok()?;
    Some(entries.filter_map(Result::ok).any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        name == exact.as_str() || name.starts_with(&prefixed)
    }))
}

/// Unix: look for the `dotnet-diagnostic-{pid}-*` socket in the temp dirs.
#[cfg(unix)]
fn endpoint_exists(pid: u32) -> Option<bool> {
    // The runtime writes the socket to `$TMPDIR` on macOS but hardcodes
    // `/tmp` on Linux, so probe both locations.
    let prefix = format!("dotnet-diagnostic-{pid}-");
    let mut candidates = vec![std::env::temp_dir()];
    let linux_tmp = std::path::PathBuf::from("/tmp");
    if !candidates.contains(&linux_tmp) {
        candidates.push(linux_tmp);
    }

    let mut enumerable = false;
    for dir in candidates {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        enumerable = true;
        let found = entries
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix));
        if found {
            return Some(true);
        }
    }
    enumerable.then_some(false)
}
