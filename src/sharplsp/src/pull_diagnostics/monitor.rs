//! Native source watching is editor independent. [DIAG-LSP-REFRESH]

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use crossbeam_channel::Sender;
use lsp_server::{Message, Notification};
use lspkit_server::live::{ChangeEvent, FileWatcher, ScheduleConfig, Trigger};
use lspkit_server::CancellationHandle;
use serde_json::{json, Value};

use crate::paths;

/// Watch task ownership ends when the active workspace or server changes.
#[derive(Default)]
pub struct InputMonitor {
    /// The selected solution stays watched while compiler membership changes.
    base: Vec<PathBuf>,
    /// Canonical path keys own subscriptions, never diagnostic results.
    tasks: HashMap<(String, bool), tokio::task::JoinHandle<()>>,
    /// Weak protocol control cannot retain the dispatcher or compiler handlers.
    cancellation: Option<CancellationHandle>,
}

impl InputMonitor {
    /// Native input loss must interrupt old work before entering the foreground queue.
    pub fn connect(&mut self, cancellation: CancellationHandle) {
        self.cancellation = Some(cancellation);
    }

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
        let cancellation = self
            .cancellation
            .clone()
            .ok_or_else(|| anyhow::anyhow!("native input cancellation is not connected"))?;
        let roots = paths::diagnostic_watch_scopes(self.base.iter().cloned().chain(roots));
        for (key, root) in &roots {
            if !self.tasks.contains_key(key) {
                let task = watch(root, key.1, runtime, inbound, cancellation.clone())?;
                let _previous = self.tasks.insert(key.clone(), task);
            }
        }
        self.retain_scopes(&roots);
        Ok(())
    }

    /// A changed depth retires the old subscription as well as removed directories.
    fn retain_scopes(&mut self, roots: &BTreeMap<(String, bool), PathBuf>) {
        self.tasks.retain(|key, task| {
            let keep = roots.contains_key(key);
            if !keep {
                task.abort();
            }
            keep
        });
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
    recursive: bool,
    runtime: &tokio::runtime::Handle,
    inbound: &Sender<Message>,
    cancellation: CancellationHandle,
) -> Result<tokio::task::JoinHandle<()>> {
    let watcher = scoped_watcher(root, recursive)?;
    let _entered = runtime.enter();
    let mut config = ScheduleConfig::default();
    config.quiet = Duration::from_millis(150);
    let observations = observe(
        watcher.coalesced(config),
        inbound.clone(),
        recursive,
        cancellation,
    );
    Ok(runtime.spawn(observations))
}

/// Keep native depth selection in the shared watcher implementation.
fn scoped_watcher(root: &Path, recursive: bool) -> Result<FileWatcher, lspkit_server::live::WatcherError> {
    if recursive {
        FileWatcher::new(root)
    } else {
        FileWatcher::non_recursive(root)
    }
}

impl Drop for InputMonitor {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Feed the same standard watched-file handler used by clients.
async fn observe(
    mut watcher: lspkit_server::live::watcher::CoalescedWatcher,
    inbound: Sender<Message>,
    recursive: bool,
    cancellation: CancellationHandle,
) {
    while let Some(trigger) = watcher.next().await {
        let rescan = trigger
            .events
            .iter()
            .any(|event| matches!(event, ChangeEvent::Rescan));
        if rescan {
            cancellation.supersede_all();
        }
        let changes = input_changes(trigger, recursive);
        if (rescan || !changes.is_empty()) && !notify_changes(&inbound, &changes, rescan) {
            return;
        }
    }
}

/// Route native observations through the existing foreground notification queue.
fn notify_changes(inbound: &Sender<Message>, changes: &[Value], rescan: bool) -> bool {
    let notification = Notification::new(
        "workspace/didChangeWatchedFiles".to_owned(),
        json!({ "changes": changes, "sharplspRescan": rescan }),
    );
    inbound.send(Message::Notification(notification)).is_ok()
}

/// Only source or project/analyzer metadata enters the compiler invalidation queue.
fn input_changes(trigger: Trigger, recursive: bool) -> Vec<Value> {
    trigger
        .events
        .into_iter()
        .flat_map(changed_paths)
        .filter(|(path, _)| paths::diagnostic_input_in_scope(path, recursive))
        .filter_map(|(path, typ)| {
            paths::native_path_to_uri(&path)
                .ok()
                .map(|uri| json!({ "uri": uri, "type": typ }))
        })
        .collect()
}

/// Preserve native create/modify/remove kinds before applying compiler input scope.
fn changed_paths(event: ChangeEvent) -> Vec<(PathBuf, i32)> {
    match event {
        ChangeEvent::Touched(paths) => paths.into_iter().map(|path| (path, 2)).collect(),
        ChangeEvent::Removed(paths) => paths.into_iter().map(|path| (path, 3)).collect(),
        _ => Vec::new(),
    }
}
