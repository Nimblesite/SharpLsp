//! `SharpLsp` server — main entry point.
//!
//! Implements LSP 3.17 lifecycle over stdio using `lsp-server`.

mod call_hierarchy;
mod code_actions;
mod code_lens;
mod config;
mod diagnostics;
// Formatting module is sequestered — not wired into the LSP server.
// Use CSharpier (C#) / Fantomas via Ionide (F#). See docs/formatting/README.md.
#[cfg(feature = "formatting")]
mod formatting;
mod handlers;
mod inlay_hints;
mod nav_cache;
mod nuget;
mod postfix_completion;
mod profiler;
mod pull_diagnostics;
mod semantic;
mod semantic_tokens;
mod sidecar;
mod sort_members;
mod syntax;
mod tree_sitter_parse;
mod type_hierarchy;
mod utils;
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
        CallHierarchyIncomingCalls, CallHierarchyOutgoingCalls, CallHierarchyPrepare,
        CodeActionRequest, CodeActionResolveRequest, CodeLensRequest, Completion,
        DocumentDiagnosticRequest, DocumentHighlightRequest, DocumentSymbolRequest,
        FoldingRangeRequest, GotoDeclaration, GotoDefinition, GotoImplementation,
        GotoTypeDefinition, HoverRequest, InlayHintRequest, LinkedEditingRange,
        PrepareRenameRequest, References, Rename, Request as _, ResolveCompletionItem,
        SelectionRangeRequest, SemanticTokensFullDeltaRequest, SemanticTokensFullRequest,
        SemanticTokensRangeRequest, Shutdown, TypeHierarchyPrepare, TypeHierarchySubtypes,
        TypeHierarchySupertypes, WorkspaceDiagnosticRequest, WorkspaceSymbolRequest,
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
    // Implements [SWR-VERSION-RUST] — Shipwright binary version contract.
    let spec = shipwright::VersionSpec {
        name: "sharplsp",
        version: env!("CARGO_PKG_VERSION"),
        kind: shipwright_manifest::ExecutableKind::Lsp,
        language: shipwright_manifest::Language::Rust,
        product: Some("sharplsp"),
        capabilities: &[],
        build: shipwright::BuildInfo {
            git_sha: option_env!("GIT_SHA"),
            git_dirty: None,
            build_time: option_env!("BUILD_TIME"),
            target: Some(env!("TARGET")),
            toolchain: None,
        },
    };
    let args: Vec<String> = std::env::args().collect();
    match shipwright::dispatch(&args, &mut std::io::stdout(), &spec) {
        Ok(true) => return ExitCode::SUCCESS,
        Ok(false) => {}
        Err(e) => {
            eprintln!("version dispatch error: {e}");
            return ExitCode::FAILURE;
        }
    }

    let log_dir = std::env::temp_dir().join("sharplsp-logs");
    let file_appender = tracing_appender::rolling::daily(&log_dir, "sharplsp.log");
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

    info!(log_path = %log_dir.display(), "SharpLsp LSP starting");

    match run_server() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            error!("SharpLsp LSP exited with error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Initialize the LSP connection, start sidecars, and run the main message loop.
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

    let sharplsp_config = if let Some(ref root) = workspace_root {
        config::load_config(root)?
    } else {
        info!("No workspace root — using default configuration");
        config::SharpLspConfig::default()
    };

    info!(
        "SharpLsp LSP initialized (log_level={}, debounce_ms={})",
        sharplsp_config.server.log_level, sharplsp_config.server.debounce_ms
    );

    // Apply profiler config.
    profiler::session::set_max_sessions(sharplsp_config.profiler.max_concurrent_sessions);

    // Create tokio runtime for async sidecar IPC.
    let runtime = tokio::runtime::Runtime::new().context("create tokio runtime")?;

    // Shared VFS — created here so the solution-diagnostics verification pass
    // can consult it before re-syncing files from disk and clobbering live edits.
    let vfs = Arc::new(Vfs::new());

    // Initialize C# sidecar manager if enabled and workspace root is available.
    let csharp_sidecar = if sharplsp_config.csharp.enabled {
        workspace_root
            .as_ref()
            .map(|root| Arc::new(SidecarManager::csharp(root)))
    } else {
        None
    };

    // Initialize F# sidecar manager if enabled and workspace root is available.
    let fsharp_sidecar = if sharplsp_config.fsharp.enabled {
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
    start_sidecar(
        csharp_sidecar.as_ref(),
        workspace_root.as_ref(),
        Some((&sharplsp_config.diagnostics, &connection)),
        &runtime,
        Arc::clone(&vfs),
    );
    start_sidecar(
        fsharp_sidecar.as_ref(),
        workspace_root.as_ref(),
        None,
        &runtime,
        Arc::clone(&vfs),
    );

    main_loop(
        &connection,
        &runtime,
        &sharplsp_config,
        csharp_sidecar.as_ref(),
        fsharp_sidecar.as_ref(),
        &vfs,
    )?;

    // Shut down profiler sessions.
    profiler::session::store().shutdown();

    // Shut down sidecars gracefully (in parallel to avoid doubling timeout).
    runtime.block_on(async {
        let cs = async {
            if let Some(ref sidecar) = csharp_sidecar {
                sidecar.shutdown().await;
            }
        };
        let fs = async {
            if let Some(ref sidecar) = fsharp_sidecar {
                sidecar.shutdown().await;
            }
        };
        tokio::join!(cs, fs);
    });

    // Drop the connection so the writer thread's channel closes,
    // allowing io_threads.join() to complete.
    drop(connection);
    io_threads.join()?;
    info!("SharpLsp LSP shut down cleanly");
    Ok(())
}

/// Build the server capabilities advertised during LSP initialization.
fn build_capabilities() -> ServerCapabilities {
    ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
        document_symbol_provider: Some(OneOf::Left(true)),
        folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
        selection_range_provider: Some(SelectionRangeProviderCapability::Simple(true)),
        linked_editing_range_provider: Some(
            lsp_types::LinkedEditingRangeServerCapabilities::Simple(true),
        ),
        completion_provider: Some(lsp_types::CompletionOptions {
            resolve_provider: Some(true),
            ..lsp_types::CompletionOptions::default()
        }),
        hover_provider: Some(HoverProviderCapability::Simple(true)),
        definition_provider: Some(OneOf::Left(true)),
        type_definition_provider: Some(lsp_types::TypeDefinitionProviderCapability::Simple(true)),
        declaration_provider: Some(lsp_types::DeclarationCapability::Simple(true)),
        implementation_provider: Some(lsp_types::ImplementationProviderCapability::Simple(true)),
        references_provider: Some(OneOf::Left(true)),
        rename_provider: Some(OneOf::Right(lsp_types::RenameOptions {
            prepare_provider: Some(true),
            work_done_progress_options: lsp_types::WorkDoneProgressOptions::default(),
        })),
        document_highlight_provider: Some(OneOf::Left(true)),
        code_action_provider: Some(lsp_types::CodeActionProviderCapability::Options(
            lsp_types::CodeActionOptions {
                code_action_kinds: Some(vec![
                    lsp_types::CodeActionKind::QUICKFIX,
                    lsp_types::CodeActionKind::REFACTOR,
                    lsp_types::CodeActionKind::REFACTOR_EXTRACT,
                    lsp_types::CodeActionKind::REFACTOR_INLINE,
                    lsp_types::CodeActionKind::REFACTOR_REWRITE,
                    lsp_types::CodeActionKind::SOURCE_ORGANIZE_IMPORTS,
                ]),
                resolve_provider: Some(true),
                ..lsp_types::CodeActionOptions::default()
            },
        )),
        // Formatting is intentionally disabled. Use CSharpier (C#) / Fantomas via Ionide (F#).
        // See docs/formatting/README.md for details on the sequestered formatter code.
        document_formatting_provider: None,
        document_range_formatting_provider: None,
        document_on_type_formatting_provider: None,
        semantic_tokens_provider: Some(
            lsp_types::SemanticTokensServerCapabilities::SemanticTokensOptions(
                lsp_types::SemanticTokensOptions {
                    legend: lsp_types::SemanticTokensLegend {
                        token_types: semantic_tokens::token_types(),
                        token_modifiers: semantic_tokens::token_modifiers(),
                    },
                    full: Some(lsp_types::SemanticTokensFullOptions::Delta { delta: Some(true) }),
                    range: Some(true),
                    ..lsp_types::SemanticTokensOptions::default()
                },
            ),
        ),
        inlay_hint_provider: Some(OneOf::Left(true)),
        workspace_symbol_provider: Some(OneOf::Left(true)),
        call_hierarchy_provider: Some(lsp_types::CallHierarchyServerCapability::Simple(true)),
        code_lens_provider: Some(lsp_types::CodeLensOptions {
            resolve_provider: Some(false),
        }),
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
    let _ = sidecar.request("workspace/open", payload).await?;
    info!("Workspace opened in {} sidecar", sidecar.name());
    Ok(())
}

/// Start a sidecar: open workspace, optionally trigger solution diagnostics, begin health monitoring.
fn start_sidecar(
    sidecar: Option<&Arc<SidecarManager>>,
    workspace_root: Option<&PathBuf>,
    diagnostics_cfg: Option<(&config::DiagnosticsConfig, &Connection)>,
    runtime: &tokio::runtime::Runtime,
    vfs: Arc<Vfs>,
) {
    if let (Some(sidecar), Some(root)) = (sidecar, workspace_root) {
        let sc = Arc::clone(sidecar);
        let root_str = root.to_string_lossy().to_string();
        let diag = diagnostics_cfg.and_then(|(cfg, conn)| {
            cfg.solution_wide_analysis
                .then(|| (conn.sender.clone(), cfg.project_filter.clone()))
        });
        drop(runtime.spawn(async move {
            if let Err(err) = open_workspace(&sc, &root_str).await {
                error!("Failed to open workspace in sidecar: {err:#}");
                return;
            }
            if let Some((sender, project_filter)) = diag {
                info!("Starting solution-wide diagnostics scan");
                diagnostics::request_solution_in_background(
                    Arc::clone(&sc),
                    sender,
                    project_filter,
                    vfs,
                );
            }
            sc.start_health_monitor().await;
        }));
    }
}

// ── Main Loop ─────────────────────────────────────────────────────

#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
/// Process LSP messages until the connection closes or exit is received.
fn main_loop(
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    _sharplsp_config: &config::SharpLspConfig,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    vfs: &Arc<Vfs>,
) -> Result<()> {
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
                    vfs,
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
                    vfs,
                    &parsers,
                    &mut trees,
                    &mut nav_cache,
                    connection,
                    runtime,
                    csharp_sidecar,
                    fsharp_sidecar,
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

/// Dispatch an incoming LSP request to the appropriate handler.
#[expect(clippy::mutable_key_type, reason = "see main_loop")]
#[expect(
    clippy::too_many_arguments,
    reason = "dispatcher passes per-request context; extracting a struct adds indirection for no benefit"
)]
#[expect(
    clippy::too_many_lines,
    reason = "match dispatch table is inherently long; splitting it would hurt readability"
)]
fn handle_request(
    req: Request,
    vfs: &Arc<Vfs>,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
    nav_cache: &mut nav_cache::NavCache,
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<()> {
    let id = req.id.clone();
    let method = req.method.clone();

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
            semantic::handle_completion(req, runtime, sidecar, vfs)
        }
        ResolveCompletionItem::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic::handle_completion_resolve(req, runtime, sidecar)
        }
        HoverRequest::METHOD => {
            if handlers::is_hover_on_comment(&req, trees) {
                info!("Hover: skipped (comment position)");
                Ok(serde_json::Value::Null)
            } else {
                let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
                semantic::handle_hover(req, vfs, nav_cache, runtime, sidecar)
            }
        }
        GotoDefinition::METHOD
        | GotoTypeDefinition::METHOD
        | GotoDeclaration::METHOD
        | GotoImplementation::METHOD
        | References::METHOD
        | DocumentHighlightRequest::METHOD => handle_nav_request(
            req,
            vfs,
            trees,
            nav_cache,
            runtime,
            csharp_sidecar,
            fsharp_sidecar,
        ),
        // Formatting intentionally disabled — use CSharpier (C#) / Fantomas via Ionide (F#).
        // Handler code is sequestered in src/formatting.rs (see docs/formatting/README.md).
        // Semantic tokens
        SemanticTokensFullRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic_tokens::handle_full(req, runtime, sidecar)
        }
        SemanticTokensRangeRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic_tokens::handle_range(req, runtime, sidecar)
        }
        SemanticTokensFullDeltaRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic_tokens::handle_delta(req, runtime, sidecar)
        }
        // Inlay hints
        InlayHintRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            inlay_hints::handle_inlay_hint(req, runtime, sidecar, vfs)
        }
        // Code lens
        CodeLensRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            code_lens::handle_code_lens(req, runtime, sidecar)
        }
        // Rename — Implements [RENAME-PREPARE] and [RENAME-APPLY]
        PrepareRenameRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic::handle_prepare_rename(req, runtime, sidecar)
        }
        Rename::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic::handle_rename(req, runtime, sidecar)
        }
        // Call hierarchy
        CallHierarchyPrepare::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            call_hierarchy::handle_prepare(req, runtime, sidecar)
        }
        CallHierarchyIncomingCalls::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            call_hierarchy::handle_incoming(req, runtime, sidecar)
        }
        CallHierarchyOutgoingCalls::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            call_hierarchy::handle_outgoing(req, runtime, sidecar)
        }
        // Type hierarchy
        TypeHierarchyPrepare::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            type_hierarchy::handle_prepare(req, runtime, sidecar)
        }
        TypeHierarchySupertypes::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            type_hierarchy::handle_supertypes(req, runtime, sidecar)
        }
        TypeHierarchySubtypes::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            type_hierarchy::handle_subtypes(req, runtime, sidecar)
        }
        // Code actions
        CodeActionRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            code_actions::handle_code_action(req, runtime, sidecar)
        }
        CodeActionResolveRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            code_actions::handle_code_action_resolve(req, runtime, sidecar)
        }
        // Pull diagnostics (LSP 3.17)
        DocumentDiagnosticRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            pull_diagnostics::handle_document_diagnostic(req, runtime, sidecar)
        }
        WorkspaceDiagnosticRequest::METHOD => pull_diagnostics::handle_workspace_diagnostic(req),
        // Standard workspace/symbol
        WorkspaceSymbolRequest::METHOD => handle_standard_workspace_symbol(req, parsers, vfs),
        // Solution loading
        "sharplsp/loadSolution" => handle_load_solution(
            req,
            runtime,
            csharp_sidecar,
            fsharp_sidecar,
            connection,
            vfs,
        ),
        _ => handle_custom_request(
            req,
            parsers,
            vfs,
            connection,
            runtime,
            csharp_sidecar,
            fsharp_sidecar,
        ),
    };

    let resp = match result {
        Ok(value) => Response::new_ok(id, value),
        Err(e) => {
            error!(method = %method, "Request failed: {e:#}");
            Response::new_err(
                id,
                error_code_i32(lsp_server::ErrorCode::InternalError),
                format!("{e:#}"),
            )
        }
    };
    connection.sender.send(Message::Response(resp))?;
    Ok(())
}

