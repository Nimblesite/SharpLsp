//! Trace collection via `dotnet-trace collect`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::child_process;
use super::diagnostics_port;
use super::session::{self, SessionKind};
use super::tool_discovery;

/// How long `stop` waits for `dotnet-trace collect` to exit gracefully before
/// hard-killing it. Bounded so `stopTrace` can never hang the LSP request
/// loop — and kept comfortably below the 10s no-hang budget the profiler
/// edge-case e2e tests assert.
const GRACEFUL_STOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

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

    // Reject non-.NET targets before spawning anything: `dotnet-trace collect`
    // fails fast on Unix but hangs forever on Windows, which would leak the
    // collector child AND register a zombie session. The endpoint check is
    // deterministic; when it cannot be evaluated (None) we fail open and rely
    // on `early_attach_failure` below. [GitHub #110]
    if diagnostics_port::has_endpoint(params.pid) == Some(false) {
        anyhow::bail!(
            "failed to attach dotnet-trace to PID {}: target is not a .NET process \
             (no .NET diagnostics endpoint)",
            params.pid
        );
    }

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

    // stdin MUST be piped: writing Enter to it is dotnet-trace's documented
    // graceful-stop trigger, and the only stop channel that finalizes the
    // trace on Windows (see `stop`).
    let _ = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().context("failed to spawn dotnet-trace")?;

    // dotnet-trace collect on macOS reports many non-.NET processes via `ps`,
    // and attaching to them fails fast with `ServerNotAvailableException`.
    // Poll briefly — if the child already exited, it couldn't attach.
    // Surface the real stderr so the UI shows a useful message instead of
    // silently registering a zombie session that only fails on Stop.
    if let Some(err) = early_attach_failure(&mut child) {
        anyhow::bail!("failed to attach dotnet-trace to PID {}: {err}", params.pid);
    }

    // Attach succeeded — hand stdout/stderr to background drain threads so a
    // long-running collection can never stall once the OS pipe buffer fills.
    child_process::drain_output(&mut child);

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

/// Poll a freshly-spawned `dotnet-trace collect` child for up to ~500ms. If it
/// has already exited, capture its stderr and return a human-readable reason.
/// Returns `None` if the child is still running (attach succeeded).
fn early_attach_failure(child: &mut std::process::Child) -> Option<String> {
    use std::io::Read;

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let mut stderr = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut stderr);
                }
                let trimmed = stderr.trim();
                let reason = if trimmed.is_empty() {
                    "process exited immediately — target is not a .NET process \
                     or is no longer running"
                        .to_string()
                } else {
                    summarize_dotnet_trace_error(trimmed)
                };
                return Some(reason);
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

/// Pull the first useful line out of `dotnet-trace` stderr. The raw output is
/// a multi-screen .NET stack trace; users only need the primary cause.
fn summarize_dotnet_trace_error(stderr: &str) -> String {
    if stderr.contains("ServerNotAvailableException") || stderr.contains("Connection refused") {
        return "target is not a .NET process (or its diagnostic IPC is not reachable)".to_string();
    }
    stderr
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(stderr)
        .trim()
        .to_string()
}

