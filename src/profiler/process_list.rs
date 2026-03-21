//! Parse `dotnet-trace ps` output into structured process info.

use anyhow::{Context, Result};
use serde::Serialize;
use tracing::{debug, info};

use super::tool_discovery;

/// A discovered .NET process.
#[derive(Debug, Serialize)]
pub struct DotNetProcess {
    pub pid: u32,
    pub name: String,
    pub command_line: String,
}

/// List all running .NET processes by invoking `dotnet-trace ps`.
pub fn list() -> Result<Vec<DotNetProcess>> {
    let tool = tool_discovery::require_trace()?;
    info!("Listing .NET processes via dotnet-trace ps");

    let output = std::process::Command::new(tool)
        .arg("ps")
        .output()
        .context("failed to run dotnet-trace ps")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("dotnet-trace ps failed: {stderr}");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let processes = parse_ps_output(&stdout);
    debug!("Found {} .NET process(es)", processes.len());
    Ok(processes)
}

/// Parse the tabular output of `dotnet-trace ps`.
///
/// Expected format (one process per line after header):
/// ```text
///      12345 ProcessName  /path/to/executable args
/// ```
fn parse_ps_output(output: &str) -> Vec<DotNetProcess> {
    output.lines().filter_map(parse_ps_line).collect()
}

/// Parse a single line from `dotnet-trace ps` output.
fn parse_ps_line(line: &str) -> Option<DotNetProcess> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parts = trimmed.splitn(3, char::is_whitespace);
    let pid_str = parts.next()?.trim();
    let pid: u32 = pid_str.parse().ok()?;
    let name = parts.next()?.trim().to_string();
    let command_line = parts.next().map(str::trim).unwrap_or_default().to_string();

    Some(DotNetProcess {
        pid,
        name,
        command_line,
    })
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ps_output_typical() {
        let output = "\
         1234 dotnet   /usr/bin/dotnet run\n\
         5678 MyApp    /home/user/MyApp/bin/MyApp --serve\n";

        let procs = parse_ps_output(output);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 1234);
        assert_eq!(procs[0].name, "dotnet");
        assert_eq!(procs[0].command_line, "/usr/bin/dotnet run");
        assert_eq!(procs[1].pid, 5678);
        assert_eq!(procs[1].name, "MyApp");
    }

    #[test]
    fn test_parse_ps_output_empty() {
        let procs = parse_ps_output("");
        assert!(procs.is_empty());
    }

    #[test]
    fn test_parse_ps_output_header_line_skipped() {
        let output = "No available process to trace was found.";
        let procs = parse_ps_output(output);
        assert!(procs.is_empty());
    }

    #[test]
    fn test_parse_ps_line_no_command() {
        let proc = parse_ps_line("  999 Worker").unwrap();
        assert_eq!(proc.pid, 999);
        assert_eq!(proc.name, "Worker");
        assert_eq!(proc.command_line, "");
    }
}
