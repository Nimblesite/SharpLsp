//! Live counter monitoring via `dotnet-counters monitor`.

use anyhow::{Context, Result};
use lsp_server::{Message, Notification};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::session::{self, SessionKind};
use super::tool_discovery;

/// Parameters for starting counter monitoring.
#[derive(Debug, Deserialize)]
pub struct StartCountersParams {
    pub pid: u32,
    #[serde(default = "default_providers")]
    pub providers: Vec<String>,
    #[serde(default = "default_refresh_interval")]
    pub refresh_interval: u32,
}

/// Result of starting counter monitoring.
#[derive(Debug, Serialize)]
pub struct StartCountersResult {
    pub session_id: String,
}

/// A single counter value update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CounterValue {
    pub provider: String,
    pub name: String,
    pub display_name: String,
    pub value: f64,
    pub unit: String,
}

/// Notification payload for counter updates.
#[derive(Debug, Serialize)]
pub struct CounterUpdateParams {
    pub session_id: String,
    pub counters: Vec<CounterValue>,
}

/// Start counter monitoring by spawning `dotnet-counters monitor`.
pub fn start(
    params: &StartCountersParams,
    sender: crossbeam_channel::Sender<Message>,
) -> Result<StartCountersResult> {
    let tool = tool_discovery::require_counters()?;

    let providers_arg = params.providers.join(",");

    info!(
        pid = params.pid,
        providers = %providers_arg,
        interval = params.refresh_interval,
        "Starting dotnet-counters monitor"
    );

    let child = tokio::process::Command::new(tool)
        .args(["monitor", "-p"])
        .arg(params.pid.to_string())
        .args(["--counters", &providers_arg])
        .args(["--refresh-interval", &params.refresh_interval.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("failed to spawn dotnet-counters")?;

    let session_id = session::store().create(SessionKind::Counters, params.pid, None, child)?;

    // Spawn a reader task to parse stdout and send notifications.
    spawn_counter_reader(session_id.clone(), sender);

    Ok(StartCountersResult { session_id })
}

/// Stop counter monitoring.
pub async fn stop(session_id: &str) -> Result<()> {
    let store = session::store();
    let mut child = store.take_child(session_id)?;

    let _ = child.kill().await;
    let _ = child.wait().await;

    store.mark_stopped(session_id, None);
    info!(session_id = %session_id, "Counter monitoring stopped");
    Ok(())
}

/// Spawn a background task to read counter output and send LSP notifications.
fn spawn_counter_reader(session_id: String, sender: crossbeam_channel::Sender<Message>) {
    tokio::spawn(async move {
        // Read counter output from the session's child stdout.
        // The actual parsing happens when we receive lines from dotnet-counters.
        // For now, we parse the simple text output format.
        let store = session::store();
        let stdout = {
            let Some(mut entry) = store.sessions().get_mut(&session_id) else {
                return;
            };
            match entry.child.as_mut() {
                Some(child) => child.stdout.take(),
                None => return,
            }
        };

        let Some(stdout) = stdout else { return };

        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = tokio::io::AsyncBufReadExt::lines(reader);

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(counter) = parse_counter_line(&line) {
                let params = CounterUpdateParams {
                    session_id: session_id.clone(),
                    counters: vec![counter],
                };
                if let Err(err) = send_counter_notification(&sender, params) {
                    warn!("Failed to send counter notification: {err:#}");
                    break;
                }
            }
        }
    });
}

/// Parse a single line of dotnet-counters text output.
///
/// Format varies, but common pattern:
/// ```text
///     GC Heap Size (MB)                                      24
///     Working Set (MB)                                       120
/// ```
fn parse_counter_line(line: &str) -> Option<CounterValue> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('[') || trimmed.starts_with('-') {
        return None;
    }

    // Find the last whitespace-separated token as the value.
    let parts: Vec<&str> = trimmed.rsplitn(2, char::is_whitespace).collect();
    if parts.len() < 2 {
        return None;
    }

    let value_str = parts.first()?.trim();
    let name_part = parts.get(1)?.trim();

    let value: f64 = value_str.replace(',', "").parse().ok()?;

    // Extract unit from parentheses if present: "GC Heap Size (MB)" -> unit = "MB"
    let (display_name, unit) = if let Some(paren_start) = name_part.rfind('(') {
        let unit = name_part
            .get(paren_start..)
            .unwrap_or_default()
            .trim_matches(|c| c == '(' || c == ')' || c == ' ');
        let name = name_part.get(..paren_start).unwrap_or(name_part).trim();
        (name.to_string(), unit.to_string())
    } else {
        (name_part.to_string(), String::new())
    };

    Some(CounterValue {
        provider: "System.Runtime".to_string(),
        name: display_name.clone(),
        display_name,
        value,
        unit,
    })
}

/// Send a `forge/profiler/counterUpdate` notification.
fn send_counter_notification(
    sender: &crossbeam_channel::Sender<Message>,
    params: CounterUpdateParams,
) -> Result<()> {
    let notification = Notification {
        method: "forge/profiler/counterUpdate".to_string(),
        params: serde_json::to_value(params).context("serialize counter update")?,
    };
    sender
        .send(Message::Notification(notification))
        .context("send counter notification")?;
    Ok(())
}

fn default_providers() -> Vec<String> {
    vec!["System.Runtime".to_string()]
}

fn default_refresh_interval() -> u32 {
    1
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_counter_line_with_unit() {
        let line = "    GC Heap Size (MB)                                      24";
        let counter = parse_counter_line(line).unwrap();
        assert_eq!(counter.display_name, "GC Heap Size");
        assert_eq!(counter.unit, "MB");
        assert!((counter.value - 24.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_counter_line_without_unit() {
        let line = "    Gen 2 GC Count                                          5";
        let counter = parse_counter_line(line).unwrap();
        assert_eq!(counter.display_name, "Gen 2 GC Count");
        assert!(counter.unit.is_empty());
        assert!((counter.value - 5.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_counter_line_separator_skipped() {
        assert!(parse_counter_line("---").is_none());
        assert!(parse_counter_line("[System.Runtime]").is_none());
        assert!(parse_counter_line("").is_none());
    }
}
