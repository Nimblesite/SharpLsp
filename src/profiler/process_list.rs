//! List running processes using native OS APIs.
//!
//! Uses platform-native process enumeration (`ps` on Unix, `wmic` on Windows)
//! rather than `dotnet-trace ps` to avoid the ~350ms .NET runtime startup overhead.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{debug, info};

/// A discovered .NET process.
#[derive(Debug, Serialize)]
pub struct DotNetProcess {
    /// Process ID.
    pub pid: u32,
    /// Process name.
    pub name: String,
    /// Full command line used to launch the process.
    pub command_line: String,
    /// Detected .NET version — the shared-framework runtime version (e.g.
    /// `10.0.7`) or, failing that, the target framework moniker (`net10.0`).
    /// `None` when it can't be determined. Always serialized (`null` if absent).
    pub runtime_version: Option<String>,
}

/// Whether something (a process or its output directory) is .NET, plus the
/// runtime version when determinable. Memoized per directory in [`list`].
#[derive(Clone, Debug, PartialEq, Eq)]
enum DotnetMatch {
    /// Not a .NET process / output directory.
    No,
    /// A .NET process / output directory, carrying its runtime version if known.
    Yes(Option<String>),
}

/// List running **.NET** processes using the native OS process table.
///
/// Enumerates every process via the platform-native tool, then keeps only those
/// that are .NET: the `dotnet` host muxer (covers `dotnet run`/`exec`/`App.dll`)
/// and apphosts whose output directory carries a `*.runtimeconfig.json` (covers
/// framework-dependent apphosts and self-contained publishes — including this
/// repo's `sharplsp-sidecar-*` tools).
pub fn list() -> Result<Vec<DotNetProcess>> {
    info!("Listing .NET processes via native OS process table");
    let all = native_process_list()?;
    let mut cache: HashMap<PathBuf, DotnetMatch> = HashMap::new();
    let mut dotnet: Vec<DotNetProcess> = all
        .into_iter()
        .filter_map(
            |mut proc| match classify(&proc.command_line, &proc.name, &mut cache) {
                DotnetMatch::Yes(version) => {
                    proc.runtime_version = version;
                    Some(proc)
                }
                DotnetMatch::No => None,
            },
        )
        .collect();
    // Stable, predictable ordering: case-insensitive name, then PID.
    dotnet.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then(left.pid.cmp(&right.pid))
    });
    debug!("Found {} .NET process(es)", dotnet.len());
    Ok(dotnet)
}

/// Terminate a .NET process by PID.
///
/// Refuses any PID that is not currently a running .NET process — defence in
/// depth so this can never terminate the editor, the LSP host, or unrelated
/// native processes even if asked to.
pub fn kill(pid: u32) -> Result<()> {
    if !list()?.iter().any(|proc| proc.pid == pid) {
        bail!("refusing to kill PID {pid}: not a running .NET process");
    }
    info!("Terminating .NET process pid={pid}");
    native_kill(pid)
}

/// Classify a process from its command line: `None` for non-.NET processes,
/// `Some(version)` for .NET ones (`version` is the runtime/TFM when known).
///
/// `cache` memoizes the per-directory probe so the filesystem is touched at
/// most once per distinct directory.
fn classify(
    command_line: &str,
    name: &str,
    cache: &mut HashMap<PathBuf, DotnetMatch>,
) -> DotnetMatch {
    let exe = first_exe_token(command_line).unwrap_or(name);
    let exe_path = Path::new(exe);
    let base = exe_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    // The .NET host muxer: `dotnet run`/`exec`, `dotnet App.dll`, … — always
    // .NET; the version (if any) comes from the managed assembly's directory.
    if base.eq_ignore_ascii_case("dotnet") || base.eq_ignore_ascii_case("dotnet.exe") {
        return DotnetMatch::Yes(muxer_version(command_line, cache));
    }
    // An apphost: its publish/output directory carries a `*.runtimeconfig.json`.
    match exe_path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        Some(dir) => probe_dir(dir, cache),
        None => DotnetMatch::No,
    }
}

/// Runtime version for a `dotnet`-muxer process: probe the managed assembly's
/// directory (`dotnet App.dll` → `App.runtimeconfig.json`). `None` when the
/// command carries no managed assembly (e.g. `dotnet run`).
fn muxer_version(command_line: &str, cache: &mut HashMap<PathBuf, DotnetMatch>) -> Option<String> {
    let dll = command_line
        .split_whitespace()
        .find(|token| token.to_ascii_lowercase().ends_with(".dll"))?;
    let dir = Path::new(dll)
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())?;
    match probe_dir(dir, cache) {
        DotnetMatch::Yes(version) => version,
        DotnetMatch::No => None,
    }
}

