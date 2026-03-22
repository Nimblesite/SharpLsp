//! Forge LSP Server — main entry point.
//!
//! Implements LSP 3.17 lifecycle over stdio using `lsp-server`.

mod config;
mod diagnostics;
mod handlers;
mod hover_cache;
mod nav_cache;
mod profiler;
mod semantic;
mod sidecar;
mod sort_members;
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
        Completion, DocumentSymbolRequest, FoldingRangeRequest, GotoDeclaration, GotoDefinition,
        GotoImplementation, GotoTypeDefinition, HoverRequest, LinkedEditingRange, Request as _,
        SelectionRangeRequest, Shutdown,
    },
    FoldingRangeProviderCapability, HoverProviderCapability, InitializeParams, OneOf,
    SelectionRangeProviderCapability, ServerCapabilities, TextDocumentSyncCapability,
    TextDocumentSyncKind, Uri,
};
use tracing::{error, info, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
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
    let log_dir = std::env::temp_dir().join("forge-lsp-logs");
    let file_appender = tracing_appender::rolling::daily(&log_dir, "forge-lsp.log");
    let (file_writer, _guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(true),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(file_writer)
                .json(),
        )
        .init();

    info!(log_path = %log_dir.display(), "Forge LSP starting");

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
            #[expect(
                deprecated,
                reason = "root_uri is the LSP 3.16 fallback when workspace_folders is absent"
            )]
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

    // Apply profiler config.
    profiler::session::set_max_sessions(forge_config.profiler.max_concurrent_sessions);

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

    // Initialize F# sidecar manager if enabled and workspace root is available.
    let fsharp_sidecar = if forge_config.fsharp.enabled {
        workspace_root
            .as_ref()
            .map(|root| Arc::new(SidecarManager::fsharp(root)))
    } else {
        None
    };

    // Eagerly open workspaces in sidecars, then start health monitoring.
    // Health monitoring must wait until workspace/open completes — otherwise the
    // health check can time out on the transport lock (held by workspace/open),
    // declare a false crash, and kill the sidecar before the solution is loaded.
    start_csharp_sidecar(
        csharp_sidecar.as_ref(),
        workspace_root.as_ref(),
        &forge_config,
        &connection,
        &runtime,
    );
    start_sidecar(fsharp_sidecar.as_ref(), workspace_root.as_ref(), &runtime);

    main_loop(
        &connection,
        &runtime,
        &forge_config,
        csharp_sidecar.as_ref(),
        fsharp_sidecar.as_ref(),
    )?;

    // Shut down profiler sessions.
    profiler::session::store().shutdown();

    // Shut down sidecars gracefully.
    if let Some(ref sidecar) = csharp_sidecar {
        let sidecar_clone = Arc::clone(sidecar);
        runtime.block_on(async move { sidecar_clone.shutdown().await });
    }
    if let Some(ref sidecar) = fsharp_sidecar {
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
        type_definition_provider: Some(lsp_types::TypeDefinitionProviderCapability::Simple(true)),
        declaration_provider: Some(lsp_types::DeclarationCapability::Simple(true)),
        implementation_provider: Some(lsp_types::ImplementationProviderCapability::Simple(true)),
        diagnostic_provider: Some(lsp_types::DiagnosticServerCapabilities::Options(
            lsp_types::DiagnosticOptions {
                inter_file_dependencies: true,
                workspace_diagnostics: true,
                ..lsp_types::DiagnosticOptions::default()
            },
        )),
        ..ServerCapabilities::default()
    }
}

/// Open the workspace in a sidecar.
async fn open_workspace(sidecar: &SidecarManager, root: &str) -> Result<()> {
    let payload = rmp_serde::to_vec(root).context("serialize workspace path")?;
    sidecar.request("workspace/open", payload).await?;
    info!("Workspace opened in {} sidecar", sidecar.name());
    Ok(())
}

