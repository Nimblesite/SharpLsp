//! List running processes using native OS APIs.
//!
//! Uses platform-native process enumeration (`ps` on Unix, `wmic` on Windows)
//! rather than `dotnet-trace ps` to avoid the ~350ms .NET runtime startup overhead.

use anyhow::{Context, Result};
use serde::Serialize;
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
}

/// List all running processes using the native OS process table.
///
/// Returns all processes rather than filtering for .NET-only, because
/// self-contained .NET executables are indistinguishable from native binaries
/// by name/command alone. The profiler UI can filter further if needed.
pub fn list() -> Result<Vec<DotNetProcess>> {
    info!("Listing processes via native OS process table");
    let processes = native_process_list()?;
    debug!("Found {} process(es)", processes.len());
    Ok(processes)
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
    })
}

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
            })
        })
        .collect()
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#[expect(
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
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

    #[test]
    fn test_parse_ps_output_empty() {
        let procs = parse_ps_output("");
        assert!(procs.is_empty());
    }

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
}
