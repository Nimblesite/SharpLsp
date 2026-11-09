//! Where a sidecar comes from and how the host reaches it: the launch command
//! resolution chain, the per-spawn IPC endpoint and the framed transport over it.
//! Implements [SIDECAR-STARTUP-RESOLUTION], [SIDECAR-STARTUP-ENDPOINT], [SIDECAR-STARTUP-SPAWN].

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use tracing::{debug, info, warn};

use crate::sidecar::transport::FramedTransport;

/// Resolve sidecar launch command and arguments.
///
/// Resolution order:
///   1. `dotnet tool` shim on `PATH` (e.g. `sharplsp-sidecar-csharp`).
///      This is the production distribution path.
///   2. Legacy installed layouts (VSIX bundle, `make install`, dev target).
///      Kept as a transitional fallback while the distribution spec
///      migrates away from bundled sidecars; see
///      `docs/specs/BINARY-DEPLOYMENT.md`.
///   3. Dev build via `dotnet run --project src/sidecars/<name>`
///      (CWD = repo root).
// TODO [SIDECAR-STARTUP-RESOLUTION]: validate absolute candidates and remove dotnet run.
pub(super) fn sidecar_launch(
    tool_command: &str,
    subdir: &str,
    name: &str,
    socket_path: &str,
) -> (String, Vec<String>) {
    let path_var = std::env::var_os("PATH");
    sidecar_launch_on(path_var.as_deref(), tool_command, subdir, name, socket_path)
}

/// [`sidecar_launch`] against the `PATH` value `path_var`, so the resolution
/// order is testable without mutating the process environment.
pub(super) fn sidecar_launch_on(
    path_var: Option<&std::ffi::OsStr>,
    tool_command: &str,
    subdir: &str,
    name: &str,
    socket_path: &str,
) -> (String, Vec<String>) {
    debug!(
        tool_command,
        subdir, name, socket_path, "Resolving sidecar launch command"
    );

    // [SHARPLSP-ARCHITECTURE-EXTENSIONS-SIDECAR-ENV]: env var override takes absolute priority.
    if let Some(exe) = env_var_sidecar_override(subdir) {
        info!(exe = %exe.display(), source = "env-var", "Sidecar resolved");
        return (exe.to_string_lossy().to_string(), sidecar_args(socket_path));
    }

    if let Some(found) = path_var.and_then(|path| crate::paths::find_command(tool_command, path)) {
        info!(tool = %tool_command, path = %found.display(), source = "PATH", "Sidecar resolved");
        return (tool_command.to_string(), sidecar_args(socket_path));
    }
    debug!(tool_command, "Tool not found on PATH");

    if let Some(exe) = installed_sidecar_exe(subdir, name) {
        info!(exe = %exe.display(), source = "installed", "Sidecar resolved");
        return (exe.to_string_lossy().to_string(), sidecar_args(socket_path));
    }

    info!(sidecar = %name, source = "dotnet-run", "Sidecar resolved — using dev dotnet run");
    let run = [
        "run".to_string(),
        "--project".to_string(),
        format!("src/sidecars/{name}"),
        "--".to_string(),
    ];
    (
        "dotnet".to_string(),
        run.into_iter().chain(sidecar_args(socket_path)).collect(),
    )
}

/// Arguments every launch source passes the sidecar: its endpoint, then this
/// host's PID, which arms the sidecar's parent-death watchdog and Windows Job
/// Object containment so a hard host death cannot leak the sidecar tree.
/// Implements `[SIDECAR-STARTUP-SPAWN]` and `[SIDECAR-PROCESS-PARENT]` (GitHub #163).
pub(super) fn sidecar_args(socket_path: &str) -> Vec<String> {
    vec![
        socket_path.to_string(),
        "--parent-pid".to_string(),
        std::process::id().to_string(),
    ]
}

/// Return the sidecar path from an env var override, if set.
///
/// Converts `sidecar-csharp` → `SHARPLSP_CSHARP_SIDECAR_PATH`,
/// `sidecar-fsharp` → `SHARPLSP_FSHARP_SIDECAR_PATH`, etc.
fn env_var_sidecar_override(subdir: &str) -> Option<std::path::PathBuf> {
    let kind = subdir.strip_prefix("sidecar-")?;
    let env_key = format!("SHARPLSP_{}_SIDECAR_PATH", kind.to_ascii_uppercase());
    match std::env::var(&env_key) {
        Err(_) => {
            debug!(env_key = %env_key, "Env var not set — skipping env-var override");
            None
        }
        Ok(val) => {
            let path = std::path::PathBuf::from(&val);
            if path.exists() {
                debug!(env_key = %env_key, path = %val, "Env var sidecar override resolved");
                Some(path)
            } else {
                warn!(env_key = %env_key, path = %val, "Env var sidecar override set but path does not exist — skipping");
                None
            }
        }
    }
}