/// Memoized probe of a directory for a `*.runtimeconfig.json` and its version.
fn probe_dir(dir: &Path, cache: &mut HashMap<PathBuf, DotnetMatch>) -> DotnetMatch {
    cache
        .entry(dir.to_path_buf())
        .or_insert_with(|| {
            find_runtimeconfig(dir).map_or(DotnetMatch::No, |path| {
                DotnetMatch::Yes(runtimeconfig_version(&path))
            })
        })
        .clone()
}

/// Extract the executable token from a command line, honoring a leading
/// double-quoted path (Windows) before falling back to whitespace splitting.
fn first_exe_token(command_line: &str) -> Option<&str> {
    let trimmed = command_line.trim_start();
    trimmed.strip_prefix('"').map_or_else(
        || trimmed.split_whitespace().next(),
        |rest| rest.split('"').next().filter(|token| !token.is_empty()),
    )
}

/// Path to the first `*.runtimeconfig.json` in `dir`, if any — the hallmark of
/// a .NET apphost's publish/output directory.
fn find_runtimeconfig(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.ends_with(".runtimeconfig.json"))
            .then(|| entry.path())
    })
}

/// Parse a `*.runtimeconfig.json` for a human-readable .NET version: the
/// shared-framework runtime version (e.g. `10.0.7`), falling back to the target
/// framework moniker (e.g. `net10.0`).
fn runtimeconfig_version(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let options = json.get("runtimeOptions")?;
    framework_version(options)
        .or_else(|| options.get("tfm").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
}

/// Runtime version from `runtimeOptions.framework` or the first `version` in
/// `runtimeOptions.frameworks`.
fn framework_version(options: &serde_json::Value) -> Option<&str> {
    let single = options.get("framework").and_then(|fw| fw.get("version"));
    let first_of_many = || {
        options
            .get("frameworks")?
            .as_array()?
            .iter()
            .find_map(|fw| fw.get("version"))
    };
    single
        .or_else(first_of_many)
        .and_then(serde_json::Value::as_str)
}

/// Terminate a process by PID on Unix via `kill -KILL` (SIGKILL).
///
/// Forceful — matching the Windows `taskkill /F` semantics — so a rogue or
/// unresponsive .NET process is guaranteed to die. A "Kill Process" action gated
/// behind an explicit confirmation must not be silently ignorable, which a
/// catchable SIGTERM would be (many .NET apps trap only SIGINT/Ctrl-C).
#[cfg(not(windows))]
fn native_kill(pid: u32) -> Result<()> {
    let status = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .context("failed to run kill")?;
    if status.success() {
        Ok(())
    } else {
        bail!("kill failed for PID {pid}: {status}");
    }
}

/// Terminate a process tree by PID on Windows via `taskkill /T /F`.
#[cfg(windows)]
fn native_kill(pid: u32) -> Result<()> {
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .context("failed to run taskkill")?;
    if status.success() {
        Ok(())
    } else {
        bail!("taskkill failed for PID {pid}: {status}");
    }
}

/// Enumerate all processes using the platform-native tool.
#[cfg(not(windows))]
fn native_process_list() -> Result<Vec<DotNetProcess>> {
    // `ps -eo pid,comm,command` is available on Linux and macOS.
    // Output format: PID<sp>COMM<sp>COMMAND...
    let output = std::process::Command::new("ps")
        .args(["-eo", "pid,comm,command"])
        .output()
        .context("failed to run ps")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_ps_output(&stdout))
}

/// Enumerate all processes using the platform-native tool.
#[cfg(windows)]
fn native_process_list() -> Result<Vec<DotNetProcess>> {
    // `wmic process get ProcessId,Name,CommandLine /FORMAT:csv` on Windows.
    // Falls back to an empty list on error rather than crashing.
    let output = std::process::Command::new("wmic")
        .args([
            "process",
            "get",
            "ProcessId,Name,CommandLine",
            "/FORMAT:csv",
        ])
        .output()
        .context("failed to run wmic")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_wmic_output(&stdout))
}

/// Parse `ps -eo pid,comm,command` output.
///
/// Header line is skipped (PID is non-numeric). Each subsequent line:
/// `  1234  comm  /full/path/to/command args`
#[cfg(not(windows))]
fn parse_ps_output(output: &str) -> Vec<DotNetProcess> {
    output.lines().filter_map(parse_ps_line).collect()
}

/// Parse one line of `ps -eo pid,comm,command` output into a [`DotNetProcess`].
#[cfg(not(windows))]
fn parse_ps_line(line: &str) -> Option<DotNetProcess> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.splitn(3, char::is_whitespace);
    let pid: u32 = parts.next()?.trim().parse().ok()?;
    let name = parts.next()?.trim().to_string();
    // comm may be truncated by ps; use the basename of command if name looks truncated.
    let command_line = parts.next().unwrap_or("").trim().to_string();
    // Use the full command path's basename as name when comm is truncated (ends with no slash).
    let display_name = if name.len() < 15 {
        name
    } else {
        // comm was truncated — derive from command path
        command_line
            .split_whitespace()
            .next()
            .and_then(|p| p.rsplit(['/', '\\']).next())
            .unwrap_or(&name)
            .to_string()
    };
    Some(DotNetProcess {
        pid,
        name: display_name,
        command_line,
        runtime_version: None,
    })
}

