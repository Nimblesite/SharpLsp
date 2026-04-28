//! Memory dump collection via `dotnet-dump collect`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use lsp_server::{Message, Notification};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::tool_discovery;

/// Parameters for collecting a memory dump.
#[derive(Debug, Deserialize)]
pub struct CollectDumpParams {
    /// Target process ID.
    pub pid: u32,
    /// Dump type (e.g. `Heap`, `Full`, `Mini`).
    #[serde(default = "default_dump_type")]
    pub dump_type: String,
    /// Optional file path for the resulting dump.
    pub output_path: Option<String>,
}

/// Result of dump collection.
#[derive(Debug, Serialize)]
pub struct CollectDumpResult {
    /// Path where the dump was written.
    pub output_path: String,
    /// Size of the dump file in bytes.
    pub file_size_bytes: u64,
}

/// Collect a memory dump from a running .NET process.
///
/// Sends `$/progress` begin/end notifications via `sender` so the editor can
/// show a progress indicator while waiting for the (potentially large) dump.
pub async fn collect(
    params: CollectDumpParams,
    sender: crossbeam_channel::Sender<Message>,
) -> Result<CollectDumpResult> {
    let tool = tool_discovery::require_dump()?;

    let output_path = params
        .output_path
        .unwrap_or_else(|| format!(".sharplsp/profiles/dump-{}.dmp", params.pid));

    ensure_output_dir(&output_path)?;

    info!(
        pid = params.pid,
        dump_type = %params.dump_type,
        output = %output_path,
        "Collecting memory dump"
    );

    let token = format!("dump-{}", params.pid);
    send_progress_begin(&sender, &token, "Collecting memory dump…");

    let output = tokio::process::Command::new(tool)
        .args(["collect", "-p"])
        .arg(params.pid.to_string())
        .args(["--type", &params.dump_type])
        .args(["-o", &output_path])
        .output()
        .await
        .context("failed to run dotnet-dump collect")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        send_progress_end(&sender, &token);
        anyhow::bail!("dotnet-dump collect failed: {stderr}");
    }

    let file_size_bytes = std::fs::metadata(&output_path).map_or(0, |m| m.len());

    send_progress_end(&sender, &token);

    info!(
        output = %output_path,
        size_bytes = file_size_bytes,
        "Memory dump collected"
    );

    Ok(CollectDumpResult {
        output_path,
        file_size_bytes,
    })
}

/// Create parent directories for the output path if they don't exist.
fn ensure_output_dir(path: &str) -> Result<()> {
    if let Some(parent) = PathBuf::from(path).parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create output dir: {}", parent.display()))?;
    }
    Ok(())
}

/// Default dump type used when none is specified.
fn default_dump_type() -> String {
    "Heap".to_string()
}

/// Send a `$/progress` begin notification.
fn send_progress_begin(sender: &crossbeam_channel::Sender<Message>, token: &str, message: &str) {
    let params = serde_json::json!({
        "token": token,
        "value": {
            "kind": "begin",
            "title": message,
            "cancellable": false
        }
    });
    send_notification(sender, "$/progress", params);
}

/// Send a `$/progress` end notification.
fn send_progress_end(sender: &crossbeam_channel::Sender<Message>, token: &str) {
    let params = serde_json::json!({
        "token": token,
        "value": { "kind": "end" }
    });
    send_notification(sender, "$/progress", params);
}

/// Send an LSP notification over the given channel.
fn send_notification(
    sender: &crossbeam_channel::Sender<Message>,
    method: &str,
    params: serde_json::Value,
) {
    let notification = Notification {
        method: method.to_string(),
        params,
    };
    if let Err(err) = sender.send(Message::Notification(notification)) {
        warn!("Failed to send notification {method}: {err:#}");
    }
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
    use crossbeam_channel::unbounded;

    #[test]
    fn default_dump_type_returns_heap() {
        assert_eq!(default_dump_type(), "Heap");
    }

    #[test]
    fn ensure_output_dir_creates_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("a").join("b").join("dump.dmp");
        let nested_str = nested.to_str().unwrap();

        ensure_output_dir(nested_str).unwrap();

        assert!(nested.parent().unwrap().is_dir());
    }

    #[test]
    fn send_progress_begin_sends_correct_notification() {
        let (tx, rx) = unbounded::<Message>();
        send_progress_begin(&tx, "tok-1", "Working…");

        let msg = rx.try_recv().unwrap();
        let Message::Notification(notif) = msg else {
            panic!("expected Notification");
        };
        assert_eq!(notif.method, "$/progress");

        let value = &notif.params["value"];
        assert_eq!(value["kind"], "begin");
        assert_eq!(value["title"], "Working…");
        assert_eq!(value["cancellable"], false);
        assert_eq!(notif.params["token"], "tok-1");
    }

    #[test]
    fn send_progress_end_sends_correct_notification() {
        let (tx, rx) = unbounded::<Message>();
        send_progress_end(&tx, "tok-2");

        let msg = rx.try_recv().unwrap();
        let Message::Notification(notif) = msg else {
            panic!("expected Notification");
        };
        assert_eq!(notif.method, "$/progress");
        assert_eq!(notif.params["value"]["kind"], "end");
        assert_eq!(notif.params["token"], "tok-2");
    }

    #[test]
    fn send_notification_handles_send_correctly() {
        let (tx, rx) = unbounded::<Message>();
        let params = serde_json::json!({"key": "value"});
        send_notification(&tx, "custom/method", params.clone());

        let msg = rx.try_recv().unwrap();
        let Message::Notification(notif) = msg else {
            panic!("expected Notification");
        };
        assert_eq!(notif.method, "custom/method");
        assert_eq!(notif.params, params);
    }

    #[test]
    fn send_notification_does_not_panic_on_closed_channel() {
        let (tx, rx) = unbounded::<Message>();
        drop(rx);
        // Should not panic — just logs a warning
        send_notification(&tx, "$/progress", serde_json::json!({"token": "t"}));
    }
}