// ── Navigation Request Dispatch ───────────────────────────────────

/// Route navigation requests (definition, typeDefinition, declaration,
/// implementation, references, documentHighlight) with tree-sitter
/// pre-validation and cross-language fallback.
#[expect(clippy::mutable_key_type, reason = "see main_loop")]
fn handle_nav_request(
    req: Request,
    vfs: &Vfs,
    trees: &HashMap<Uri, Tree>,
    nav_cache: &mut nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    if handlers::is_non_symbol_position(&req, trees) {
        return Ok(serde_json::Value::Null);
    }
    let (primary, fallback) = pick_sidecar_with_fallback(&req, csharp_sidecar, fsharp_sidecar);
    match req.method.as_str() {
        GotoDefinition::METHOD => {
            semantic::handle_definition(req, vfs, nav_cache, runtime, primary, fallback)
        }
        GotoTypeDefinition::METHOD => {
            semantic::handle_type_definition(req, vfs, nav_cache, runtime, primary, fallback)
        }
        GotoDeclaration::METHOD => {
            semantic::handle_declaration(req, vfs, nav_cache, runtime, primary, fallback)
        }
        GotoImplementation::METHOD => {
            semantic::handle_implementation(req, runtime, primary, fallback)
        }
        References::METHOD => {
            semantic::handle_references(req, vfs, nav_cache, runtime, primary, fallback)
        }
        DocumentHighlightRequest::METHOD => {
            semantic::handle_document_highlight(req, vfs, nav_cache, runtime, primary)
        }
        _ => Err(anyhow::anyhow!("unexpected nav method: {}", req.method)),
    }
}

