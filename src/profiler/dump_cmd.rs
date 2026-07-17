//! Shared utilities for running commands in `dotnet-dump analyze` sessions.

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;

/// Run a command in the dotnet-dump analyze interactive session.
///
/// Spawns `dotnet-dump analyze <dump>`, writes the command + exit to stdin,
/// then collects the full stdout output.
pub async fn run(
    tool: &std::path::Path,
    dump_path: &str,
    command: &str,
) -> Result<std::process::Output> {
    let mut cmd = tokio::process::Command::new(tool);
    crate::utils::hide_console_window_tokio(&mut cmd);
    let mut child = cmd
        .args(["analyze", dump_path])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("spawn dotnet-dump analyze")?;

    let input = format!("{command}\nexit\n");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes()).await;
        drop(stdin);
    }

    child
        .wait_with_output()
        .await
        .context("wait for dotnet-dump analyze")
}

/// Verify the dump file exists before invoking `dotnet-dump analyze`.
pub fn validate_dump_path(path: &str) -> Result<()> {
    if !std::path::Path::new(path).exists() {
        anyhow::bail!("dump file not found: {path}");
    }
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn validate_dump_path_rejects_missing_file() {
        let result = validate_dump_path("/nonexistent/path/to/dump.dmp");
        assert!(result.is_err());
        let msg = format!("{}", result.unwrap_err());
        assert!(msg.contains("dump file not found"));
    }

    #[test]
    fn validate_dump_path_accepts_existing_file() {
        // Cargo.toml always exists in the repo root.
        let result = validate_dump_path("Cargo.toml");
        assert!(result.is_ok());
    }
}
