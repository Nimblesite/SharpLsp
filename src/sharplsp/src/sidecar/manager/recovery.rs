//! Rehydrate compiler inputs before a respawn can answer semantic queries.
//! Implements [DIAG-TRUTH-GUARANTEES]; computed diagnostics remain solely in Salsa.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{info, warn};

use super::{request_budget, SidecarManager};
use crate::paths;
use crate::pull_diagnostics::DiagnosticDocument;
use crate::semantic::SidecarDidChangeReq;
use crate::sidecar::transport::FramedTransport;
use crate::tree_sitter_parse::LangId;
use crate::vfs::Vfs;

/// Only desired workspace/policy inputs are retained; editor text stays in VFS.
#[derive(Clone, Default)]
struct Inputs {
    /// Desired workspace selector in its compiler protocol representation.
    workspace: Option<Vec<u8>>,
    /// `SharpLsp` analyzer configuration last supplied to this compiler.
    analyzers: Option<Vec<u8>>,
    /// Compiler analyzer opt-out last supplied to this compiler.
    diagnostics: Option<Vec<u8>>,
}

/// Bounded metadata inputs and weak access to the authoritative editor inputs.
#[derive(Default)]
pub(super) struct SessionInputs {
    /// Independent metadata and heartbeats cannot satisfy deferred bootstrap. [SIDECAR-RECOVERY-METADATA]
    pending: AtomicBool,
    /// Three replaceable protocol inputs, never computed semantic results.
    inputs: Mutex<Inputs>,
    /// The existing VFS owns all editor text and document lifetimes.
    documents: OnceLock<Weak<Vfs>>,
}

impl SessionInputs {
    /// Replace known input metadata before sending it through the FIFO transport.
    pub(super) fn remember(&self, method: &str, payload: &[u8]) -> Result<()> {
        if !matches!(
            method,
            "workspace/open" | "analyzers/configure" | "diagnostics/configure"
        ) {
            return Ok(());
        }
        let mut inputs = self
            .inputs
            .lock()
            .map_err(|error| anyhow::anyhow!("compiler inputs poisoned: {error}"))?;
        match method {
            "workspace/open" => inputs.workspace = Some(payload.to_vec()),
            "analyzers/configure" => inputs.analyzers = Some(payload.to_vec()),
            "diagnostics/configure" => inputs.diagnostics = Some(payload.to_vec()),
            _ => {}
        }
        Ok(())
    }

    /// Release the synchronous metadata lock before any compiler interaction.
    fn snapshot(&self) -> Result<Inputs> {
        self.inputs
            .lock()
            .map(|inputs| inputs.clone())
            .map_err(|error| anyhow::anyhow!("compiler inputs poisoned: {error}"))
    }
}

impl SidecarManager {
    /// Retain weak access to the single authoritative editor document store.
    pub(crate) fn set_document_source(&self, vfs: &Arc<Vfs>) {
        let _source = self.session.documents.get_or_init(|| Arc::downgrade(vfs));
    }

    /// Restore a respawned compiler before answering the queued caller.
    pub(super) async fn request_connected(
        &self,
        connection: &mut Option<FramedTransport>,
        method: &str,
        payload: Vec<u8>,
        budget: Duration,
        fresh: bool,
        cancel: Option<&lspkit_server::CancellationToken>,
    ) -> Result<Vec<u8>> {
        let recovered = self.recovery_required(fresh, method);
        if recovered {
            self.restore_session(connection, method).await?;
        }
        let response = self
            .exchange_cancellable(connection, method, payload, budget, cancel)
            .await?;
        self.finish_recovery(connection, method, recovered).await?;
        Ok(response)
    }

    /// Workspace-independent protocol operations retain the next semantic caller's replay obligation.
    fn recovery_required(&self, fresh: bool, method: &str) -> bool {
        if fresh && self.ever_connected.swap(true, Ordering::AcqRel) {
            self.session.pending.store(true, Ordering::Release);
        }
        self.session.pending.load(Ordering::Acquire)
            && !matches!(
                method,
                "solution/read" | "ping" | "analyzers/configure" | "diagnostics/configure"
            )
    }

    /// Explicit workspace replacement replays overlays before its transport becomes semantically ready.
    async fn finish_recovery(
        &self,
        connection: &mut Option<FramedTransport>,
        method: &str,
        recovered: bool,
    ) -> Result<()> {
        if method == "workspace/open" {
            if let Err(error) = self.replay_overlays(connection, true).await {
                self.disconnect(connection).await;
                return Err(error);
            }
        }
        if recovered {
            self.session.pending.store(false, Ordering::Release);
        }
        Ok(())
    }