/// Route custom and profiler requests.
fn handle_custom_request(
    req: Request,
    parsers: &TsParsers,
    vfs: &Vfs,
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    match req.method.as_str() {
        "sharplsp/workspaceSymbols" => handle_workspace_symbols(
            req,
            parsers,
            vfs,
            runtime,
            csharp_sidecar.or(fsharp_sidecar),
        ),
        "sharplsp/sortMembers" => handle_sort_members(req, parsers),
        // NuGet package management
        "sharplsp/nuget/targets" => nuget::handlers::handle_targets(req),
        "sharplsp/nuget/search" => nuget::handlers::handle_search(req, runtime),
        "sharplsp/nuget/versions" => nuget::handlers::handle_versions(req, runtime),
        "sharplsp/nuget/installed" => nuget::handlers::handle_installed(req, runtime),
        "sharplsp/nuget/install" => {
            nuget::handlers::handle_install(req, runtime, connection.sender.clone())
        }
        "sharplsp/nuget/uninstall" => {
            nuget::handlers::handle_uninstall(req, runtime, connection.sender.clone())
        }
        // Profiler
        "sharplsp/profiler/listProcesses" => profiler::handlers::handle_list_processes(req),
        "sharplsp/profiler/startTrace" => profiler::handlers::handle_start_trace(req),
        "sharplsp/profiler/stopTrace" => profiler::handlers::handle_stop_trace(req),
        "sharplsp/profiler/convertTrace" => profiler::handlers::handle_convert_trace(req),
        "sharplsp/profiler/startCounters" => {
            profiler::handlers::handle_start_counters(req, connection.sender.clone())
        }
        "sharplsp/profiler/stopCounters" => profiler::handlers::handle_stop_counters(req),
        "sharplsp/profiler/collectDump" => {
            profiler::handlers::handle_collect_dump(req, runtime, connection.sender.clone())
        }
        "sharplsp/profiler/analyzeHeap" => profiler::handlers::handle_analyze_heap(req, runtime),
        "sharplsp/profiler/findGCRoots" => profiler::handlers::handle_find_gc_roots(req, runtime),
        "sharplsp/profiler/inspectObject" => {
            profiler::handlers::handle_inspect_object(req, runtime)
        }
        "sharplsp/profiler/diffHeapSnapshots" => {
            profiler::handlers::handle_diff_heap_snapshots(req, runtime)
        }
        "sharplsp/profiler/getObjectGraph" => {
            profiler::handlers::handle_get_object_graph(req, runtime)
        }
        _ => {
            warn!("Unhandled request: {}", req.method);
            Err(anyhow::anyhow!("method not found"))
        }
    }
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

/// Pick primary + fallback sidecar for cross-language navigation.
///
/// Primary is chosen by document language. Fallback is the other sidecar,
/// used when the primary can't resolve the symbol (cross-language reference).
fn pick_sidecar_with_fallback<'a>(
    req: &Request,
    csharp: Option<&'a Arc<SidecarManager>>,
    fsharp: Option<&'a Arc<SidecarManager>>,
) -> (
    Option<&'a Arc<SidecarManager>>,
    Option<&'a Arc<SidecarManager>>,
) {
    let uri = extract_document_uri(req);
    match uri.and_then(|u| LangId::from_uri(&u)) {
        Some(LangId::FSharp) => (fsharp, csharp),
        _ => (csharp, fsharp),
    }
}