/// Stop a running trace session.
pub fn stop(session_id: &str) -> Result<StopTraceResult> {
    let store = session::store();
    let mut child = store.take_child(session_id)?;
    let started_at = store
        .sessions()
        .get(session_id)
        .map_or_else(std::time::Instant::now, |s| s.started_at);

    // Ask dotnet-trace to stop gracefully — Enter on stdin (its documented
    // stop trigger on every platform; SIGINT additionally on Unix) — and wait
    // for it to flush the rundown and exit. Hard-killing is a last resort:
    // on Windows `Child::kill()` is `TerminateProcess`, which truncates the
    // .nettrace mid-write and corrupts it. [GitHub #110]
    child_process::stop_gracefully(&mut child, GRACEFUL_STOP_TIMEOUT);

    let duration_ms = started_at.elapsed().as_millis();

    // Get output path from session.
    let output_path = store
        .sessions()
        .get(session_id)
        .and_then(|s| s.output_path.clone())
        .unwrap_or_default();

    let file_size_bytes = std::fs::metadata(&output_path).map_or(0, |m| m.len());

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

/// Parameters for converting a `.nettrace` file to another format.
#[derive(Debug, Deserialize)]
pub struct ConvertTraceParams {
    /// Path to the `.nettrace` input file.
    pub input_path: String,
    /// Target format: `speedscope` (default) or `chromium`.
    #[serde(default = "default_format")]
    pub format: String,
}

/// Result of converting a trace file.
#[derive(Debug, Serialize)]
pub struct ConvertTraceResult {
    /// Path to the converted output file (derived from input + format).
    pub output_path: String,
    /// Size of the converted file in bytes.
    pub file_size_bytes: u64,
}

/// Public entry point for `sharplsp/profiler/convertTrace`.
///
/// Runs `dotnet-trace convert` and returns the path to the sibling output file
/// that the tool produces. Unlike the private helper used by `stop`, this takes
/// an arbitrary file — useful for previously captured traces that were never
/// converted (e.g. orphaned from a crashed editor session).
pub fn convert(params: &ConvertTraceParams) -> Result<ConvertTraceResult> {
    convert_trace_with_format(&params.input_path, &params.format)?;

    let output_path = derived_output_path(&params.input_path, &params.format);
    let file_size_bytes = std::fs::metadata(&output_path)
        .with_context(|| format!("stat converted file {output_path}"))?
        .len();

    Ok(ConvertTraceResult {
        output_path,
        file_size_bytes,
    })
}

/// Convert `.nettrace` to `SpeedScope` JSON format (internal default path).
fn convert_trace(nettrace_path: &str) -> Result<()> {
    convert_trace_with_format(nettrace_path, "speedscope")
}

/// Convert `.nettrace` to the requested format.
fn convert_trace_with_format(nettrace_path: &str, format: &str) -> Result<()> {
    let tool = tool_discovery::require_trace()?;

    info!(path = %nettrace_path, format = %format, "Converting trace");

    let output = std::process::Command::new(tool)
        .args(["convert", nettrace_path, "--format", format])
        .output()
        .context("failed to run dotnet-trace convert")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("dotnet-trace convert failed: {stderr}");
    }

    Ok(())
}

/// Derive the output path that `dotnet-trace convert` writes for a given input.
///
/// `dotnet-trace convert` replaces a trailing `.nettrace` with the format
/// suffix rather than appending — so `trace-42.nettrace` becomes
/// `trace-42.speedscope.json`, not `trace-42.nettrace.speedscope.json`.
fn derived_output_path(input_path: &str, format: &str) -> String {
    let suffix = match format {
        "chromium" => ".chromium.json",
        _ => ".speedscope.json",
    };
    let stem = input_path.strip_suffix(".nettrace").unwrap_or(input_path);
    format!("{stem}{suffix}")
}

/// Default directory for trace output files.
fn output_dir() -> &'static str {
    ".sharplsp/profiles"
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
// dotnet-sampled-thread-time works on all platforms and produces call-stack frames
// visible in speedscope. cpu-sampling is Linux-only and fails on macOS.
fn default_profile() -> String {
    "dotnet-sampled-thread-time".to_string()
}

/// Default output format.
fn default_format() -> String {
    "speedscope".to_string()
}

/// Default trace duration in seconds.
fn default_duration() -> u32 {
    30
}

#[cfg(test)]
mod default_profile_tests {
    use super::default_profile;

    #[test]
    fn default_profile_is_valid_on_macos() {
        // cpu-sampling is Linux-only; dotnet-sampled-thread-time works everywhere.
        let profile = default_profile();
        assert_ne!(
            profile, "cpu-sampling",
            "cpu-sampling is Linux-only and fails on macOS with 'does not apply to dotnet-trace collect'"
        );
        assert_eq!(profile, "dotnet-sampled-thread-time");
    }
}

#[cfg(test)]
mod derived_output_path_tests {
    use super::derived_output_path;

    #[test]
    fn strips_nettrace_extension_for_speedscope() {
        assert_eq!(
            derived_output_path(".sharplsp/profiles/trace-21288.nettrace", "speedscope"),
            ".sharplsp/profiles/trace-21288.speedscope.json"
        );
    }

    #[test]
    fn strips_nettrace_extension_for_chromium() {
        assert_eq!(
            derived_output_path("/tmp/x.nettrace", "chromium"),
            "/tmp/x.chromium.json"
        );
    }

    #[test]
    fn handles_missing_nettrace_extension() {
        assert_eq!(
            derived_output_path("/tmp/weird-name", "speedscope"),
            "/tmp/weird-name.speedscope.json"
        );
    }
}
