//! Rehydrate compiler inputs before a respawn can answer semantic queries.
//! Implements [DIAG-TRUTH-GUARANTEES]; computed diagnostics remain solely in Salsa.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{info, warn};

use super::{request_budget, SidecarManager};
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
    ) -> Result<Vec<u8>> {
        let recovered = fresh && self.ever_connected.swap(true, Ordering::AcqRel);
        if recovered {
            self.restore_session(connection, method).await?;
        }
        let response = self.exchange(connection, method, payload, budget).await?;
        if recovered && method == "workspace/open" {
            if let Err(error) = self.replay_overlays(connection).await {
                self.disconnect(connection).await;
                return Err(error);
            }
        }
        Ok(response)
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
        for (method, payload) in [
            ("analyzers/configure", inputs.analyzers),
            ("diagnostics/configure", inputs.diagnostics),
            ("workspace/open", inputs.workspace),
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
            self.replay_overlays(connection).await?;
        }
        Ok(())
    }

    /// Replay ephemeral snapshots without holding VFS entries across awaits.
    async fn replay_overlays(&self, connection: &mut Option<FramedTransport>) -> Result<()> {
        let Some(documents) = self.session.documents.get().and_then(Weak::upgrade) else {
            return Ok(());
        };
        let overlays = self.overlay_snapshot(&documents);
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

    /// Clone only open inputs owned by this language engine for this replay.
    fn overlay_snapshot(&self, vfs: &Vfs) -> Vec<SidecarDidChangeReq> {
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