/// Start the C# sidecar: open workspace, trigger solution diagnostics, begin health monitoring.
fn start_csharp_sidecar(
    sidecar: Option<&Arc<SidecarManager>>,
    workspace_root: Option<&PathBuf>,
    forge_config: &config::ForgeConfig,
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
) {
    if let (Some(sidecar), Some(root)) = (sidecar, workspace_root) {
        let sc = Arc::clone(sidecar);
        let root_str = root.to_string_lossy().to_string();
        let solution_wide = forge_config.diagnostics.solution_wide_analysis;
        let project_filter = forge_config.diagnostics.project_filter.clone();
        let sender = connection.sender.clone();
        runtime.spawn(async move {
            if let Err(err) = open_workspace(&sc, &root_str).await {
                error!("Failed to open workspace in C# sidecar: {err:#}");
                return;
            }
            if solution_wide {
                info!("Starting solution-wide diagnostics scan");
                diagnostics::request_solution_in_background(
                    Arc::clone(&sc),
                    sender,
                    project_filter,
                );
            }
            sc.start_health_monitor().await;
        });
    }
}

/// Start a sidecar: open workspace and begin health monitoring.
fn start_sidecar(
    sidecar: Option<&Arc<SidecarManager>>,
    workspace_root: Option<&PathBuf>,
    runtime: &tokio::runtime::Runtime,
) {
    if let (Some(sidecar), Some(root)) = (sidecar, workspace_root) {
        let sc = Arc::clone(sidecar);
        let root_str = root.to_string_lossy().to_string();
        runtime.spawn(async move {
            if let Err(err) = open_workspace(&sc, &root_str).await {
                error!("Failed to open workspace in sidecar: {err:#}");
                return;
            }
            sc.start_health_monitor().await;
        });
    }
}

// ── Main Loop ─────────────────────────────────────────────────────