    /// A failed restore invalidates the connection instead of exposing an empty workspace.
    async fn restore_session(
        &self,
        connection: &mut Option<FramedTransport>,
        pending: &str,
    ) -> Result<()> {
        if let Err(error) = self.replay_inputs(connection, pending).await {
            self.disconnect(connection).await;
            return Err(error).context("restore compiler workspace inputs");
        }
        info!(sidecar = %self.name, "Compiler session restored");
        Ok(())
    }

    /// Apply policy before workspace opening, then restore current editor buffers.
    async fn replay_inputs(
        &self,
        connection: &mut Option<FramedTransport>,
        pending: &str,
    ) -> Result<()> {
        let inputs = self.session.snapshot()?;
        let workspace = inputs.workspace.filter(|payload| self.still_opens(payload));
        for (method, payload) in [
            ("analyzers/configure", inputs.analyzers),
            ("diagnostics/configure", inputs.diagnostics),
            ("workspace/open", workspace),
        ] {
            if let Some(payload) =
                payload.filter(|_| method != "workspace/open" || pending != method)
            {
                let _response = self
                    .exchange(connection, method, payload, request_budget(method))
                    .await?;
            }
        }
        if pending != "workspace/open" {
            self.replay_overlays(connection, false).await?;
        }
        Ok(())
    }

    /// Whether the remembered workspace `payload` can still open. One deleted
    /// since, such as a scratch solution a scaffold removed, never can, and each
    /// failed restore respawned the compiler again; it is skipped while it is
    /// missing and restored again once it is back. [DIAG-TRUTH-RECOVERY]
    fn still_opens(&self, payload: &[u8]) -> bool {
        match rmp_serde::from_slice::<String>(payload) {
            Ok(target) if !paths::exists(&target) => {
                warn!(sidecar = %self.name, "Remembered workspace no longer exists; restoring without it");
                false
            }
            _ => true,
        }
    }

    /// Replay ephemeral snapshots without holding VFS entries across awaits.
    async fn replay_overlays(
        &self,
        connection: &mut Option<FramedTransport>,
        selected: bool,
    ) -> Result<()> {
        let Some(documents) = self.session.documents.get().and_then(Weak::upgrade) else {
            return Ok(());
        };
        let scope = if selected {
            Some(self.workspace_overlay_scope(connection).await?)
        } else {
            None
        };
        let overlays = self.overlay_snapshot(&documents, scope.as_ref());
        info!(sidecar = %self.name, documents = overlays.len(), "Replaying compiler overlays");
        for overlay in overlays {
            let payload = rmp_serde::to_vec(&overlay)?;
            let _response = self
                .exchange(
                    connection,
                    "textDocument/didChange",
                    payload,
                    request_budget("textDocument/didChange"),
                )
                .await?;
        }
        Ok(())
    }

    /// Enumerate the selected graph without compiling or adopting excluded open owners.
    async fn workspace_overlay_scope(
        &self,
        connection: &mut Option<FramedTransport>,
    ) -> Result<HashSet<String>> {
        let method = "workspace/diagnostics/documents";
        let payload = self
            .exchange(
                connection,
                method,
                rmp_serde::to_vec(&())?,
                request_budget(method),
            )
            .await?;
        let documents: Vec<DiagnosticDocument> =
            rmp_serde::from_slice(&payload).context("decode workspace overlay scope")?;
        Ok(documents
            .into_iter()
            .map(|document| paths::comparison_key(&document.file_path))
            .collect())
    }

    /// Clone only open inputs owned by this language engine for this replay.
    pub(crate) fn overlay_snapshot(
        &self,
        vfs: &Vfs,
        scope: Option<&HashSet<String>>,
    ) -> Vec<SidecarDidChangeReq> {
        vfs.iter()
            .filter(|document| self.owns_document(document.key()))
            .filter_map(
                |document| match crate::paths::uri_to_path(document.key().as_str()) {
                    Ok(file_path) => Some(SidecarDidChangeReq {
                        file_path,
                        new_text: document.content.clone(),
                    }),
                    Err(error) => {
                        warn!(uri = document.key().as_str(), %error, "Unsupported compiler overlay URI");
                        None
                    }
                },
            )
            .filter(|overlay| {
                scope.is_none_or(|paths| paths.contains(&paths::comparison_key(&overlay.file_path)))
            })
            .collect()
    }

    /// Projected Razor buffers use Roslyn; F# buffers use FCS.
    fn owns_document(&self, uri: &lsp_types::Uri) -> bool {
        matches!(
            (self.language, LangId::from_uri(uri)),
            (Some(LangId::FSharp), Some(LangId::FSharp))
                | (Some(LangId::CSharp), Some(LangId::CSharp | LangId::Razor))
        )
    }
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
