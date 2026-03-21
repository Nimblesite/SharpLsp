//! Forge LSP Server — main entry point.
//!
//! Implements LSP 3.17 lifecycle over stdio using `lsp-server`.

mod config;
mod semantic;
mod sidecar;
mod syntax;
mod tree_sitter_parse;
mod vfs;
mod workspace_symbols;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::{Connection, Message, Notification, Request, Response};
use lsp_types::{
    notification::{
        DidChangeTextDocument, DidCloseTextDocument, DidOpenTextDocument, DidSaveTextDocument,
        Notification as _,
    },
    request::{
        Completion, DocumentSymbolRequest, FoldingRangeRequest, GotoDefinition, HoverRequest,
        LinkedEditingRange, Request as _, SelectionRangeRequest, Shutdown,
    },
    DocumentSymbolParams, DocumentSymbolResponse, FoldingRangeParams,
    FoldingRangeProviderCapability, HoverProviderCapability, InitializeParams,
    LinkedEditingRangeParams, OneOf, SelectionRangeParams, SelectionRangeProviderCapability,
    ServerCapabilities, TextDocumentSyncCapability, TextDocumentSyncKind, Uri,
};
use tracing::{error, info, warn};
use tree_sitter::Tree;

use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::{LangId, TsParsers};
use crate::vfs::Vfs;

/// Convert `lsp_server::ErrorCode` to `i32`.
///
/// `ErrorCode` is `#[repr(i32)]` but doesn't implement `Into<i32>`.
/// The `lsp-server` crate itself uses `as i32` for this conversion.
#[expect(
    clippy::as_conversions,
    reason = "ErrorCode is #[repr(i32)]; this cast is lossless and well-defined"
)]
fn error_code_i32(code: lsp_server::ErrorCode) -> i32 {
    code as i32
}

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    info!("Forge LSP starting");

    match run_server() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("Forge LSP exited with error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run_server() -> Result<()> {
    let (connection, io_threads) = Connection::stdio();

    let server_capabilities = build_capabilities();
    let capabilities_json =
        serde_json::to_value(server_capabilities).context("serialize capabilities")?;

    let init_params = connection.initialize(capabilities_json)?;
    let init_params: InitializeParams =
        serde_json::from_value(init_params).context("deserialize InitializeParams")?;

    let workspace_root = init_params
        .workspace_folders
        .as_ref()
        .and_then(|folders| folders.first())
        .and_then(|folder| {
            folder
                .uri
                .as_str()
                .strip_prefix("file://")
                .map(PathBuf::from)
        })
        .or_else(|| {
            #[expect(deprecated, reason = "root_uri is the LSP 3.16 fallback when workspace_folders is absent")]
            let root = init_params.root_uri.as_ref();
            root.and_then(|uri| uri.as_str().strip_prefix("file://").map(PathBuf::from))
        });

    let forge_config = if let Some(ref root) = workspace_root {
        config::load_config(root)?
    } else {
        info!("No workspace root — using default configuration");
        config::ForgeConfig::default()
    };

    info!(
        "Forge LSP initialized (log_level={}, debounce_ms={})",
        forge_config.server.log_level, forge_config.server.debounce_ms
    );

    // Create tokio runtime for async sidecar IPC.
    let runtime = tokio::runtime::Runtime::new().context("create tokio runtime")?;

    // Initialize C# sidecar manager if enabled and workspace root is available.
    let csharp_sidecar = if forge_config.csharp.enabled {
        workspace_root
            .as_ref()
            .map(|root| Arc::new(SidecarManager::csharp(root)))
    } else {
        None
    };

    // Eagerly open the workspace in the sidecar and start health monitoring.
    // All sidecar operations must run inside the tokio runtime context.
    if let (Some(ref sidecar), Some(ref root)) = (&csharp_sidecar, &workspace_root) {
        let sidecar_clone = Arc::clone(sidecar);
        let root_str = root.to_string_lossy().to_string();
        runtime.spawn(async move {
            if let Err(err) = open_workspace(&sidecar_clone, &root_str).await {
                error!("Failed to open workspace in sidecar: {err:#}");
            }
        });
        let health_sidecar = Arc::clone(sidecar);
        runtime.spawn(async move {
            health_sidecar.start_health_monitor().await;
        });
    }

    main_loop(&connection, &runtime, csharp_sidecar.as_ref())?;

    // Shut down sidecar gracefully.
    if let Some(ref sidecar) = csharp_sidecar {
        let sidecar_clone = Arc::clone(sidecar);
        runtime.block_on(async move { sidecar_clone.shutdown().await });
    }

    // Drop the connection so the writer thread's channel closes,
    // allowing io_threads.join() to complete.
    drop(connection);
    io_threads.join()?;
    info!("Forge LSP shut down cleanly");
    Ok(())
}