#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
fn main_loop(
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    _forge_config: &config::ForgeConfig,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<()> {
    let vfs = Vfs::new();
    let parsers = TsParsers::new();
    let mut trees: HashMap<Uri, Tree> = HashMap::new();
    let mut nav_cache = nav_cache::NavCache::new();
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
                    req,
                    &vfs,
                    &parsers,
                    &trees,
                    &mut nav_cache,
                    connection,
                    runtime,
                    csharp_sidecar,
                    fsharp_sidecar,
                )?;
            }
            Message::Notification(notif) => {
                if notif.method == "exit" {
                    info!("Exit notification received");
                    return Ok(());
                }
                handle_notification(
                    notif,
                    &vfs,
                    &parsers,
                    &mut trees,
                    &mut nav_cache,
                    connection,
                    runtime,
                    csharp_sidecar,
                );
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
#[expect(
    clippy::too_many_arguments,
    reason = "dispatcher passes per-request context; extracting a struct adds indirection for no benefit"
)]
fn handle_request(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
    nav_cache: &mut nav_cache::NavCache,
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<()> {
    let id = req.id.clone();

    let result = match req.method.as_str() {
        // Syntax-only (tree-sitter, Rust)
        DocumentSymbolRequest::METHOD => {
            handlers::handle_document_symbols(req, vfs, parsers, trees)
        }
        FoldingRangeRequest::METHOD => handlers::handle_folding_ranges(req, vfs, parsers, trees),
        SelectionRangeRequest::METHOD => {
            handlers::handle_selection_ranges(req, vfs, parsers, trees)
        }
        LinkedEditingRange::METHOD => {
            handlers::handle_linked_editing_range(req, vfs, parsers, trees)
        }
        // Semantic (sidecar)
        Completion::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic::handle_completion(req, runtime, sidecar)
        }
        HoverRequest::METHOD => {
            if handlers::is_hover_on_comment(&req, trees) {
                Ok(serde_json::Value::Null)
            } else {
                let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
                semantic::handle_hover(req, runtime, sidecar)
            }
        }
        GotoDefinition::METHOD => {
            if handlers::is_non_symbol_position(&req, trees) {
                Ok(serde_json::Value::Null)
            } else {
                let (primary, fallback) = pick_sidecar_with_fallback(&req, csharp_sidecar, fsharp_sidecar);
                semantic::handle_definition(req, vfs, nav_cache, runtime, primary, fallback)
            }
        }
        GotoTypeDefinition::METHOD => {
            if handlers::is_non_symbol_position(&req, trees) {
                Ok(serde_json::Value::Null)
            } else {
                let (primary, fallback) = pick_sidecar_with_fallback(&req, csharp_sidecar, fsharp_sidecar);
                semantic::handle_type_definition(req, vfs, nav_cache, runtime, primary, fallback)
            }
        }
        GotoDeclaration::METHOD => {
            if handlers::is_non_symbol_position(&req, trees) {
                Ok(serde_json::Value::Null)
            } else {
                let (primary, fallback) = pick_sidecar_with_fallback(&req, csharp_sidecar, fsharp_sidecar);
                semantic::handle_declaration(req, vfs, nav_cache, runtime, primary, fallback)
            }
        }
        GotoImplementation::METHOD => {
            if handlers::is_non_symbol_position(&req, trees) {
                Ok(serde_json::Value::Null)
            } else {
                let (primary, fallback) = pick_sidecar_with_fallback(&req, csharp_sidecar, fsharp_sidecar);
                semantic::handle_implementation(req, runtime, primary, fallback)
            }
        }
        // Custom requests
        "forge/workspaceSymbols" => handle_workspace_symbols(req, parsers),
        "forge/sortMembers" => handle_sort_members(req, parsers),
        // Profiler requests
        "forge/profiler/listProcesses" => profiler::handlers::handle_list_processes(req),
        "forge/profiler/startTrace" => profiler::handlers::handle_start_trace(req),
        "forge/profiler/stopTrace" => profiler::handlers::handle_stop_trace(req),
        "forge/profiler/startCounters" => {
            profiler::handlers::handle_start_counters(req, connection.sender.clone())
        }
        "forge/profiler/stopCounters" => profiler::handlers::handle_stop_counters(req),
        "forge/profiler/collectDump" => {
            profiler::handlers::handle_collect_dump(req, runtime, connection.sender.clone())
        }
        "forge/profiler/analyzeHeap" => profiler::handlers::handle_analyze_heap(req, runtime),
        "forge/profiler/findGCRoots" => profiler::handlers::handle_find_gc_roots(req, runtime),
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

// ── Language-Based Sidecar Routing ────────────────────────────────

/// Pick the correct sidecar (C# or F#) based on the request's document URI.
fn pick_sidecar<'a>(
    req: &Request,
    csharp: Option<&'a Arc<SidecarManager>>,
    fsharp: Option<&'a Arc<SidecarManager>>,
) -> Option<&'a Arc<SidecarManager>> {
    let uri = extract_document_uri(req);
    match uri.and_then(|u| LangId::from_uri(&u)) {
        Some(LangId::FSharp) => fsharp,
        _ => csharp,
    }
}

