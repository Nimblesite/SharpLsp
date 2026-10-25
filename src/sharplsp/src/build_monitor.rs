//! Observe completed build outputs with lspkit's native watcher. [TEST-REACTIVITY-BUILD]
use std::path::PathBuf;
use std::time::Duration;

use crossbeam_channel::Sender;
use lsp_server::{Message, Notification};
use lspkit_live::{ChangeEvent, FileWatcher};
use serde::Deserialize;
use tokio::runtime::Runtime;
use tokio::task::JoinHandle;
use tokio::time::{sleep_until, Instant};
use tracing::{info, warn};

use crate::paths;

/// Output writers can arrive in bursts; wait for them to settle before listing assemblies.
const QUIET: Duration = Duration::from_millis(500);

/// The client's current discovery targets, including solutions outside workspace folders.
#[derive(Deserialize)]
pub struct WatchTargets {
    /// Native solution, project or workspace-folder paths.
    pub targets: Vec<String>,
}

/// Watcher tasks belong to the server session and release their sender clones on shutdown.
#[derive(Default)]
pub struct BuildMonitor(Vec<JoinHandle<()>>);

impl BuildMonitor {
    /// Replace subscriptions when the selected solution or workspace changes.
    pub fn replace(&mut self, targets: &[String], runtime: &Runtime, sender: &Sender<Message>) {
        self.clear();
        for root in paths::build_watch_roots(targets) {
            match FileWatcher::new(&root) {
                Ok(watcher) => self
                    .0
                    .push(runtime.spawn(observe(watcher, root, sender.clone()))),
                Err(error) => warn!(%error, "Build output monitoring could not start"),
            }
        }
    }

    /// Abort before the LSP writer waits for all its senders to close.
    fn clear(&mut self) {
        for task in self.0.drain(..) {
            task.abort();
        }
    }
}

impl Drop for BuildMonitor {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Only compiler outputs invalidate discovery; source edits and discovery reads do not.
fn is_output(change: &ChangeEvent) -> bool {
    match change {
        ChangeEvent::Rescan => true,
        ChangeEvent::Touched(paths) | ChangeEvent::Removed(paths) => {
            paths.iter().any(|path| paths::is_build_output(path))
        }
        _ => false,
    }
}

/// Coalesce output writes without occupying the LSP request loop.
async fn observe(mut watcher: FileWatcher, root: PathBuf, sender: Sender<Message>) {
    let mut deadline = None;
    loop {
        tokio::select! {
            change = watcher.next() => match change {
                Some(change) if is_output(&change) => deadline = Some(Instant::now() + QUIET),
                Some(_) => {},
                None => break,
            },
            () = settled(deadline) => {
                deadline = None;
                if !publish(&root, &sender) { break; }
            }
        }
    }
}

/// An unarmed timer waits for the first output event without polling.
async fn settled(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Publish one settled output revision for every editor, independent of VS Code tasks.
fn publish(root: &std::path::Path, sender: &Sender<Message>) -> bool {
    let params = serde_json::json!({ "root": paths::path_to_uri(&root.to_string_lossy()).ok() });
    info!("Build outputs settled; invalidating test discovery");
    sender
        .send(Message::Notification(Notification::new(
            "sharplsp/buildCompleted".to_string(),
            params,
        )))
        .is_ok()
}