fn build_capabilities() -> ServerCapabilities {
    ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
        document_symbol_provider: Some(OneOf::Left(true)),
        folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
        selection_range_provider: Some(SelectionRangeProviderCapability::Simple(true)),
        linked_editing_range_provider: Some(
            lsp_types::LinkedEditingRangeServerCapabilities::Simple(true),
        ),
        completion_provider: Some(lsp_types::CompletionOptions::default()),
        hover_provider: Some(HoverProviderCapability::Simple(true)),
        definition_provider: Some(OneOf::Left(true)),
        ..ServerCapabilities::default()
    }
}

/// Open the workspace in the sidecar.
async fn open_workspace(sidecar: &SidecarManager, root: &str) -> Result<()> {
    let payload = rmp_serde::to_vec(root).context("serialize workspace path")?;
    sidecar.request("workspace/open", payload).await?;
    info!("Workspace opened in C# sidecar");
    Ok(())
}

// ── Main Loop ─────────────────────────────────────────────────────

#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
fn main_loop(
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<()> {
    let vfs = Vfs::new();
    let parsers = TsParsers::new();
    let mut trees: HashMap<Uri, Tree> = HashMap::new();
    let mut shutdown_requested = false;

    for msg in &connection.receiver {
        match msg {
            Message::Request(req) => {
                if shutdown_requested {
                    let resp = Response::new_err(
                        req.id,
                        error_code_i32(lsp_server::ErrorCode::InvalidRequest),
                        "server is shutting down".to_string(),
                    );
                    connection.sender.send(Message::Response(resp))?;
                    continue;
                }

                if req.method == Shutdown::METHOD {
                    info!("Shutdown request received");
                    shutdown_requested = true;
                    let resp = Response::new_ok(req.id, serde_json::Value::Null);
                    connection.sender.send(Message::Response(resp))?;
                    continue;
                }

                handle_request(
                    req, &vfs, &parsers, &trees, connection,
                    runtime, csharp_sidecar,
                )?;
            }
            Message::Notification(notif) => {
                if notif.method == "exit" {
                    info!("Exit notification received");
                    return Ok(());
                }
                handle_notification(notif, &vfs, &parsers, &mut trees);
            }
            Message::Response(_) => {
                // We don't send requests to the client yet.
            }
        }
    }

    Ok(())
}

// ── Request Handling ──────────────────────────────────────────────

#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn handle_request(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<()> {
    let id = req.id.clone();

    let result = match req.method.as_str() {
        // Syntax-only (tree-sitter, Rust)
        DocumentSymbolRequest::METHOD => handle_document_symbols(req, vfs, parsers, trees),
        FoldingRangeRequest::METHOD => handle_folding_ranges(req, vfs, parsers, trees),
        SelectionRangeRequest::METHOD => handle_selection_ranges(req, vfs, parsers, trees),
        LinkedEditingRange::METHOD => handle_linked_editing_range(req, vfs, parsers, trees),
        // Semantic (sidecar)
        Completion::METHOD => semantic::handle_completion(req, runtime, csharp_sidecar),
        HoverRequest::METHOD => semantic::handle_hover(req, runtime, csharp_sidecar),
        GotoDefinition::METHOD => semantic::handle_definition(req, runtime, csharp_sidecar),
        // Custom requests
        "forge/workspaceSymbols" => handle_workspace_symbols(req, parsers),
        _ => {
            warn!("Unhandled request: {}", req.method);
            Err(anyhow::anyhow!("method not found"))
        }
    };

    let resp = match result {
        Ok(value) => Response::new_ok(id, value),
        Err(e) => Response::new_err(
            id,
            error_code_i32(lsp_server::ErrorCode::InternalError),
            format!("{e:#}"),
        ),
    };
    connection.sender.send(Message::Response(resp))?;
    Ok(())
}