/// Extract the document URI from a request's params (best-effort).
fn extract_document_uri(req: &Request) -> Option<Uri> {
    req.params
        .get("textDocument")
        .and_then(|td| td.get("uri"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uri>().ok())
}

// ── Custom Request Handling ───────────────────────────────────────

fn handle_workspace_symbols(req: Request, parsers: &TsParsers) -> Result<serde_json::Value> {
    let params: workspace_symbols::WorkspaceSymbolsParams = serde_json::from_value(req.params)?;
    let response = workspace_symbols::handle(&params, parsers)?;
    Ok(serde_json::to_value(response)?)
}

fn handle_sort_members(req: Request, parsers: &TsParsers) -> Result<serde_json::Value> {
    let params: sort_members::SortMembersParams = serde_json::from_value(req.params)?;
    let response = sort_members::handle(&params, parsers)?;
    Ok(serde_json::to_value(response)?)
}

// ── Notification Handling ─────────────────────────────────────────

#[expect(clippy::mutable_key_type, reason = "see main_loop")]
#[expect(
    clippy::too_many_arguments,
    reason = "dispatcher passes per-notification context; extracting a struct adds indirection for no benefit"
)]
fn handle_notification(
    notif: Notification,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &mut HashMap<Uri, Tree>,
    nav_cache: &mut nav_cache::NavCache,
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
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
                trigger_diagnostics(&doc.uri, runtime, csharp_sidecar, connection);
            }
        }
        DidChangeTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidChangeTextDocumentParams>(notif.params)
            {
                let uri = &params.text_document.uri;
                info!(
                    "Changed: {} (v{})",
                    uri.as_str(),
                    params.text_document.version
                );
                // Full sync — last content change is the full text.
                if let Some(change) = params.content_changes.into_iter().next_back() {
                    vfs.change(uri, params.text_document.version, change.text.clone());
                    reparse(parsers, trees, uri, &change.text);
                    nav_cache.invalidate(uri);
                    // Notify the sidecar so Roslyn sees the new source text.
                    if let Ok(file_path) = semantic::uri_to_path(uri) {
                        semantic::notify_did_change(
                            &file_path,
                            &change.text,
                            runtime,
                            csharp_sidecar,
                        );
                    }
                    trigger_diagnostics(uri, runtime, csharp_sidecar, connection);
                }
            }
        }
        DidSaveTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidSaveTextDocumentParams>(notif.params)
            {
                info!("Saved: {}", params.text_document.uri.as_str());
                trigger_diagnostics(
                    &params.text_document.uri,
                    runtime,
                    csharp_sidecar,
                    connection,
                );
            }
        }
        DidCloseTextDocument::METHOD => {
            if let Ok(params) =
                serde_json::from_value::<lsp_types::DidCloseTextDocumentParams>(notif.params)
            {
                info!("Closed: {}", params.text_document.uri.as_str());
                vfs.close(&params.text_document.uri);
                trees.remove(&params.text_document.uri);
                nav_cache.invalidate(&params.text_document.uri);
                if let Err(err) = diagnostics::clear(&connection.sender, params.text_document.uri) {
                    warn!("Failed to clear diagnostics: {err:#}");
                }
            }
        }
        _ => {
            // Ignore unknown notifications per LSP spec.
        }
    }
}

/// Spawn a background diagnostic request for the given URI.
fn trigger_diagnostics(
    uri: &Uri,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    connection: &Connection,
) {
    let Some(sidecar) = csharp_sidecar else {
        return;
    };
    let Ok(file_path) = semantic::uri_to_path(uri) else {
        return;
    };
    diagnostics::request_in_background(
        runtime,
        Arc::clone(sidecar),
        connection.sender.clone(),
        uri.clone(),
        file_path,
    );
}

/// Re-parse a document with tree-sitter and cache the result.
///
/// We always do a fresh parse (no old tree) because `textDocument/didChange`
/// with full sync replaces the entire document text. Passing a stale old tree
/// without calling `tree.edit()` causes tree-sitter to reuse invalid byte
/// ranges — producing wrong results for longer content and panicking
/// (index out of bounds) for shorter content.
#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn reparse(parsers: &TsParsers, trees: &mut HashMap<Uri, Tree>, uri: &Uri, source: &str) {
    let Some(lang) = LangId::from_uri(uri) else {
        return;
    };
    match parsers.parse(lang, source, None) {
        Ok(tree) => {
            trees.insert(uri.clone(), tree);
        }
        Err(e) => {
            // Remove stale tree so request handlers don't use a mismatched
            // old tree with the updated VFS content.
            trees.remove(uri);
            warn!("tree-sitter parse failed for {}: {e:#}", uri.as_str());
        }
    }
}
