//! Connection-owned pull state and refresh. [DIAG-ARCHITECTURE-SALSA]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use lsp_server::{Message, Request, RequestId};
use lsp_types::ClientCapabilities;
use lspkit_server::pull::{AnalysisError, PullStore};
use tracing::warn;

use crate::config::DiagnosticsConfig;
use crate::sidecar::manager::SidecarManager;

/// The sole session; computed values live only in its Salsa database.
static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
/// Monotonic token coalescing refresh requests.
static REFRESH: AtomicU64 = AtomicU64::new(0);
/// Protocol mode is read from async engine callbacks without blocking their workers.
static PULL: AtomicBool = AtomicBool::new(false);

/// Per-connection compiler query state and effective policy.
struct Session {
    /// The native input monitor follows the active compiler workspace.
    inputs: super::monitor::InputMonitor,
    /// Internal input events share the serialized LSP request queue.
    inbound: Option<crossbeam_channel::Sender<Message>>,
    /// Semantic engines receive live analyzer configuration changes.
    engines: Vec<Arc<SidecarManager>>,
    /// Last explicitly requested compiler workspace, independent of editor root.
    workspace: Option<String>,
    /// Salsa owns diagnostic result reuse.
    store: PullStore,
    /// Modern clients receive pulls exclusively.
    pull: bool,
    /// The client declared the refresh request.
    refresh: bool,
    /// Validated runtime policy.
    config: DiagnosticsConfig,
    /// Refresh request sink.
    sender: crossbeam_channel::Sender<Message>,
    /// Executor for debounce timers.
    runtime: tokio::runtime::Handle,
}

/// Initialize before workspace opens and request dispatch.
pub fn initialize(
    capabilities: &ClientCapabilities,
    config: &DiagnosticsConfig,
    runtime: &tokio::runtime::Runtime,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    sender: crossbeam_channel::Sender<Message>,
) -> Result<()> {
    let runtime = runtime.handle().clone();
    PULL.store(supports_pull(capabilities), Ordering::Release);
    let analyzer = analyzer(runtime.clone(), sidecars);
    let session = Session {
        inputs: super::monitor::InputMonitor::default(),
        inbound: None,
        engines: sidecars.into_iter().flatten().map(Arc::clone).collect(),
        workspace: None,
        store: PullStore::new_cancellable(analyzer),
        pull: supports_pull(capabilities),
        refresh: supports_refresh(capabilities),
        config: config.clone(),
        sender,
        runtime,
    };
    SESSION
        .set(Mutex::new(Some(session)))
        .map_err(|_session| anyhow::anyhow!("diagnostics session already initialized"))
}

/// Prefer explicit pull support, even when the client also supports push.
pub fn supports_pull(capabilities: &ClientCapabilities) -> bool {
    capabilities
        .text_document
        .as_ref()
        .is_some_and(|document| document.diagnostic.is_some())
}

/// Whether this connection negotiates pull exclusively.
pub fn is_pull() -> bool {
    PULL.load(Ordering::Acquire)
}

/// Effective policy; standalone protocol publications use defaults before session creation.
pub fn configuration() -> Result<DiagnosticsConfig> {
    if SESSION.get().is_none() {
        return Ok(DiagnosticsConfig::default());
    }
    with_session(|session| Ok(session.config.clone()))
}

/// Record the workspace request before asynchronous opening, so old completions cannot replace it.
pub fn select_workspace(target: &str) -> Result<()> {
    with_session(|session| {
        session.workspace = Some(target.to_owned());
        session.store.invalidate();
        if let Some(inbound) = &session.inbound {
            session.inputs.replace(target, &session.runtime, inbound)?;
        }
        Ok(())
    })
}

/// Connect native filesystem inputs once the foreground dispatch queue exists.
pub fn connect_inputs(
    inbound: crossbeam_channel::Sender<Message>,
    cancellation: lspkit_server::CancellationHandle,
) -> Result<()> {
    with_session(|session| {
        session.inputs.connect(cancellation);
        if let Some(target) = &session.workspace {
            session.inputs.replace(target, &session.runtime, &inbound)?;
        }
        session.inbound = Some(inbound);
        Ok(())
    })
}

/// The actual selected solution can live outside the editor's workspace folder.
pub fn workspace() -> Result<Option<String>> {
    with_session(|session| Ok(session.workspace.clone()))
}

/// Replace validated policy and refresh affected reports.
pub fn configure(config: &DiagnosticsConfig) -> Result<()> {
    with_session(|session| {
        session.store.invalidate();
        session.config = config.clone();
        session.runtime.block_on(async {
            for engine in &session.engines {
                crate::workspace_open::configure_diagnostics(
                    engine,
                    config.analyzers_enabled,
                    config.auto_restore_on_open,
                )
                .await?;
            }
            Ok::<(), anyhow::Error>(())
        })?;
        Ok(())
    })?;
    invalidate()
}

/// A compiler `WorkspaceChanged` refreshes future snapshots without superseding
/// in-flight pulls, which complete against their own. [DIAG-ANALYSIS-CANCELLATION]
pub fn engine_changed() {
    refresh_after(PullStore::engine_changed);
}

/// A compiler that finished loading the selected workspace replaces the snapshot a
/// pull enumerated while it loaded, so in-flight pulls are superseded and retried.
/// [DIAG-IPC-INITIALIZED] [DIAG-ANALYSIS-CANCELLATION]
pub fn engine_loaded() {
    refresh_after(PullStore::invalidate);
}

