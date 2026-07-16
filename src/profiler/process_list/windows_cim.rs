//! Windows process enumeration via PowerShell CIM (`Get-CimInstance`).
//!
//! WMIC is deprecated, ships only as a Feature-on-Demand, and is disabled by
//! default on Windows 11 24H2+ and Server 2025 — spawning it fails outright
//! on a stock install. `Get-CimInstance Win32_Process` through Windows
//! PowerShell (always present) is the supported replacement. Output is
//! `ConvertTo-Json`, parsed with `serde_json` — a real parser, so command
//! lines containing commas (which the old wmic CSV splitting silently
//! corrupted) survive intact.

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use super::DotNetProcess;

/// PowerShell pipeline emitting every process as compact JSON.
const CIM_QUERY: &str = "Get-CimInstance Win32_Process | \
     Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";

/// One `Win32_Process` row as serialized by `ConvertTo-Json`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CimProcess {
    /// Process ID.
    process_id: u32,
    /// Executable image name (e.g. `dotnet.exe`).
    name: String,
    /// Full command line — `null` for protected/system processes.
    command_line: Option<String>,
}

/// `ConvertTo-Json` emits a bare object — not a one-element array — when the
/// pipeline yields exactly one row. Accept both shapes.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CimRows {
    /// Zero or several processes (the common case).
    Many(Vec<CimProcess>),
    /// Exactly one process.
    One(CimProcess),
}

impl From<CimProcess> for DotNetProcess {
    fn from(row: CimProcess) -> Self {
        Self {
            pid: row.process_id,
            name: row.name,
            command_line: row.command_line.unwrap_or_default(),
            runtime_version: None,
        }
    }
}

/// Enumerate all Windows processes via `Get-CimInstance Win32_Process`.
pub(super) fn process_list() -> Result<Vec<DotNetProcess>> {
    let mut cmd = std::process::Command::new("powershell");
    crate::utils::hide_console_window(&mut cmd);
    let output = cmd
        .args(["-NoProfile", "-NonInteractive", "-Command", CIM_QUERY])
        .output()
        .context("failed to run powershell Get-CimInstance")?;
    if !output.status.success() {
        bail!(
            "powershell Get-CimInstance exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    parse_json(&String::from_utf8_lossy(&output.stdout))
}

/// Parse `ConvertTo-Json` output into process rows.
fn parse_json(json: &str) -> Result<Vec<DotNetProcess>> {
    let rows: CimRows =
        serde_json::from_str(json.trim()).context("failed to parse Get-CimInstance JSON")?;
    let rows = match rows {
        CimRows::Many(rows) => rows,
        CimRows::One(row) => vec![row],
    };
    Ok(rows.into_iter().map(DotNetProcess::from).collect())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_array_of_processes() {
        let json = r#"[
            {"ProcessId":100,"Name":"dotnet.exe","CommandLine":"dotnet run"},
            {"ProcessId":200,"Name":"System","CommandLine":null}
        ]"#;
        let procs = parse_json(json).unwrap();
        assert_eq!(procs.len(), 2);
        let first = procs.first().unwrap();
        assert_eq!(first.pid, 100);
        assert_eq!(first.name, "dotnet.exe");
        assert_eq!(first.command_line, "dotnet run");
        // Null CommandLine (protected/system process) maps to empty string.
        assert_eq!(procs.get(1).unwrap().command_line, "");
    }

    #[test]
    fn parse_json_single_process_object() {
        // ConvertTo-Json emits a bare object when exactly one row matches.
        let json =
            r#"{"ProcessId":300,"Name":"MyApp.exe","CommandLine":"C:\\apps\\MyApp.exe --serve"}"#;
        let procs = parse_json(json).unwrap();
        assert_eq!(procs.len(), 1);
        let only = procs.first().unwrap();
        assert_eq!(only.pid, 300);
        assert_eq!(only.command_line, r"C:\apps\MyApp.exe --serve");
    }

    #[test]
    fn parse_json_preserves_commas_in_command_line() {
        // Regression: the old wmic CSV path split on ',' and silently
        // corrupted any process whose command line contained a comma.
        let json =
            r#"[{"ProcessId":400,"Name":"dotnet.exe","CommandLine":"dotnet App.dll --tag a,b,c"}]"#;
        let procs = parse_json(json).unwrap();
        assert_eq!(
            procs.first().unwrap().command_line,
            "dotnet App.dll --tag a,b,c"
        );
    }

    #[test]
    fn parse_json_garbage_is_error() {
        assert!(parse_json("wmic is deprecated").is_err());
        assert!(parse_json("").is_err());
    }
}
