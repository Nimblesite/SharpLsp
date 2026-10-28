//! A running server follows its configuration. A client settings change, or an
//! edit to a `sharplsp.toml` or the personal configuration file, re-resolves it
//! and applies what can change without a restart: the C# solution choice, the
//! compilers' analyzer settings, then their diagnostic settings with a refresh,
//! so the next pull reports under the new settings. A change to a setting read
//! only at startup is named in a warning instead. Implements [CONFIG-RESOLUTION-LIVE].
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use crossbeam_channel::Sender;
use lsp_server::{Message, Notification};
use lsp_types::MessageType;
use lspkit_live::{watcher::CoalescedWatcher, ChangeEvent, FileWatcher, ScheduleConfig};
use serde::Serialize;
use serde_json::Value;
use tracing::{info, warn};

use crate::config::{find_config_file, SharpLspConfig, CONFIG_FILE_NAME};
use crate::configuration::user_config_file;
use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;
use crate::{paths, pull_diagnostics, workspace_open, HostServices};

/// The loop-internal notice that a watched configuration file changed.
pub(crate) const CONFIGURATION_FILES_CHANGED: &str = "sharplsp/configurationFilesChanged";

/// The compilers a reconfiguration reaches: C#'s, then F#'s.
pub(crate) type Compilers<'a> = [Option<&'a Arc<SidecarManager>>; 2];

