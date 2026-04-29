//! Live counter monitoring via `dotnet-counters monitor`.

use std::io::BufRead;
use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use lsp_server::{Message, Notification};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::session::{self, SessionKind};
use super::tool_discovery;

/// Parameters for starting counter monitoring.
#[derive(Debug, Deserialize)]
pub struct StartCountersParams {
    /// Target process ID.
    pub pid: u32,
    /// Event provider names to subscribe to.
    #[serde(default = "default_providers")]
    pub providers: Vec<String>,
    /// Refresh interval in seconds.
    #[serde(default = "default_refresh_interval")]
    pub refresh_interval: u32,
}

/// Result of starting counter monitoring.
#[derive(Debug, Serialize)]
pub struct StartCountersResult {
    /// Unique identifier for this monitoring session.
    pub session_id: String,
}

/// A single counter value update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CounterValue {
    /// Counter provider name (e.g. `System.Runtime`).
    pub provider: String,
    /// Raw counter name.
    pub name: String,
    /// Human-readable counter name.
    pub display_name: String,
    /// Current counter value.
    pub value: f64,
    /// Unit of measurement (e.g. `MB`, `%`).
    pub unit: String,
}

/// Notification payload for counter updates.
#[derive(Debug, Serialize)]
pub struct CounterUpdateParams {
    /// Session that produced these updates.
    pub session_id: String,
    /// Counter values in this update batch.
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

    let child = Command::new(tool)
        .args(["monitor", "-p"])
        .arg(params.pid.to_string())
        .args(["--counters", &providers_arg])
        .args(["--refresh-interval", &params.refresh_interval.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to spawn dotnet-counters")?;

    let session_id = session::store().create(SessionKind::Counters, params.pid, None, child)?;

    spawn_counter_reader(session_id.clone(), sender);

    Ok(StartCountersResult { session_id })
}

/// Stop counter monitoring.
pub fn stop(session_id: &str) -> Result<()> {
    let store = session::store();
    let mut child = store.take_child(session_id)?;

    let _ = child.kill();
    let _ = child.wait();

    store.mark_stopped(session_id, None);
    info!(session_id = %session_id, "Counter monitoring stopped");
    Ok(())
}

/// Spawn a background thread to read counter output and send notifications.
fn spawn_counter_reader(session_id: String, sender: crossbeam_channel::Sender<Message>) {
    let _handle = std::thread::spawn(move || {
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
        let reader = std::io::BufReader::new(stdout);

        for line in reader.lines() {
            let Ok(line) = line else { break };
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

    let parts: Vec<&str> = trimmed.rsplitn(2, char::is_whitespace).collect();
    if parts.len() < 2 {
        return None;
    }

    let value_str = parts.first()?.trim();
    let name_part = parts.get(1)?.trim();

    let value: f64 = value_str.replace(',', "").parse().ok()?;

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

/// Send a `sharplsp/profiler/counterUpdate` notification.
fn send_counter_notification(
    sender: &crossbeam_channel::Sender<Message>,
    params: CounterUpdateParams,
) -> Result<()> {
    let notification = Notification {
        method: "sharplsp/profiler/counterUpdate".to_string(),
        params: serde_json::to_value(params).context("serialize counter update")?,
    };
    sender
        .send(Message::Notification(notification))
        .context("send counter notification")?;
    Ok(())
}

/// Default event providers for counter monitoring.
fn default_providers() -> Vec<String> {
    vec!["System.Runtime".to_string()]
}

/// Default refresh interval in seconds.
fn default_refresh_interval() -> u32 {
    1
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
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

    #[test]
    fn test_parse_counter_line_with_comma_in_value() {
        let line = "    Allocation Rate (B / 1 sec)                            1,234,567";
        let counter = parse_counter_line(line).unwrap();
        assert!((counter.value - 1_234_567.0).abs() < f64::EPSILON);
        assert_eq!(counter.display_name, "Allocation Rate");
        assert_eq!(counter.unit, "B / 1 sec");
    }

    #[test]
    fn test_parse_counter_line_decimal_value() {
        let line = "    CPU Usage (%)                                          12.5";
        let counter = parse_counter_line(line).unwrap();
        assert!((counter.value - 12.5).abs() < f64::EPSILON);
        assert_eq!(counter.unit, "%");
    }

    #[test]
    fn test_parse_counter_line_single_word_no_value() {
        assert!(parse_counter_line("    NoValue").is_none());
    }

    #[test]
    fn test_parse_counter_line_non_numeric_value() {
        assert!(parse_counter_line("    Something      N/A").is_none());
    }

    #[test]
    fn test_parse_counter_line_provider_always_system_runtime() {
        let line = "    Thread Count                                           8";
        let counter = parse_counter_line(line).unwrap();
        assert_eq!(counter.provider, "System.Runtime");
        assert_eq!(counter.name, counter.display_name);
    }

    #[test]
    fn test_default_providers() {
        let providers = default_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0], "System.Runtime");
    }

    #[test]
    fn test_default_refresh_interval() {
        assert_eq!(default_refresh_interval(), 1);
    }

    #[test]
    fn test_send_counter_notification_serializes_correctly() {
        let (sender, receiver) = crossbeam_channel::unbounded();
        let params = CounterUpdateParams {
            session_id: "test-session".to_string(),
            counters: vec![CounterValue {
                provider: "System.Runtime".to_string(),
                name: "CPU".to_string(),
                display_name: "CPU".to_string(),
                value: 42.0,
                unit: "%".to_string(),
            }],
        };
        send_counter_notification(&sender, params).unwrap();

        let msg = receiver.recv().unwrap();
        match msg {
            Message::Notification(n) => {
                assert_eq!(n.method, "sharplsp/profiler/counterUpdate");
                let session_id = n.params.get("session_id").unwrap().as_str().unwrap();
                assert_eq!(session_id, "test-session");
            }
            _ => panic!("expected notification"),
        }
    }
}