/// Extract the document URI from a request's params (best-effort).
///
/// Checks `params.textDocument.uri` first, then falls back to `params.data.uri`
/// for code action resolve requests where the URI is embedded in the data field.
fn extract_document_uri(req: &Request) -> Option<Uri> {
    req.params
        .get("textDocument")
        .and_then(|td| td.get("uri"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uri>().ok())
        .or_else(|| {
            req.params
                .get("data")
                .and_then(|d| d.get("uri"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<Uri>().ok())
        })
}

// ── Solution Loading ─────────────────────────────────────────────

/// Handle `sharplsp/loadSolution` — reload sidecars with an explicit solution file path.
///
/// The extension sends this when the user selects a solution. Without it,
/// the sidecar receives only the workspace root and picks an arbitrary solution
/// from recursive search, which breaks hover/definition/etc.
fn handle_load_solution(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    connection: &Connection,
    vfs: &Arc<Vfs>,
) -> Result<serde_json::Value> {
    let params: serde_json::Value = serde_json::from_value(req.params)?;
    let sln_path = params
        .get("solutionPath")
        .and_then(|v| v.as_str())
        .context("sharplsp/loadSolution requires { solutionPath: string }")?;

    info!("Loading solution: {sln_path}");

    let payload = rmp_serde::to_vec(sln_path).context("serialize solution path")?;

    if let Some(cs) = csharp_sidecar {
        let cs = Arc::clone(cs);
        let p = payload.clone();
        let sender = connection.sender.clone();
        let vfs_for_diagnostics = Arc::clone(vfs);
        drop(runtime.spawn(async move {
            match cs.request("workspace/open", p).await {
                Ok(_) => {
                    info!("Solution loaded in C# (Roslyn) sidecar");
                    diagnostics::request_solution_in_background(
                        cs,
                        sender,
                        vec![],
                        vfs_for_diagnostics,
                    );
                }
                Err(err) => error!("C# sidecar workspace/open failed: {err:#}"),
            }
        }));
    }

    if let Some(fs) = fsharp_sidecar {
        let fs = Arc::clone(fs);
        let p = payload;
        drop(runtime.spawn(async move {
            match fs.request("workspace/open", p).await {
                Ok(_) => info!("Solution loaded in F# (FCS) sidecar"),
                Err(err) => error!("F# sidecar workspace/open failed: {err:#}"),
            }
        }));
    }

    Ok(serde_json::json!({ "success": true }))
}

// ── Custom Request Handling ───────────────────────────────────────

/// Handle the custom `sharplsp/workspaceSymbols` request.
fn handle_workspace_symbols(
    req: Request,
    parsers: &TsParsers,
    vfs: &Vfs,
    runtime: &tokio::runtime::Runtime,
    solution_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: workspace_symbols::WorkspaceSymbolsParams = serde_json::from_value(req.params)?;
    let response = workspace_symbols::handle(&params, parsers, vfs, runtime, solution_sidecar)?;
    Ok(serde_json::to_value(response)?)
}

/// Standard `workspace/symbol` handler using tree-sitter to find symbols matching a query.
fn handle_standard_workspace_symbol(
    req: Request,
    parsers: &TsParsers,
    vfs: &Vfs,
) -> Result<serde_json::Value> {
    let params: lsp_types::WorkspaceSymbolParams = serde_json::from_value(req.params)?;
    let query = params.query.to_lowercase();

    // Reuse the existing workspace symbols infrastructure.
    // Get all files from the VFS and search for matching symbols.
    let mut symbols = Vec::new();
    for entry in vfs.iter() {
        let uri = entry.key().clone();
        let content = entry.value().content.clone();
        let Some(lang) = LangId::from_uri(&uri) else {
            continue;
        };
        if let Ok(tree) = parsers.parse(lang, &content, None) {
            collect_matching_symbols(&uri, &tree, &content, &query, &mut symbols);
        }
    }

    Ok(serde_json::to_value(symbols)?)
}

/// Collect symbols from a tree that match the query string.
fn collect_matching_symbols(
    uri: &Uri,
    tree: &tree_sitter::Tree,
    source: &str,
    query: &str,
    symbols: &mut Vec<lsp_types::SymbolInformation>,
) {
    let root = tree.root_node();
    collect_symbols_recursive(uri, root, source.as_bytes(), query, symbols);
}

/// Recursively walk tree-sitter nodes and collect matching workspace symbols.
fn collect_symbols_recursive(
    uri: &Uri,
    node: tree_sitter::Node<'_>,
    source: &[u8],
    query: &str,
    symbols: &mut Vec<lsp_types::SymbolInformation>,
) {
    let kind = match node.kind() {
        "class_declaration" | "record_declaration" | "type_definition" => {
            Some(lsp_types::SymbolKind::CLASS)
        }
        "struct_declaration" => Some(lsp_types::SymbolKind::STRUCT),
        "interface_declaration" => Some(lsp_types::SymbolKind::INTERFACE),
        "enum_declaration" => Some(lsp_types::SymbolKind::ENUM),
        "method_declaration" | "local_function_statement" => Some(lsp_types::SymbolKind::METHOD),
        "property_declaration" => Some(lsp_types::SymbolKind::PROPERTY),
        "field_declaration" => Some(lsp_types::SymbolKind::FIELD),
        "constructor_declaration" => Some(lsp_types::SymbolKind::CONSTRUCTOR),
        "event_declaration" => Some(lsp_types::SymbolKind::EVENT),
        "delegate_declaration" | "value_declaration" | "function_or_value_defn" => {
            Some(lsp_types::SymbolKind::FUNCTION)
        }
        "enum_member_declaration" => Some(lsp_types::SymbolKind::ENUM_MEMBER),
        "namespace_declaration" | "file_scoped_namespace_declaration" => {
            Some(lsp_types::SymbolKind::NAMESPACE)
        }
        "module_defn" => Some(lsp_types::SymbolKind::MODULE),
        _ => None,
    };

    if let Some(symbol_kind) = kind {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = name_node.utf8_text(source).unwrap_or_default();
            let matches = query.is_empty() || fuzzy_match_subsequence(&name.to_lowercase(), query);
            if matches {
                let start = node.start_position();
                let end = node.end_position();
                #[expect(
                    deprecated,
                    reason = "SymbolInformation is the LSP 3.17 workspace/symbol response type"
                )]
                symbols.push(lsp_types::SymbolInformation {
                    name: name.to_string(),
                    kind: symbol_kind,
                    tags: None,
                    deprecated: None,
                    location: lsp_types::Location {
                        uri: uri.clone(),
                        range: lsp_types::Range::new(
                            lsp_types::Position::new(
                                u32::try_from(start.row).unwrap_or(0),
                                u32::try_from(start.column).unwrap_or(0),
                            ),
                            lsp_types::Position::new(
                                u32::try_from(end.row).unwrap_or(0),
                                u32::try_from(end.column).unwrap_or(0),
                            ),
                        ),
                    },
                    container_name: None,
                });
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_symbols_recursive(uri, child, source, query, symbols);
    }
}

/// Fuzzy subsequence match: every character in `query` appears in `name` in order.
fn fuzzy_match_subsequence(name: &str, query: &str) -> bool {
    let mut name_chars = name.chars();
    for qc in query.chars() {
        loop {
            match name_chars.next() {
                Some(nc) if nc == qc => break,
                Some(_) => {}
                None => return false,
            }
        }
    }
    true
}

/// Handle the custom `sharplsp/sortMembers` request.
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
/// Dispatch an incoming LSP notification (open, change, save, close).
fn handle_notification(
    notif: Notification,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &mut HashMap<Uri, Tree>,
    nav_cache: &mut nav_cache::NavCache,
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
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
                // Sync text to sidecar so Roslyn sees the current source.
                // Without this, the sidecar's _solution retains stale text
                // from the initial workspace load or a previous didChange.
                if let Ok(file_path) = semantic::uri_to_path(&doc.uri) {
                    semantic::notify_did_change(&file_path, &doc.text, runtime, csharp_sidecar);
                }
                trigger_diagnostics(
                    &doc.uri,
                    runtime,
                    csharp_sidecar,
                    fsharp_sidecar,
                    connection,
                );
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
                    trigger_diagnostics(uri, runtime, csharp_sidecar, fsharp_sidecar, connection);
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
                    fsharp_sidecar,
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
                let _ = trees.remove(&params.text_document.uri);
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
///
/// Routes to the correct sidecar based on the document's language.
fn trigger_diagnostics(
    uri: &Uri,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    connection: &Connection,
) {
    let sidecar = match crate::tree_sitter_parse::LangId::from_uri(uri) {
        Some(crate::tree_sitter_parse::LangId::FSharp) => fsharp_sidecar,
        _ => csharp_sidecar,
    };
    let Some(sidecar) = sidecar else {
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
            let _ = trees.insert(uri.clone(), tree);
        }
        Err(e) => {
            // Remove stale tree so request handlers don't use a mismatched
            // old tree with the updated VFS content.
            let _ = trees.remove(uri);
            warn!("tree-sitter parse failed for {}: {e:#}", uri.as_str());
        }
    }
}
