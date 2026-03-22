//! Trace collection via `dotnet-trace collect`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::session::{self, SessionKind};
use super::tool_discovery;

/// Parameters for starting a trace session.
#[derive(Debug, Deserialize)]
pub struct StartTraceParams {
    pub pid: u32,
    #[serde(default = "default_profile")]
    pub profile: String,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default = "default_duration")]
    pub duration: u32,
    pub output_path: Option<String>,
}

/// Result of starting a trace.
#[derive(Debug, Serialize)]
pub struct StartTraceResult {
    pub session_id: String,
    pub output_path: String,
}

/// Result of stopping a trace.
#[derive(Debug, Serialize)]
pub struct StopTraceResult {
    pub output_path: String,
    pub file_size_bytes: u64,
    pub duration_ms: u64,
}

/// Start a trace session by spawning `dotnet-trace collect`.
pub fn start(params: StartTraceParams) -> Result<StartTraceResult> {
    let tool = tool_discovery::require_trace()?;

    let output_path = params.output_path.unwrap_or_else(|| {
        let dir = output_dir();
        format!("{}/trace-{}.nettrace", dir, params.pid)
    });

    ensure_output_dir(&output_path)?;

    info!(
        pid = params.pid,
        profile = %params.profile,
        format = %params.format,
        duration = params.duration,
        output = %output_path,
        "Starting dotnet-trace collect"
    );

    let mut cmd = std::process::Command::new(tool);
    cmd.args(["collect", "-p"])
        .arg(params.pid.to_string())
        .args(["--profile", &params.profile])
        .args(["-o", &output_path]);

    if params.duration > 0 {
        cmd.args(["--duration", &format!("00:00:{:02}", params.duration)]);
    }

    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let std_child = cmd.spawn().context("failed to spawn dotnet-trace")?;
    let child = tokio::process::Child::from(std_child);

    let session_id = session::store().create(
        SessionKind::Trace,
        params.pid,
        Some(output_path.clone()),
        child,
    )?;

    Ok(StartTraceResult {
        session_id,
        output_path,
    })
}

/// Stop a running trace session.
pub async fn stop(session_id: &str) -> Result<StopTraceResult> {
    let store = session::store();
    let mut child = store.take_child(session_id)?;
    let started_at = store
        .sessions()
        .get(session_id)
        .map_or_else(std::time::Instant::now, |s| s.started_at);

    // Send SIGINT on Unix via the `kill` command, SIGKILL on Windows.
    // dotnet-trace handles SIGINT gracefully, flushing the trace file.
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let _ = tokio::process::Command::new("kill")
            .args(["-INT", &pid.to_string()])
            .status()
            .await;
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill().await;
    }

    let _ = child.wait().await;
    let duration_ms = started_at.elapsed().as_millis();

    // Get output path from session.
    let output_path = store
        .sessions()
        .get(session_id)
        .and_then(|s| s.output_path.clone())
        .unwrap_or_default();

    let file_size_bytes = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    store.mark_stopped(session_id, None);

    // Convert to speedscope format if requested.
    if let Err(err) = convert_trace(&output_path).await {
        warn!("Trace conversion failed: {err:#}");
    }

    let duration_ms_u64 = u64::try_from(duration_ms).unwrap_or(u64::MAX);

    info!(
        session_id = %session_id,
        output = %output_path,
        size_bytes = file_size_bytes,
        duration_ms = duration_ms_u64,
        "Trace collection stopped"
    );

    Ok(StopTraceResult {
        output_path,
        file_size_bytes,
        duration_ms: duration_ms_u64,
    })
}

/// Convert `.nettrace` to `SpeedScope` JSON format.
async fn convert_trace(nettrace_path: &str) -> Result<()> {
    let tool = tool_discovery::require_trace()?;

    info!(path = %nettrace_path, "Converting trace to speedscope format");

    let output = tokio::process::Command::new(tool)
        .args(["convert", nettrace_path, "--format", "speedscope"])
        .output()
        .await
        .context("failed to run dotnet-trace convert")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("dotnet-trace convert failed: {stderr}");
    }

    Ok(())
}

fn output_dir() -> &'static str {
    ".forge/profiles"
}

fn ensure_output_dir(path: &str) -> Result<()> {
    if let Some(parent) = PathBuf::from(path).parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create output dir: {}", parent.display()))?;
    }
    Ok(())
}

fn default_profile() -> String {
    "cpu-sampling".to_string()
}

fn default_format() -> String {
    "speedscope".to_string()
}

fn default_duration() -> u32 {
    30
}
