//! Native source watching is editor independent. [DIAG-LSP-REFRESH]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use crossbeam_channel::Sender;
use lsp_server::{Message, Notification};
use lspkit_live::{ChangeEvent, FileWatcher, ScheduleConfig, Trigger};
use serde_json::{json, Value};

use crate::paths;

/// Watch task ownership ends when the active workspace or server changes.
#[derive(Default)]
pub struct InputMonitor {
    /// The selected solution stays watched while compiler membership changes.
    base: Vec<PathBuf>,
    /// Canonical path keys own subscriptions, never diagnostic results.
    tasks: HashMap<String, tokio::task::JoinHandle<()>>,
}

impl InputMonitor {
    /// Monitor the selected solution, including a target outside editor folders.
    pub fn replace(
        &mut self,
        target: &str,
        runtime: &tokio::runtime::Handle,
        inbound: &Sender<Message>,
    ) -> Result<()> {
        self.clear();
        self.base = paths::build_watch_roots(&[target.to_owned()]);
        self.follow(Vec::new(), runtime, inbound)
    }

    /// Follow actual compiler inputs without replacing unchanged native subscriptions.
    pub fn follow(
        &mut self,
        roots: Vec<PathBuf>,
        runtime: &tokio::runtime::Handle,
        inbound: &Sender<Message>,
    ) -> Result<()> {
        let roots = paths::minimal_watch_roots(self.base.iter().cloned().chain(roots));
        for (key, root) in &roots {
            if !self.tasks.contains_key(key) {
                let task = watch(root, runtime, inbound)?;
                let _previous = self.tasks.insert(key.clone(), task);
            }
        }
        self.tasks.retain(|key, task| {
            let keep = roots.contains_key(key);
            if !keep {
                task.abort();
            }
            keep
        });
        Ok(())
    }

    /// Cancel native watching before the request queue is joined.
    fn clear(&mut self) {
        for (_, task) in self.tasks.drain() {
            task.abort();
        }
    }
}

/// lspkit owns native watching and event coalescing; this adapter supplies compiler scope.
fn watch(
    root: &Path,
    runtime: &tokio::runtime::Handle,
    inbound: &Sender<Message>,
) -> Result<tokio::task::JoinHandle<()>> {
    let watcher = FileWatcher::new(root)?;
    let _entered = runtime.enter();
    let mut config = ScheduleConfig::default();
    config.quiet = Duration::from_millis(150);
    Ok(runtime.spawn(observe(watcher.coalesced(config), inbound.clone())))
}

impl Drop for InputMonitor {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Feed the same standard watched-file handler used by clients.
async fn observe(mut watcher: lspkit_live::watcher::CoalescedWatcher, inbound: Sender<Message>) {
    while let Some(trigger) = watcher.next().await {
        let changes = input_changes(trigger);
        if changes.is_empty() {
            continue;
        }
        let notification = Notification::new(
            "workspace/didChangeWatchedFiles".to_owned(),
            json!({ "changes": changes }),
        );
        if inbound.send(Message::Notification(notification)).is_err() {
            return;
        }
    }
}

/// Only source or project/analyzer metadata enters the compiler invalidation queue.
fn input_changes(trigger: Trigger) -> Vec<Value> {
    trigger
        .events
        .into_iter()
        .flat_map(|event| match event {
            ChangeEvent::Touched(paths) => paths.into_iter().map(|path| (path, 2)).collect(),
            ChangeEvent::Removed(paths) => paths.into_iter().map(|path| (path, 3)).collect(),
            _ => Vec::new(),
        })
        .filter(|(path, _)| paths::is_diagnostic_input(path))
        .filter_map(|(path, typ)| {
            paths::path_to_uri(&path.to_string_lossy())
                .ok()
                .map(|uri| json!({ "uri": uri, "type": typ }))
        })
        .collect()
}