/// Compiler callbacks never block Tokio's reader workers behind a synchronous Salsa query.
fn refresh_after(operation: fn(&PullStore)) {
    drop(tokio::task::spawn_blocking(move || {
        if let Err(error) = change_store(operation).and_then(|()| refresh_inputs()) {
            warn!(%error, "Compiler diagnostic inputs could not refresh");
        }
    }));
}

/// Enumerate current compiler inputs without holding the session lock across IPC.
fn refresh_inputs() -> Result<()> {
    let (runtime, engines, revision) = with_session(|session| {
        Ok((
            session.runtime.clone(),
            session.engines.clone(),
            session.store.revision(),
        ))
    })?;
    let documents = runtime.block_on(super::documents([engines.first(), engines.get(1)]))?;
    watch_documents(&documents, revision)
}

/// An obsolete query cannot attach previous workspace inputs to the current monitor.
pub(super) fn watch_documents(
    documents: &[super::DiagnosticDocument],
    revision: u64,
) -> Result<()> {
    with_session(|session| {
        if session.store.revision() != revision {
            return Ok(());
        }
        if let Some(inbound) = &session.inbound {
            let roots = super::document_roots(documents);
            session.inputs.follow(roots, &session.runtime, inbound)?;
        }
        Ok(())
    })
}

/// Invalidate dependencies after a completed compiler-workspace mutation.
pub fn begin_change() {
    if let Err(error) = invalidate() {
        warn!(%error, "Diagnostic input mutation could not invalidate old snapshots");
    }
}

/// Apply one store change and retain the standard debounced refresh.
fn change_store(operation: impl FnOnce(&PullStore)) -> Result<()> {
    with_session(|session| {
        operation(&session.store);
        schedule_refresh(session);
        Ok(())
    })
}

/// Invalidate dependencies after a completed compiler-workspace mutation.
pub fn invalidate() -> Result<()> {
    change_store(PullStore::invalidate)
}

/// Schedule the standard debounced refresh after a completed background reload.
/// Unlike [`invalidate`], this does not bump the snapshot revision: the
/// foreground invalidation already superseded pending work before the reload was
/// forwarded, and a second bump would spuriously supersede requests the sidecar
/// transport already serialized behind the reload ([DIAG-LSP-REFRESH]).
pub fn refresh() -> Result<()> {
    with_session(|session| {
        schedule_refresh(session);
        Ok(())
    })
}

/// Clone query ownership without holding the session lock during compiler work.
pub fn store() -> Result<PullStore> {
    with_session(|session| Ok(session.store.clone()))
}

/// Report poisoned/unavailable state instead of fabricating clean diagnostics.
fn with_session<T>(operation: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
    let session = SESSION.get().context("diagnostics session unavailable")?;
    let mut session = session
        .lock()
        .map_err(|error| anyhow::anyhow!("diagnostics session poisoned: {error}"))?;
    operation(session.as_mut().context("diagnostics session stopped")?)
}

/// Release query/transport references before the LSP writer thread is joined.
pub fn shutdown() -> Result<()> {
    let _revision = REFRESH.fetch_add(1, Ordering::SeqCst);
    if let Some(session) = SESSION.get() {
        let mut session = session
            .lock()
            .map_err(|error| anyhow::anyhow!("diagnostic shutdown lock poisoned: {error}"))?;
        let _session = session.take();
    }
    Ok(())
}

/// Whether standard diagnostic refresh requests are accepted.
fn supports_refresh(capabilities: &ClientCapabilities) -> bool {
    capabilities
        .workspace
        .as_ref()
        .and_then(|workspace| workspace.diagnostic.as_ref())
        .and_then(|diagnostic| diagnostic.refresh_support)
        == Some(true)
}

/// Coalesce workspace edits without retaining diagnostic values.
fn schedule_refresh(session: &Session) {
    if !session.pull || !session.refresh {
        return;
    }
    let revision = REFRESH.fetch_add(1, Ordering::SeqCst).saturating_add(1);
    let sender = session.sender.clone();
    let delay = Duration::from_millis(session.config.refresh_debounce_ms);
    drop(session.runtime.spawn(async move {
        tokio::time::sleep(delay).await;
        if REFRESH.load(Ordering::SeqCst) != revision {
            return;
        }
        let request = Request::new(
            RequestId::from(format!("diagnostics-refresh-{revision}")),
            "workspace/diagnostic/refresh".to_owned(),
            serde_json::Value::Null,
        );
        if let Err(error) = sender.send(Message::Request(request)) {
            warn!(%error, "Diagnostics refresh connection closed");
        }
    }));
}

/// URI routing and IPC stay in the host; the shared query is engine agnostic.
fn analyzer(
    runtime: tokio::runtime::Handle,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> lspkit_server::pull::CancellableAnalyzer {
    let [csharp, fsharp] = sidecars.map(|sidecar| sidecar.map(Arc::clone));
    Arc::new(move |raw, cancel| {
        let uri = raw
            .parse::<lsp_types::Uri>()
            .map_err(|error| AnalysisError(error.to_string()))?;
        let path = crate::paths::uri_to_path(uri.as_str())
            .map_err(|error| AnalysisError(error.to_string()))?;
        let sidecar = if crate::paths::is_fsharp_diagnostic_input(&path) {
            fsharp.as_ref()
        } else {
            csharp.as_ref()
        };
        let sidecar = sidecar
            .ok_or_else(|| AnalysisError("requested compiler engine unavailable".to_owned()))?;
        runtime
            .block_on(crate::diagnostics::fetch_from_sidecar(
                sidecar,
                &path,
                Some(cancel),
            ))
            .map(Arc::new)
            .map_err(|error| AnalysisError(format!("{error:#}")))
    })
}