#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn handle_document_symbols(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<serde_json::Value> {
    let params: DocumentSymbolParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document.uri;

    let source = vfs.get_content(uri).context("document not found in VFS")?;

    let tree = get_or_parse_tree(uri, &source, parsers, trees)?;
    let symbols = syntax::document_symbols(&tree, &source);
    let response = DocumentSymbolResponse::Nested(symbols);
    Ok(serde_json::to_value(response)?)
}

#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn handle_folding_ranges(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<serde_json::Value> {
    let params: FoldingRangeParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document.uri;

    let source = vfs.get_content(uri).context("document not found in VFS")?;

    let tree = get_or_parse_tree(uri, &source, parsers, trees)?;
    let ranges = syntax::folding_ranges(&tree, &source);
    Ok(serde_json::to_value(ranges)?)
}

#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn handle_selection_ranges(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<serde_json::Value> {
    let params: SelectionRangeParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document.uri;

    let source = vfs.get_content(uri).context("document not found in VFS")?;

    let tree = get_or_parse_tree(uri, &source, parsers, trees)?;
    let ranges = syntax::selection_ranges(&tree, &source, &params.positions);
    Ok(serde_json::to_value(ranges)?)
}

#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn handle_linked_editing_range(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<serde_json::Value> {
    let params: LinkedEditingRangeParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document_position_params.text_document.uri;

    let source = vfs.get_content(uri).context("document not found in VFS")?;

    let tree = get_or_parse_tree(uri, &source, parsers, trees)?;
    let position = params.text_document_position_params.position;
    let result = syntax::linked_editing_ranges(&tree, &source, position);
    Ok(serde_json::to_value(result)?)
}

/// Get a cached tree or parse fresh.
#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn get_or_parse_tree(
    uri: &Uri,
    source: &str,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<Tree> {
    let lang = LangId::from_uri(uri).context("unsupported file type")?;
    let old_tree = trees.get(uri);
    parsers.parse(lang, source, old_tree)
}

// ── Custom Request Handling ───────────────────────────────────────

fn handle_workspace_symbols(
    req: Request,
    parsers: &TsParsers,
) -> Result<serde_json::Value> {
    let params: workspace_symbols::WorkspaceSymbolsParams =
        serde_json::from_value(req.params)?;
    let response = workspace_symbols::handle(&params, parsers)?;
    Ok(serde_json::to_value(response)?)
}

// ── Notification Handling ─────────────────────────────────────────

#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn handle_notification(
    notif: Notification,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &mut HashMap<Uri, Tree>,
) {
    match notif.method.as_str() {
        DidOpenTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidOpenTextDocumentParams>(notif.params)
            {
                let doc = &params.text_document;
                info!("Opened: {}", doc.uri.as_str());
                vfs.open(doc.uri.clone(), doc.version, doc.text.clone());
                reparse(parsers, trees, &doc.uri, &doc.text);
            }
        }
        DidChangeTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidChangeTextDocumentParams>(notif.params)
            {
                let uri = &params.text_document.uri;
                // Full sync — last content change is the full text.
                if let Some(change) = params.content_changes.into_iter().next_back() {
                    vfs.change(uri, params.text_document.version, change.text.clone());
                    reparse(parsers, trees, uri, &change.text);
                }
            }
        }
        DidSaveTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidSaveTextDocumentParams>(notif.params)
            {
                info!("Saved: {}", params.text_document.uri.as_str());
            }
        }
        DidCloseTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidCloseTextDocumentParams>(notif.params)
            {
                info!("Closed: {}", params.text_document.uri.as_str());
                vfs.close(&params.text_document.uri);
                trees.remove(&params.text_document.uri);
            }
        }
        _ => {
            // Ignore unknown notifications per LSP spec.
        }
    }
}

/// Re-parse a document with tree-sitter and cache the result.
#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn reparse(parsers: &TsParsers, trees: &mut HashMap<Uri, Tree>, uri: &Uri, source: &str) {
    let Some(lang) = LangId::from_uri(uri) else {
        return;
    };
    let old_tree = trees.get(uri);
    match parsers.parse(lang, source, old_tree) {
        Ok(tree) => {
            trees.insert(uri.clone(), tree);
        }
        Err(e) => {
            warn!("tree-sitter parse failed for {}: {e:#}", uri.as_str());
        }
    }
}