/// Check for a published sidecar executable.
///
/// Searches three layouts in priority order:
///   1. VSIX bundle:    `<exe_dir>/<subdir>/<name>[.exe]`
///   2. `make install`: `<exe_dir>/../lib/sharplsp/<subdir>/<name>[.exe]`
///   3. Dev build:      `<exe_dir>/../<subdir>/<name>[.exe]`
///      (e.g. `target/sidecar-csharp/` next to `target/release/sharplsp`,
///      where `make build-dotnet` writes the published sidecar output)
pub(super) fn installed_sidecar_exe(subdir: &str, name: &str) -> Option<std::path::PathBuf> {
    let current = std::env::current_exe().ok()?;
    let exe_dir = current.parent()?;
    debug!(current_exe = %current.display(), exe_dir = %exe_dir.display(), "Resolving installed sidecar");

    let exe_name = crate::paths::executable_name(name);

    // 1. VSIX layout: sidecar sits next to the binary.
    let vsix = exe_dir.join(subdir).join(&exe_name);
    debug!(candidate = %vsix.display(), "Checking VSIX layout");
    if vsix.exists() {
        debug!(path = %vsix.display(), "Found sidecar at VSIX layout");
        return Some(vsix);
    }

    // 2. make install layout: ../lib/sharplsp/<subdir>/
    let installed = exe_dir
        .parent()?
        .join("lib/sharplsp")
        .join(subdir)
        .join(&exe_name);
    debug!(candidate = %installed.display(), "Checking make-install layout");
    if installed.exists() {
        debug!(path = %installed.display(), "Found sidecar at make-install layout");
        return Some(installed);
    }

    // 3. Dev-build layout: sibling of target/release or target/debug.
    let dev = exe_dir.parent()?.join(subdir).join(&exe_name);
    debug!(candidate = %dev.display(), "Checking dev-build layout");
    if dev.exists() {
        debug!(path = %dev.display(), "Found sidecar at dev-build layout");
        Some(dev)
    } else {
        warn!(
            vsix = %vsix.display(),
            installed = %installed.display(),
            dev = %dev.display(),
            "No installed sidecar found at any layout — falling back to dotnet run"
        );
        None
    }
}

/// Monotonic counter making each sidecar endpoint unique within this process.
static IPC_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A short endpoint token that is unique per spawn.
///
/// #151: deriving the endpoint from the workspace root alone makes two hosts on
/// the same folder (e.g. two editor windows) compute an identical endpoint — on
/// Windows the second sidecar finds the single-instance pipe name taken and dies
/// before READY; on Unix it deletes and steals the live socket. Folding the
/// process id and a monotonic counter into the hash keeps the token short
/// (constant length, so it never trips the Unix socket-path limit) while making
/// it unique across hosts (pid) and within a host (counter). It is computed once
/// per manager and reused across restarts, so a restart keeps its own endpoint.
// TODO [SIDECAR-STARTUP-ENDPOINT]: generate a fresh OS-CSPRNG nonce for every spawn generation.
fn unique_endpoint_token(workspace_root: &Path) -> String {
    let sequence = IPC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let key = format!(
        "{}|{}|{}",
        workspace_root.to_string_lossy(),
        std::process::id(),
        sequence
    );
    format!("{:x}", fxhash(key.as_bytes()))
}

/// Build a platform-appropriate IPC path for a sidecar.
#[cfg(unix)]
pub(super) fn ipc_path(name: &str, workspace_root: &Path) -> String {
    format!(
        "{}/{}-{}.sock",
        std::env::temp_dir().display(),
        name,
        unique_endpoint_token(workspace_root)
    )
}

/// Build a platform-appropriate IPC path for a sidecar.
#[cfg(windows)]
pub(super) fn ipc_path(name: &str, workspace_root: &Path) -> String {
    format!(
        r"\\.\pipe\{}-{}",
        name,
        unique_endpoint_token(workspace_root)
    )
}

/// Connect to the sidecar IPC endpoint and return a `FramedTransport`.
#[cfg(unix)]
pub(super) async fn connect_transport(path: &str) -> Result<FramedTransport> {
    let stream = tokio::net::UnixStream::connect(path)
        .await
        .with_context(|| format!("connect to sidecar socket: {path}"))?;
    Ok(FramedTransport::new(stream))
}

/// Connect to the sidecar IPC endpoint and return a `FramedTransport`.
#[cfg(windows)]
#[expect(
    clippy::unused_async,
    reason = "API parity with the unix variant which awaits the connect"
)]
pub(super) async fn connect_transport(path: &str) -> Result<FramedTransport> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let pipe = ClientOptions::new()
        .open(path)
        .with_context(|| format!("connect to sidecar named pipe: {path}"))?;
    Ok(FramedTransport::new(pipe))
}

/// Simple FNV-style hash for generating short socket names.
pub(super) fn fxhash(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}