/// Native subscriptions to the configuration files, ended when dropped.
pub(crate) struct ConfigWatch {
    /// One watch task per directory holding a configuration file.
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl ConfigWatch {
    /// Watch the files the configuration of `root` resolves from: a `sharplsp.toml`
    /// in the root or the nearest one above it, and the personal configuration file.
    pub(crate) fn start(
        root: &Path,
        runtime: &tokio::runtime::Handle,
        inbound: &Sender<Message>,
    ) -> Self {
        let personal = user_config_file();
        let tasks = watched_directories(root, personal.as_deref())
            .iter()
            .filter_map(|directory| {
                watch(directory, personal.clone(), runtime, inbound)
                    .map_err(|error| warn!(directory = %directory.display(), %error, "Configuration directory not watched"))
                    .ok()
            })
            .collect();
        Self { tasks }
    }
}

impl Drop for ConfigWatch {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// The directories holding the configuration files, each once: the root, the
/// nearest `sharplsp.toml`'s and the personal file's.
fn watched_directories(root: &Path, personal: Option<&Path>) -> Vec<PathBuf> {
    [
        Some(root.to_path_buf()),
        find_config_file(root)
            .as_deref()
            .and_then(paths::directory_of),
        personal.and_then(paths::directory_of),
    ]
    .into_iter()
    .flatten()
    .fold(Vec::new(), |mut unique, directory| {
        if !unique
            .iter()
            .any(|seen| paths::same_native_path(seen, &directory))
        {
            unique.push(directory);
        }
        unique
    })
}

/// Whether a native change can move the configuration: any `sharplsp.toml` in a
/// watched directory or the personal file changed, or the observation was lost.
fn touches_configuration(event: &ChangeEvent, personal: Option<&Path>) -> bool {
    match event {
        ChangeEvent::Touched(changed) | ChangeEvent::Removed(changed) => {
            changed.iter().any(|path| {
                paths::has_file_name(path, CONFIG_FILE_NAME)
                    || personal.is_some_and(|file| paths::same_native_path(path, file))
            })
        }
        _ => true,
    }
}

/// Watch one directory, telling the main loop when a configuration file in it changes.
fn watch(
    directory: &Path,
    personal: Option<PathBuf>,
    runtime: &tokio::runtime::Handle,
    inbound: &Sender<Message>,
) -> Result<tokio::task::JoinHandle<()>> {
    let watcher = FileWatcher::non_recursive(directory)?;
    let _entered = runtime.enter();
    let mut schedule = ScheduleConfig::default();
    schedule.quiet = Duration::from_millis(150);
    let changes = watcher.coalesced(schedule);
    Ok(runtime.spawn(observe(changes, personal, inbound.clone())))
}

/// Forward each batch of changes that touches configuration as one notice.
async fn observe(
    mut changes: CoalescedWatcher,
    personal: Option<PathBuf>,
    inbound: Sender<Message>,
) {
    while let Some(trigger) = changes.next().await {
        let relevant = trigger
            .events
            .iter()
            .any(|event| touches_configuration(event, personal.as_deref()));
        let notice = Notification::new(CONFIGURATION_FILES_CHANGED.to_owned(), Value::Null);
        if relevant && inbound.send(Message::Notification(notice)).is_err() {
            return;
        }
    }
}

/// Apply a client settings change: a rejected one keeps the previous settings.
pub(crate) fn settings_changed(
    services: &mut HostServices,
    params: &Value,
    compilers: Compilers<'_>,
    vfs: &Arc<Vfs>,
    runtime: &tokio::runtime::Runtime,
    client: &Sender<Message>,
) {
    let settings = params.get("settings").unwrap_or(&Value::Null);
    match services.configuration.update(settings) {
        Ok(()) => reconfigure(services, compilers, vfs, runtime, client),
        Err(error) => warn!("Configuration change rejected: {error:#}"),
    }
}

/// Re-resolve the configuration and apply it to the running server.
pub(crate) fn reconfigure(
    services: &mut HostServices,
    compilers: Compilers<'_>,
    vfs: &Arc<Vfs>,
    runtime: &tokio::runtime::Runtime,
    client: &Sender<Message>,
) {
    let config = match services.configuration.config() {
        Ok(config) => config,
        Err(error) => return warn!("Configuration change not applied: {error:#}"),
    };
    services
        .solution
        .settings_changed(&services.configuration, compilers[0], vfs, runtime);
    if changed(&services.applied.analyzers, &config.analyzers) {
        configure_analyzers(&config, compilers, runtime);
    }
    if let Err(error) = pull_diagnostics::state::configure(&config.diagnostics) {
        warn!(%error, "Diagnostic configuration could not be applied");
    }
    notify_restart_only(&services.applied, &config, client);
    services.applied = config;
}

/// Push the analyzer settings to every compiler before diagnostics refresh, so
/// the next pull is analyzed under them.
fn configure_analyzers(
    config: &SharpLspConfig,
    compilers: Compilers<'_>,
    runtime: &tokio::runtime::Runtime,
) {
    runtime.block_on(async {
        for compiler in compilers.into_iter().flatten() {
            workspace_open::configure_analyzers(compiler, &config.analyzers).await;
        }
    });
    info!(
        dead_code = config.analyzers.dead_code,
        monorepo = config.analyzers.monorepo,
        "Analyzer settings applied live"
    );
}

/// Whether a section's settings changed.
fn changed<T: Serialize>(previous: &T, current: &T) -> bool {
    serde_json::to_value(previous).ok() != serde_json::to_value(current).ok()
}

/// The settings only read at startup that differ, by name.
fn restart_only_changes(previous: &SharpLspConfig, current: &SharpLspConfig) -> Vec<&'static str> {
    [
        ("[server]", changed(&previous.server, &current.server)),
        (
            "[csharp] enabled",
            previous.csharp.enabled != current.csharp.enabled,
        ),
        (
            "[fsharp] enabled",
            previous.fsharp.enabled != current.fsharp.enabled,
        ),
        ("[profiler]", changed(&previous.profiler, &current.profiler)),
    ]
    .into_iter()
    .filter_map(|(name, differs)| differs.then_some(name))
    .collect()
}

/// Warn the user, once per change, that some changed settings take a restart.
fn notify_restart_only(
    previous: &SharpLspConfig,
    current: &SharpLspConfig,
    client: &Sender<Message>,
) {
    let pending = restart_only_changes(previous, current);
    if pending.is_empty() {
        return;
    }
    let message = format!(
        "SharpLsp: restart the language server to apply {}.",
        pending.join(", ")
    );
    warn!(settings = ?pending, "Changed settings take effect after a restart");
    workspace_open::show_message(client, MessageType::WARNING, message, "Restart notice");
}

#[cfg(test)]
#[path = "configuration_live_tests.rs"]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
mod tests;