/// Parse `wmic process get … /FORMAT:csv` output into `DotNetProcess` rows.
#[cfg(windows)]
fn parse_wmic_output(output: &str) -> Vec<DotNetProcess> {
    // CSV: Node,CommandLine,Name,ProcessId
    output
        .lines()
        .skip(1) // header
        .filter_map(|line| {
            let cols: Vec<&str> = line.splitn(4, ',').collect();
            let command_line = cols.get(1).unwrap_or(&"").trim().to_string();
            let name = cols.get(2).unwrap_or(&"").trim().to_string();
            let pid: u32 = cols.get(3)?.trim().parse().ok()?;
            if name.is_empty() {
                return None;
            }
            Some(DotNetProcess {
                pid,
                name,
                command_line,
                runtime_version: None,
            })
        })
        .collect()
}

#[cfg(test)]
#[cfg_attr(
    not(windows),
    expect(
        clippy::unwrap_used,
        reason = "test code — panics are the correct failure mode"
    )
)]
#[cfg_attr(
    not(windows),
    expect(
        clippy::indexing_slicing,
        reason = "test code — panics are the correct failure mode"
    )
)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn test_parse_ps_output_typical() {
        let output = "\
  PID COMM             COMMAND\n\
 1234 dotnet           /usr/bin/dotnet run\n\
 5678 MyApp            /home/user/MyApp/bin/MyApp --serve\n";

        let procs = parse_ps_output(output);
        // Header line has non-numeric PID so is skipped.
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].name, "dotnet");
        assert_eq!(procs[1].pid, 5678);
    }

    #[cfg(not(windows))]
    #[test]
    fn test_parse_ps_output_empty() {
        let procs = parse_ps_output("");
        assert!(procs.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn test_parse_ps_line_no_command() {
        let proc = parse_ps_line("  999 Worker  ").unwrap();
        assert_eq!(proc.pid, 999);
        assert_eq!(proc.name, "Worker");
        assert_eq!(proc.command_line, "");
    }

    #[test]
    fn test_list_returns_ok() {
        // Smoke test: list() must not panic or error on the host machine.
        let result = list();
        assert!(result.is_ok(), "list() failed: {:?}", result.err());
    }

    #[cfg(not(windows))]
    #[test]
    fn test_classify_dotnet_muxer_reports_runtime_version() {
        // `dotnet <App>.dll` is the host muxer; the version is read from the
        // managed assembly's directory `*.runtimeconfig.json`.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("App.runtimeconfig.json"),
            r#"{"runtimeOptions":{"tfm":"net10.0","framework":{"name":"Microsoft.NETCore.App","version":"10.0.7"}}}"#,
        )
        .unwrap();
        let command_line = format!(
            "/usr/share/dotnet/dotnet {}",
            dir.path().join("App.dll").display()
        );
        let mut cache = HashMap::new();
        assert_eq!(
            classify(&command_line, "dotnet", &mut cache),
            DotnetMatch::Yes(Some("10.0.7".to_string()))
        );
    }

    #[test]
    fn test_classify_dotnet_muxer_without_assembly_has_no_version() {
        // `dotnet run` carries no managed assembly — still .NET, version unknown.
        let mut cache = HashMap::new();
        assert_eq!(
            classify("/usr/share/dotnet/dotnet run", "dotnet", &mut cache),
            DotnetMatch::Yes(None)
        );
    }

    #[test]
    fn test_first_exe_token_honors_quoted_path() {
        // A leading double-quoted path (Windows-style) wins over whitespace.
        assert_eq!(
            first_exe_token("\"/opt/my dotnet/dotnet\" exec App.dll"),
            Some("/opt/my dotnet/dotnet")
        );
        // An empty quoted token yields nothing.
        assert_eq!(first_exe_token("\"\""), None);
    }

    #[test]
    fn test_framework_version_falls_back_to_frameworks_array() {
        // ASP.NET-style runtimeconfig uses a `frameworks` array, not a single
        // `framework`; the first version wins.
        let options = serde_json::json!({
            "frameworks": [
                { "name": "Microsoft.NETCore.App", "version": "10.0.7" },
                { "name": "Microsoft.AspNetCore.App", "version": "10.0.7" }
            ]
        });
        assert_eq!(framework_version(&options), Some("10.0.7"));
    }

    #[cfg(not(windows))]
    #[test]
    fn test_parse_ps_line_skips_blank() {
        assert!(parse_ps_line("    ").is_none());
    }
}
