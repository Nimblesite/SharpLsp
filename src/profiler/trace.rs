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
    /// Target process ID.
    pub pid: u32,
    /// Trace profile (e.g. `gc-collect`, `cpu-sampling`).
    #[serde(default = "default_profile")]
    pub profile: String,
    /// Output format (e.g. `speedscope`, `nettrace`).
    #[serde(default = "default_format")]
    pub format: String,
    /// Trace duration in seconds (0 = unlimited).
    #[serde(default = "default_duration")]
    pub duration: u32,
    /// Optional file path for the trace output.
    pub output_path: Option<String>,
}

/// Result of starting a trace.
#[derive(Debug, Serialize)]
pub struct StartTraceResult {
    /// Unique identifier for this trace session.
    pub session_id: String,
    /// Path where trace data will be written.
    pub output_path: String,
}

/// Result of stopping a trace.
#[derive(Debug, Serialize)]
pub struct StopTraceResult {
    /// Path to the collected trace file.
    pub output_path: String,
    /// Size of the trace file in bytes.
    pub file_size_bytes: u64,
    /// Duration of the trace in milliseconds.
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
    let _ = cmd
        .args(["collect", "-p"])
        .arg(params.pid.to_string())
        .args(["--profile", &params.profile])
        .args(["-o", &output_path]);

    if params.duration > 0 {
        let _ = cmd.args(["--duration", &format!("00:00:{:02}", params.duration)]);
    }

    let _ = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child = cmd.spawn().context("failed to spawn dotnet-trace")?;

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
pub fn stop(session_id: &str) -> Result<StopTraceResult> {
    let store = session::store();
    let mut child = store.take_child(session_id)?;
    let started_at = store
        .sessions()
        .get(session_id)
        .map_or_else(std::time::Instant::now, |s| s.started_at);

    // Send SIGINT on Unix, SIGKILL on Windows.
    // dotnet-trace handles SIGINT gracefully, flushing the trace file.
    #[cfg(unix)]
    {
        let pid = child.id();
        if let Ok(pid_i32) = i32::try_from(pid) {
            let _ = std::process::Command::new("kill")
                .args(["-INT", &pid_i32.to_string()])
                .status();
        }
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }

    let _ = child.wait();
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

    if file_size_bytes == 0 {
        warn!(
            session_id = %session_id,
            output = %output_path,
            "Trace file is empty or missing — no data was captured"
        );
        anyhow::bail!(
            "trace captured no data (0 bytes). \
             The target process may have exited before collection started."
        );
    }

    // Convert to speedscope format only when we have actual data.
    if let Err(err) = convert_trace(&output_path) {
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
fn convert_trace(nettrace_path: &str) -> Result<()> {
    let tool = tool_discovery::require_trace()?;

    info!(path = %nettrace_path, "Converting trace to speedscope format");

    let output = std::process::Command::new(tool)
        .args(["convert", nettrace_path, "--format", "speedscope"])
        .output()
        .context("failed to run dotnet-trace convert")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("dotnet-trace convert failed: {stderr}");
    }

    Ok(())
}

/// Default directory for trace output files.
fn output_dir() -> &'static str {
    ".forge/profiles"
}

/// Create parent directories for the output path if they don't exist.
fn ensure_output_dir(path: &str) -> Result<()> {
    if let Some(parent) = PathBuf::from(path).parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create output dir: {}", parent.display()))?;
    }
    Ok(())
}

/// Default trace profile.
fn default_profile() -> String {
    "gc-collect".to_string()
}

/// Default output format.
fn default_format() -> String {
    "speedscope".to_string()
}

/// Default trace duration in seconds.
fn default_duration() -> u32 {
    30
}
