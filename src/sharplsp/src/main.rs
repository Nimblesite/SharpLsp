//! `SharpLsp` server — main entry point.
//!
//! Implements LSP 3.17 lifecycle over stdio using `lsp-server`.

mod build_monitor;
mod call_hierarchy;
mod code_actions;
mod code_lens;
mod config;
mod config_debug;
mod configuration;
mod configuration_live;
mod cross_language;
mod diagnostic_publish;
mod diagnostics;
mod document_symbols;
mod folding;
// Formatting module is sequestered — not wired into the LSP server.
// Use CSharpier (C#) / Fantomas via Ionide (F#). See docs/formatting/README.md.
#[cfg(feature = "formatting")]
mod formatting;
mod handlers;
mod hierarchy;
mod hot_reload;
mod inbound;
mod inlay_hints;
mod nav_cache;
mod nuget;
mod paths;
mod postfix_completion;
mod profiler;
mod project_edit;
mod pull_diagnostics;
mod razor;
mod semantic;
mod semantic_tokens;
mod service_notifications;
mod sidecar;
mod signature_help;
mod sort_members;
mod source_walk;
mod statement_stop;
mod syntax;
mod target_framework;
mod tree_sitter_parse;
mod type_hierarchy;
mod utils;
mod vfs;
mod workspace_open;
mod workspace_symbols;
mod workspace_targets;

use std::collections::HashMap;
use std::io::IsTerminal;
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
        CodeActionRequest, CodeActionResolveRequest, Completion, DocumentDiagnosticRequest,
        DocumentHighlightRequest, DocumentSymbolRequest, FoldingRangeRequest, GotoDeclaration,
        GotoDefinition, GotoImplementation, GotoTypeDefinition, HoverRequest, InlayHintRequest,
        LinkedEditingRange, PrepareRenameRequest, References, Rename, Request as _,
        ResolveCompletionItem, SelectionRangeRequest, SemanticTokensFullDeltaRequest,
        SemanticTokensFullRequest, SemanticTokensRangeRequest, SignatureHelpRequest,
        TypeHierarchyPrepare, TypeHierarchySubtypes, TypeHierarchySupertypes,
        WorkspaceDiagnosticRequest, WorkspaceSymbolRequest,
    },
    FoldingRangeProviderCapability, HoverProviderCapability, InitializeParams, OneOf,
    SelectionRangeProviderCapability, ServerCapabilities, TextDocumentSyncCapability,
    TextDocumentSyncKind, Uri,
};
use tracing::{error, info, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tree_sitter::Tree;

use crate::diagnostic_publish::{
    converge_provisional_publication, republish_open_diagnostics, sidecar_for_uri,
    trigger_diagnostics,
};
use crate::inbound::{diagnostic_requests, inbound_with_inputs, SHUTDOWN_ANSWERED};
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::{LangId, TsParsers};
use crate::vfs::Vfs;
use crate::workspace_open::OpenFollowUp;

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
    // Implements [DIST-VERSION-OUTPUT] — Shipwright binary version contract.
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

    // Only emit ANSI colors when stderr is an interactive terminal. Editors
    // (e.g. VS Code) capture stderr into a plain Output panel where escape
    // codes would render as garbage. See issue #78 / [DIST-CLEAN-OUTPUT].
    let stderr_is_terminal = std::io::stderr().is_terminal();
    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(stderr_is_terminal),
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
#[expect(
    clippy::too_many_lines,
    reason = "server start-up is one linear sequence; splitting it would hide the order"
)]
fn run_server() -> Result<()> {
    let (connection, io_threads) = Connection::stdio();

    // Capabilities depend on what the client itself supports, so the initialize
    // request is answered by hand instead of through `Connection::initialize`.
    let (initialize_id, init_params) = connection.initialize_start()?;
    let init_params: InitializeParams = lspkit_server::capabilities::decode_initialize(init_params)
        .context("deserialize InitializeParams")?;
    let server_capabilities = build_capabilities(&init_params.capabilities);
    target_framework::remember_client(&init_params.capabilities);
    let capabilities_json = serde_json::json!({
        "capabilities": serde_json::to_value(server_capabilities).context("serialize capabilities")?,
    });
    connection.initialize_finish(initialize_id, capabilities_json)?;

    // Convert the workspace URI through the same RFC 8089 parser as every other
    // file path so Windows drive letters and percent-encoding resolve correctly;
    // a naive scheme trim yields `/C:/…`, a root the sidecar cannot load (#110).
    let workspace_root = init_params
        .workspace_folders
        .as_ref()
        .and_then(|folders| folders.first())
        .and_then(|folder| paths::uri_to_path(folder.uri.as_str()).ok())
        .or_else(|| {
            #[expect(
                deprecated,
                reason = "root_uri is the LSP 3.16 fallback when workspace_folders is absent"
            )]
            let root = init_params.root_uri.as_ref();
            root.and_then(|uri| paths::uri_to_path(uri.as_str()).ok())
        })
        .map(PathBuf::from);

    // Single-file mode still honours a `sharplsp.toml`: discovery falls back to the
    // process's current directory, which is the directory the editor launched the
    // server in. Opening one file inside a configured tree must not silently ignore
    // that tree's configuration just because no workspace folder was sent.
    // Implements [SCRIPT-DETECT].
    let config_root = workspace_root
        .clone()
        .or_else(|| std::env::current_dir().ok());
    // When no workspace root is available (single-file mode), a fallback root is
    // used solely for IPC path generation — the actual workspace path is sent via
    // workspace/open once the first file opens.
    let fallback_root = std::env::temp_dir();
    // The editor's settings arrive as `initializationOptions` before any
    // workspace opens, so a solution chosen there loads first time.
    // Implements [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
    let options = init_params.initialization_options.as_ref();
    let configuration = configuration::Configuration::initialized(
        config_root.clone().unwrap_or_else(|| fallback_root.clone()),
        options,
    );
    let sharplsp_config = if config_root.is_some() {
        configuration.config()?
    } else {
        info!("No workspace root or current directory — using default configuration");
        config::SharpLspConfig::default()
    };

    info!(
        "SharpLsp LSP initialized (log_level={}, debounce_ms={})",
        sharplsp_config.server.log_level, sharplsp_config.server.debounce_ms
    );

    // Create tokio runtime for async sidecar IPC.
    let runtime = tokio::runtime::Runtime::new().context("create tokio runtime")?;

    // Shared VFS — created here so the solution-diagnostics verification pass
    // can consult it before re-syncing files from disk and clobbering live edits.
    let vfs = Arc::new(Vfs::new());

    // Initialize C# sidecar manager if enabled.
    let sidecar_root = workspace_root.as_deref().unwrap_or(&fallback_root);

    let csharp_sidecar = if sharplsp_config.csharp.enabled {
        Some(Arc::new(SidecarManager::csharp(sidecar_root)))
    } else {
        None
    };

    let fsharp_sidecar = if sharplsp_config.fsharp.enabled {
        Some(Arc::new(SidecarManager::fsharp(sidecar_root)))
    } else {
        None
    };

    pull_diagnostics::state::initialize(
        &init_params.capabilities,
        &sharplsp_config.diagnostics,
        &runtime,
        [csharp_sidecar.as_ref(), fsharp_sidecar.as_ref()],
        connection.sender.clone(),
    )?;
    pull_diagnostics::events::start(
        [fsharp_sidecar.as_ref(), csharp_sidecar.as_ref()],
        &runtime,
        &connection.sender,
    );

    let csharp_event_pump =
        start_csharp_event_pump(csharp_sidecar.as_ref(), &runtime, connection.sender.clone());

    // Eagerly open workspaces in sidecars when a workspace root is available.
    // Health monitoring must wait until workspace/open completes — otherwise the
    // health check can time out on the transport lock (held by workspace/open),
    // declare a false crash, and kill the sidecar before the solution is loaded.
    // When no workspace root exists (single-file mode), workspace/open is
    // deferred until the first didOpen notification.
    // The C# sidecar opens the configured solution when `csharp.solution_path`
    // names one; a root holding several solutions is otherwise ambiguous, loads
    // nothing, and is shown as an error unless the client picks the solution
    // itself. Implements [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
    let solution = workspace_open::SolutionChoice::new(
        workspace_root.as_deref(),
        &sharplsp_config,
        &connection.sender,
        !workspace_open::client_picks_solution(options),
    );

    if workspace_root.is_some() {
        if let Some(target) = solution.target() {
            pull_diagnostics::state::select_workspace(&target.to_string_lossy())?;
        }
        workspace_open::start_sidecar(
            csharp_sidecar.as_ref(),
            solution.target(),
            OpenFollowUp::new(
                &sharplsp_config,
                &vfs,
                Some(&connection.sender),
                solution.report(),
            ),
            &runtime,
        );
        workspace_open::start_sidecar(
            fsharp_sidecar.as_ref(),
            workspace_root.as_ref(),
            OpenFollowUp::new(&sharplsp_config, &vfs, Some(&connection.sender), None),
            &runtime,
        );
    }

    let profiler_root = config_root.as_deref().unwrap_or(&fallback_root);
    let mut services = host_services(
        profiler_root,
        configuration,
        solution,
        &sharplsp_config,
        &connection,
        &runtime,
    );
    if let Some(folders) = &init_params.workspace_folders {
        let targets: Vec<_> = folders
            .iter()
            .filter_map(|folder| paths::uri_to_path(folder.uri.as_str()).ok())
            .collect();
        services
            .builds
            .replace(&targets, &runtime, &connection.sender);
    }
    main_loop(
        &connection,
        &runtime,
        &mut services,
        csharp_sidecar.as_ref(),
        fsharp_sidecar.as_ref(),
        &vfs,
        workspace_root.is_some(),
    )?;

    shutdown_services(
        &runtime,
        services,
        csharp_event_pump,
        csharp_sidecar.as_ref(),
        fsharp_sidecar.as_ref(),
    );
    pull_diagnostics::state::shutdown()?;
    drop(runtime);

    // Drop the connection so the writer thread's channel closes,
    // allowing io_threads.join() to complete.
    drop(connection);
    io_threads.join()?;
    info!("SharpLsp LSP shut down cleanly");
    Ok(())
}

/// Stop profiler sessions, then both sidecars: the profiler first so a session
/// never outlives the host ([PROFILER-SHARED-LIBRARY-HOST]). Consumes the
/// services: the profiler holds a clone of the connection's sender, and the
/// writer thread only exits once every clone is gone.
fn shutdown_services(
    runtime: &tokio::runtime::Runtime,
    services: HostServices,
    csharp_event_pump: Option<tokio::task::JoinHandle<()>>,
    csharp: Option<&Arc<SidecarManager>>,
    fsharp: Option<&Arc<SidecarManager>>,
) {
    if let Some(event_pump) = csharp_event_pump {
        event_pump.abort();
    }
    services.profiler.shutdown(runtime);
    drop(services);
    // Shut down sidecars gracefully (in parallel to avoid doubling timeout).
    runtime.block_on(shutdown_sidecars(csharp, fsharp));
}

/// Shut down both language sidecars concurrently.
async fn shutdown_sidecars(
    csharp: Option<&Arc<SidecarManager>>,
    fsharp: Option<&Arc<SidecarManager>>,
) {
    let cs = async {
        if let Some(sidecar) = csharp {
            sidecar.shutdown().await;
        }
    };
    let fs = async {
        if let Some(sidecar) = fsharp {
            sidecar.shutdown().await;
        }
    };
    tokio::join!(cs, fs);
}

/// Build the server capabilities advertised during LSP initialization.
fn build_capabilities(client: &lsp_types::ClientCapabilities) -> ServerCapabilities {
    ServerCapabilities {
        // Implements [CONFIG-RESOLUTION]: discoverable by every LSP client, and
        // [PROFILER-SHARED-LIBRARY-HOST]: the profiler's runtimes and capabilities.
        experimental: Some(serde_json::json!({
            "configurationProvider": {"method": "sharplsp/configuration"},
            "lspProfiler": profiler::host::capability_block(),
        })),
        // Every profiler operation is a standard `workspace/executeCommand`.
        execute_command_provider: Some(lsp_types::ExecuteCommandOptions {
            commands: profiler::host::ProfilerHost::command_names(),
            work_done_progress_options: lsp_types::WorkDoneProgressOptions::default(),
        }),
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
        document_symbol_provider: Some(OneOf::Left(true)),
        folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
        selection_range_provider: Some(SelectionRangeProviderCapability::Simple(true)),
        linked_editing_range_provider: Some(
            lsp_types::LinkedEditingRangeServerCapabilities::Simple(true),
        ),
        completion_provider: Some(lsp_types::CompletionOptions {
            resolve_provider: Some(true),
            // `.` must be advertised so editors auto-send textDocument/completion
            // on member access (e.g. `this.`). Without it the popup never appears
            // after a dot. Applies to both C# and F# member access. `<` and `@`
            // complete Razor markup. [RAZOR-ARCHITECTURE-ROUTING]
            trigger_characters: Some(
                std::iter::once(".")
                    .chain(razor::MARKUP_TRIGGERS)
                    .map(str::to_string)
                    .collect(),
            ),
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
        signature_help_provider: Some(lsp_types::SignatureHelpOptions {
            trigger_characters: Some(vec!["(".to_string(), ",".to_string()]),
            retrigger_characters: Some(vec![",".to_string()]),
            work_done_progress_options: lsp_types::WorkDoneProgressOptions::default(),
        }),
        workspace_symbol_provider: Some(OneOf::Left(true)),
        call_hierarchy_provider: Some(lsp_types::CallHierarchyServerCapability::Simple(true)),
        code_lens_provider: Some(lsp_types::CodeLensOptions {
            resolve_provider: Some(false),
        }),
        diagnostic_provider: pull_diagnostics_capability(client),
        ..ServerCapabilities::default()
    }
}

/// Advertise pull diagnostics only to clients that cannot receive push ones.
///
/// A client offered both models runs both: `vscode-languageclient` creates one
/// `DiagnosticCollection` for `publishDiagnostics` and a second one for
/// `textDocument/diagnostic`, and `languages.getDiagnostics` concatenates them,
/// so every diagnostic is shown — and counted — twice. This host's diagnostics
/// pipeline is push-first (background fetch, generation gate, restore-settle
/// republication), so push wins wherever the client supports it and the pull
/// handlers stay for clients that declare no `publishDiagnostics` support.
/// Implements [DIAG-LSP-CAPABILITIES-EXCLUSIVE].
fn pull_diagnostics_capability(
    client: &lsp_types::ClientCapabilities,
) -> Option<lsp_types::DiagnosticServerCapabilities> {
    let supports_push = client
        .text_document
        .as_ref()
        .is_some_and(|text_document| text_document.publish_diagnostics.is_some());
    if supports_push && !pull_diagnostics::state::supports_pull(client) {
        return None;
    }
    Some(lsp_types::DiagnosticServerCapabilities::Options(
        lsp_types::DiagnosticOptions {
            identifier: Some("sharplsp".to_owned()),
            inter_file_dependencies: true,
            workspace_diagnostics: true,
            ..lsp_types::DiagnosticOptions::default()
        },
    ))
}

/// Lazily open the workspace for the first opened document when the client supplied no
/// workspace root.
///
/// Returns `true` only when a sidecar workspace was actually opened. Returning `true` for an
/// unsupported document would latch `workspace_initialized` on, so opening a `.md` or `.json`
/// before any source file would permanently prevent the real workspace from loading.
/// Implements [SCRIPT-ROUTE-LAZY].
fn init_workspace_for_file(
    notif: &Notification,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> bool {
    let Some(file_path) = opened_document_path(notif) else {
        return false;
    };
    let Some(sidecar) = sidecar_for_path(&file_path, csharp_sidecar, fsharp_sidecar) else {
        return false;
    };

    // The sidecar is given the FILE PATH, not its parent directory. Sending a directory is what
    // forces the sidecar to glob the folder and compile unrelated programs together.
    // Implements [SCRIPT-ROUTE-TARGET].
    info!("No workspace root — opening single-document workspace for {file_path}");
    let sidecar = Arc::clone(sidecar);
    drop(runtime.spawn(async move {
        if let Err(err) = workspace_open::open_workspace(&sidecar, &file_path).await {
            error!("Failed to lazily open workspace: {err:#}");
        }
        drop(tokio::spawn(Arc::clone(&sidecar).start_warm_up()));
        // Health monitoring starts only after workspace/open completes, matching the eager
        // path — a health check that races the load can kill a healthy sidecar.
        // Implements [SCRIPT-ROUTE-HEALTH].
        sidecar.start_health_monitor().await;
    }));
    true
}

/// Extract the file path from a `textDocument/didOpen` notification.
fn opened_document_path(notif: &Notification) -> Option<String> {
    let params =
        serde_json::from_value::<lsp_types::DidOpenTextDocumentParams>(notif.params.clone())
            .ok()?;
    paths::uri_to_path(params.text_document.uri.as_str()).ok()
}

/// Map a document to the sidecar that owns its language. Implements [SCRIPT-DETECT].
///
/// `.fsi` is deliberately absent: a signature file with no owning project has no meaningful
/// semantic closure and is served syntax-only by the host. Implements [SCRIPT-FSX-FSI].
fn sidecar_for_path<'a>(
    file_path: &str,
    csharp_sidecar: Option<&'a Arc<SidecarManager>>,
    fsharp_sidecar: Option<&'a Arc<SidecarManager>>,
) -> Option<&'a Arc<SidecarManager>> {
    match paths::extension_key(file_path).as_deref() {
        Some("CS" | "CSX") => csharp_sidecar,
        Some("FS" | "FSX" | "FSSCRIPT") => fsharp_sidecar,
        _ => None,
    }
}

/// Republish provisional diagnostics as soon as the C# restore settles.
fn start_csharp_event_pump(
    sidecar: Option<&Arc<SidecarManager>>,
    runtime: &tokio::runtime::Runtime,
    sender: crossbeam_channel::Sender<Message>,
) -> Option<tokio::task::JoinHandle<()>> {
    let sidecar = sidecar?;
    let mut events = sidecar.take_event_receiver()?;
    let sidecar = Arc::clone(sidecar);
    Some(runtime.spawn(async move {
        while let Some(event) = events.recv().await {
            handle_csharp_event(&event, &sidecar, &sender).await;
        }
    }))
}

/// Converge provisional diagnostics for one C# restore-settled event.
async fn handle_csharp_event(
    event: &str,
    sidecar: &SidecarManager,
    sender: &crossbeam_channel::Sender<Message>,
) {
    let Some(path) = event.strip_prefix("diagnostics-settled ") else {
        return;
    };
    let Ok(uri) = paths::path_to_lsp_uri(path.trim()) else {
        warn!(path, "Sidecar settle event carried an invalid path");
        return;
    };
    diagnostics::converge_provisional(sidecar, sender, &uri, path.trim()).await;
}

// ── Main Loop ─────────────────────────────────────────────────────

/// The per-connection services the main loop routes to: live configuration
/// and the mounted profiler ([PROFILER-SHARED-LIBRARY-HOST]).
struct HostServices {
    /// Native build-output observations for reactive test discovery.
    builds: build_monitor::BuildMonitor,
    /// Configuration requests and change notifications.
    configuration: configuration::Configuration,
    /// Profiler commands, notifications and cancellation.
    profiler: profiler::host::ProfilerHost,
    /// The solution the C# sidecar opens, reopened when settings move it.
    solution: workspace_open::SolutionChoice,
    /// The configuration last applied, which a change is measured against
    /// ([CONFIG-RESOLUTION-LIVE]).
    applied: config::SharpLspConfig,
}

/// Mount the profiler under `profiler_root` beside the configuration service.
fn host_services(
    profiler_root: &std::path::Path,
    configuration: configuration::Configuration,
    solution: workspace_open::SolutionChoice,
    config: &config::SharpLspConfig,
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
) -> HostServices {
    let profiler = profiler::host::ProfilerHost::mount(
        profiler_root,
        &config.profiler,
        connection.sender.clone(),
        runtime,
    );
    let mut builds = build_monitor::BuildMonitor::default();
    builds.replace(
        &[profiler_root.to_string_lossy().into_owned()],
        runtime,
        &connection.sender,
    );
    HostServices {
        builds,
        configuration,
        profiler,
        solution,
        applied: config.clone(),
    }
}

#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
/// Process LSP messages until the connection closes or exit is received.
fn main_loop(
    connection: &Connection,
    runtime: &tokio::runtime::Runtime,
    services: &mut HostServices,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    vfs: &Arc<Vfs>,
    mut workspace_initialized: bool,
) -> Result<()> {
    let parsers = TsParsers::new();
    let mut trees: HashMap<Uri, Tree> = HashMap::new();
    let mut nav_cache = nav_cache::NavCache::new();
    let mut shutdown_requested = false;
    let diagnostic_requests =
        diagnostic_requests(runtime, [fsharp_sidecar, csharp_sidecar], vfs, connection);
    let (inbound, internal) =
        inbound_with_inputs(connection, diagnostic_requests.cancellation_handle())?;
    let _config_watch = configuration_live::ConfigWatch::start(
        services.configuration.root(),
        runtime.handle(),
        &internal,
    );

    for msg in &inbound {
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

                if req.method == "sharplsp/configuration" {
                    services.configuration.respond(req, connection)?;
                    continue;
                }
                if services
                    .profiler
                    .dispatch(&req, runtime, &connection.sender)
                {
                    continue;
                }
                if diagnostic_requests.dispatch(&req, runtime)? {
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
                let Some(notif) = service_notifications::route(
                    notif,
                    services,
                    &diagnostic_requests,
                    [csharp_sidecar, fsharp_sidecar],
                    vfs,
                    runtime,
                    &connection.sender,
                ) else {
                    continue;
                };
                if notif.method == SHUTDOWN_ANSWERED {
                    diagnostic_requests.cancel_all();
                    shutdown_requested = true;
                    continue;
                }
                if notif.method == "exit" {
                    info!("Exit notification received");
                    return Ok(());
                }
                if !workspace_initialized && notif.method == DidOpenTextDocument::METHOD {
                    workspace_initialized =
                        init_workspace_for_file(&notif, runtime, csharp_sidecar, fsharp_sidecar);
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
    let document_uri = request_document_uri(&req.params);

    let result = match req.method.as_str() {
        // Syntax-only (tree-sitter, Rust) for C#; documentSymbol for F# is
        // deliberately served by the sidecar's FCS items (richer symbol data
        // than a syntax tree can give). The other syntax features —
        // foldingRange, selectionRange, linkedEditingRange — run on the F#
        // tree-sitter grammar for both languages. Razor has no grammar, so the
        // C# sidecar answers every one of its syntax requests, selection
        // ranges chained out to the whole document.
        // [SHARPLSP-FEATURES-NAVIGATION] [RAZOR-ARCHITECTURE-ROUTING]
        DocumentSymbolRequest::METHOD => match request_lang(&req) {
            Some(LangId::FSharp | LangId::Razor) => {
                let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
                document_symbols::handle_via_sidecar(req, runtime, sidecar)
            }
            _ => handlers::handle_document_symbols(req, vfs, parsers, trees),
        },
        FoldingRangeRequest::METHOD if request_lang(&req) == Some(LangId::Razor) => {
            razor::handle_folding_ranges(req, runtime, csharp_sidecar)
        }
        SelectionRangeRequest::METHOD if request_lang(&req) == Some(LangId::Razor) => {
            razor::handle_selection_ranges(req, runtime, csharp_sidecar)
        }
        LinkedEditingRange::METHOD if request_lang(&req) == Some(LangId::Razor) => {
            razor::handle_linked_editing_range(req, runtime, csharp_sidecar)
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
            if serde_json::from_value(req.params.clone())
                .is_ok_and(|params| razor::is_markup_trigger_outside_razor(&params))
            {
                Ok(serde_json::Value::Null)
            } else {
                let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
                semantic::handle_completion(req, runtime, sidecar, vfs)
            }
        }
        ResolveCompletionItem::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic::handle_completion_resolve(req, runtime, sidecar)
        }
        HoverRequest::METHOD => {
            if handlers::hover_has_no_symbol(&req, trees) {
                info!("Hover: skipped (whitespace or comment position)");
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
        // Handler code is sequestered in src/sharplsp/src/formatting.rs
        // (see docs/formatting/README.md).
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
        // Signature help [SHARPLSP-FEATURES-INTELLIGENCE]
        SignatureHelpRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            signature_help::handle(req, runtime, sidecar)
        }
        // Rename — [RENAME-PREPARE], [RENAME-APPLY], [RENAME-CROSSLANGUAGE].
        PrepareRenameRequest::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic::handle_prepare_rename(req, runtime, sidecar)
        }
        Rename::METHOD => {
            let (primary, fallback) =
                pick_sidecar_with_fallback(&req, csharp_sidecar, fsharp_sidecar);
            semantic::handle_rename(req, runtime, primary, fallback)
        }
        // Call hierarchy
        CallHierarchyPrepare::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            hierarchy::handle_prepare(req, runtime, sidecar, call_hierarchy::map_hierarchy_item)
        }
        CallHierarchyIncomingCalls::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            hierarchy::handle_related(req, runtime, sidecar, call_hierarchy::incoming_call)
        }
        CallHierarchyOutgoingCalls::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            hierarchy::handle_related(req, runtime, sidecar, call_hierarchy::outgoing_call)
        }
        // Type hierarchy
        TypeHierarchyPrepare::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            hierarchy::handle_prepare(
                req,
                runtime,
                sidecar,
                type_hierarchy::map_type_hierarchy_item,
            )
        }
        TypeHierarchySupertypes::METHOD | TypeHierarchySubtypes::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            hierarchy::handle_related(
                req,
                runtime,
                sidecar,
                type_hierarchy::map_type_hierarchy_item,
            )
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
        // Standard workspace/symbol
        WorkspaceSymbolRequest::METHOD => {
            handle_standard_workspace_symbol(req, parsers, vfs, runtime, fsharp_sidecar)
        }
        // Active target framework [NETFX-CONTEXT]
        "sharplsp/targetFramework" => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            target_framework::handle_get(req, runtime, sidecar)
        }
        "sharplsp/setTargetFramework" => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            target_framework::handle_set(req, runtime, sidecar).and_then(|switched| {
                nav_cache.clear();
                republish_open_diagnostics(
                    vfs,
                    runtime,
                    csharp_sidecar,
                    fsharp_sidecar,
                    connection,
                );
                switched.announce(&connection.sender)
            })
        }
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

    // BEFORE the response is sent: a semantic answer computed from an
    // upgraded tier-1 compilation must never reach the editor while the
    // published diagnostics still show the tier-2 placeholder.
    // [SCRIPT-FILEBASED-REFERENCES-FALLBACK], [DIAG-PUSH-GATE]
    if result.is_ok() && reveals_semantic_state(&method) {
        converge_provisional_publication(
            document_uri.as_ref(),
            runtime,
            csharp_sidecar,
            fsharp_sidecar,
            connection,
        );
    }

    let resp = request_response(id, &method, result);
    connection.sender.send(Message::Response(resp))?;
    Ok(())
}

/// Build the shared success/error response for foreground and background requests.
fn request_response(
    id: lsp_server::RequestId,
    method: &str,
    result: Result<serde_json::Value>,
) -> Response {
    match result {
        Ok(value) => Response::new_ok(id, value),
        Err(e) => {
            error!(method = %method, "Request failed: {e:#}");
            Response::new_err(
                id,
                error_code_i32(lsp_server::ErrorCode::InternalError),
                format!("{e:#}"),
            )
        }
    }
}

/// The `textDocument.uri` of a request's params, when the request carries one.
fn request_document_uri(params: &serde_json::Value) -> Option<Uri> {
    params
        .get("textDocument")
        .and_then(|document| document.get("uri"))
        .and_then(|uri| uri.as_str())
        .and_then(|raw| raw.parse().ok())
}

/// Whether a request's answer can reveal semantic (sidecar) state — the
/// tier-1 reference upgrade in particular — to the editor. Syntax-only,
/// pull-diagnostic, workspace-scoped, and custom requests cannot, so they
/// skip the provisional-publication convergence.
/// [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
fn reveals_semantic_state(method: &str) -> bool {
    !matches!(
        method,
        DocumentSymbolRequest::METHOD
            | FoldingRangeRequest::METHOD
            | SelectionRangeRequest::METHOD
            | LinkedEditingRange::METHOD
            | DocumentDiagnosticRequest::METHOD
            | WorkspaceDiagnosticRequest::METHOD
            | WorkspaceSymbolRequest::METHOD
    ) && !method.starts_with("sharplsp/")
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
            fsharp_sidecar,
        ),
        "sharplsp/sortMembers" => handle_sort_members(req, parsers, vfs),
        "sharplsp/statementStop" => handle_statement_stop(req, parsers, vfs),
        "sharplsp/hotReload" => hot_reload::handle(req, runtime, csharp_sidecar),
        razor::HTML_PROJECTION => razor::handle_html_projection(req, runtime, csharp_sidecar),
        // NuGet package management
        "sharplsp/nuget/targets" => nuget::handlers::handle_targets(req),
        "sharplsp/nuget/search" => nuget::handlers::handle_search(req, runtime),
        "sharplsp/nuget/versions" => nuget::handlers::handle_versions(req, runtime),
        "sharplsp/nuget/installed" => nuget::handlers::handle_installed(req, runtime),
        "sharplsp/nuget/install" => {
            nuget::handlers::handle_install(req, runtime, connection.sender.clone(), csharp_sidecar)
        }
        "sharplsp/nuget/uninstall" => nuget::handlers::handle_uninstall(
            req,
            runtime,
            connection.sender.clone(),
            csharp_sidecar,
        ),
        "sharplsp/nuget/unused" => {
            nuget::handlers::handle_unused(req, runtime, csharp_sidecar, fsharp_sidecar)
        }
        "sharplsp/nuget/consolidate" => nuget::handlers::handle_consolidate(
            req,
            runtime,
            connection.sender.clone(),
            csharp_sidecar,
        ),
        // MSBuild compile-order editing (GitHub #493, [SE-ADD-FILE-REQUEST])
        "sharplsp/project/addCompileItem" => {
            project_edit::handle_add_compile_item(req, runtime, csharp_sidecar)
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
    extract_document_uri(req).map_or(csharp, |uri| sidecar_for_uri(&uri, csharp, fsharp))
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
/// Checks `params.textDocument.uri` first, then `params.item.uri` (call- and
/// type-hierarchy incoming/outgoing/super/subtype requests carry the URI inside
/// the hierarchy item, not a `textDocument`), then falls back to
/// `params.data.uri` for code-action-resolve requests. Without the `item`
/// fallback, F# hierarchy follow-up requests misroute to the C# sidecar.
fn extract_document_uri(req: &Request) -> Option<Uri> {
    nested_uri(&req.params, "textDocument")
        .or_else(|| nested_uri(&req.params, "item"))
        .or_else(|| nested_uri(&req.params, "data"))
}

/// The language of the document a request targets (by file extension).
fn request_lang(req: &Request) -> Option<LangId> {
    extract_document_uri(req).and_then(|uri| LangId::from_uri(&uri))
}

/// Parse `params.<outer>.uri` into a [`Uri`], if present and valid.
fn nested_uri(params: &serde_json::Value, outer: &str) -> Option<Uri> {
    params
        .get(outer)
        .and_then(|value| value.get("uri"))
        .and_then(|value| value.as_str())
        .and_then(|raw| raw.parse::<Uri>().ok())
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
    pull_diagnostics::state::select_workspace(sln_path)?;

    let payload = sln_path.to_owned();
    let diagnostic_config = pull_diagnostics::state::configuration()?;

    if let Some(cs) = csharp_sidecar {
        let cs = Arc::clone(cs);
        let p = payload.clone();
        let sender = connection.sender.clone();
        let vfs_for_diagnostics = Arc::clone(vfs);
        drop(runtime.spawn(async move {
            match workspace_open::open_workspace(&cs, &p).await {
                Ok(()) => {
                    info!("Solution loaded in C# (Roslyn) sidecar");
                    if let Err(error) = workspace_open::configure_diagnostics(
                        &cs,
                        diagnostic_config.analyzers_enabled,
                        diagnostic_config.auto_restore_on_open,
                    )
                    .await
                    {
                        warn!(%error, "C# diagnostic configuration failed");
                    }
                    if pull_diagnostics::state::is_pull() {
                        pull_diagnostics::state::engine_loaded();
                        return;
                    }
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
        let sender = connection.sender.clone();
        let vfs = Arc::clone(vfs);
        drop(runtime.spawn(async move {
            match workspace_open::open_workspace(&fs, &p).await {
                Ok(()) => {
                    info!("Solution loaded in F# (FCS) sidecar");
                    if let Err(error) = workspace_open::configure_diagnostics(
                        &fs,
                        diagnostic_config.analyzers_enabled,
                        diagnostic_config.auto_restore_on_open,
                    )
                    .await
                    {
                        warn!(%error, "F# diagnostic configuration failed");
                    }
                    pull_diagnostics::state::engine_loaded();
                    if !pull_diagnostics::state::is_pull() {
                        diagnostics::request_solution_in_background(fs, sender, vec![], vfs);
                    }
                }
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
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: workspace_symbols::WorkspaceSymbolsParams = serde_json::from_value(req.params)?;
    let response = workspace_symbols::handle(
        &params,
        parsers,
        vfs,
        runtime,
        solution_sidecar,
        fsharp_sidecar,
    )?;
    Ok(serde_json::to_value(response)?)
}

/// Standard `workspace/symbol` handler. C#/syntax files are matched by tree-sitter
/// over the VFS; F# files are matched via the FCS sidecar's document symbols, since
/// the host has no F# tree-sitter grammar. `[SHARPLSP-FEATURES-NAVIGATION]`
fn handle_standard_workspace_symbol(
    req: Request,
    parsers: &TsParsers,
    vfs: &Vfs,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: lsp_types::WorkspaceSymbolParams = serde_json::from_value(req.params)?;
    let query = params.query.to_lowercase();

    // Get all files from the VFS and search for matching symbols.
    let mut symbols = Vec::new();
    for entry in vfs.iter() {
        let uri = entry.key().clone();
        let Some(lang) = LangId::from_uri(&uri).filter(|lang| lang.has_grammar()) else {
            continue;
        };
        if matches!(lang, LangId::FSharp) {
            collect_fsharp_ws_symbols(&uri, runtime, fsharp_sidecar, &query, &mut symbols);
            continue;
        }
        let content = entry.value().content.clone();
        if let Ok(tree) = parsers.parse(lang, &content, None) {
            collect_matching_symbols(&uri, &tree, &content, &query, &mut symbols);
        }
    }

    Ok(serde_json::to_value(symbols)?)
}

/// Append the FCS-sourced workspace symbols matching `query` for one open F#
/// document. No sidecar / unresolvable path / sidecar error → contributes
/// nothing, never fails the whole search. `[SHARPLSP-FEATURES-NAVIGATION]`,
/// `[FS-WORKSPACE-SYMBOL]`
fn collect_fsharp_ws_symbols(
    uri: &Uri,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    query: &str,
    symbols: &mut Vec<lsp_types::SymbolInformation>,
) {
    let Some(sidecar) = fsharp_sidecar else {
        return;
    };
    let Ok(file_path) = crate::paths::uri_to_path(uri.as_str()) else {
        return;
    };
    let Ok(found) = document_symbols::fsharp_workspace_symbols(runtime, sidecar, uri, file_path)
    else {
        return;
    };
    for sym in found {
        if query.is_empty() || fuzzy_match_subsequence(&sym.name.to_lowercase(), query) {
            symbols.push(sym);
        }
    }
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
fn handle_sort_members(req: Request, parsers: &TsParsers, vfs: &Vfs) -> Result<serde_json::Value> {
    let params: sort_members::SortMembersParams = serde_json::from_value(req.params)?;
    let response = sort_members::handle(&params, parsers, vfs)?;
    Ok(serde_json::to_value(response)?)
}

/// Handle the custom `sharplsp/statementStop` request.
///
/// Classifies one debugger stop position as code or as pure block punctuation,
/// so the DAP router can elide the brace-only stops [DEBUG-FEATURES-STEPPING]
/// requires a step gesture to walk past.
fn handle_statement_stop(
    req: Request,
    parsers: &TsParsers,
    vfs: &Vfs,
) -> Result<serde_json::Value> {
    let params: statement_stop::StatementStopParams = serde_json::from_value(req.params)?;
    let response = statement_stop::handle(&params, parsers, vfs)?;
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
                pull_diagnostics::state::begin_change();
                vfs.open(doc.uri.clone(), doc.version, doc.text.clone());
                reparse(parsers, trees, &doc.uri, &doc.text);
                // Sync text to the document's own sidecar so the semantic engine
                // (Roslyn / FCS) sees the current buffer. Routing by language is
                // essential: without it F# edits never reach the F# sidecar, which
                // then resolves hover/completion against stale on-disk text.
                if let Ok(file_path) = paths::uri_to_path(doc.uri.as_str()) {
                    let sidecar = sidecar_for_uri(&doc.uri, csharp_sidecar, fsharp_sidecar);
                    semantic::notify_did_change(&file_path, &doc.text, runtime, sidecar);
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
                    pull_diagnostics::state::begin_change();
                    vfs.change(uri, params.text_document.version, change.text.clone());
                    reparse(parsers, trees, uri, &change.text);
                    nav_cache.invalidate(uri);
                    // Notify the document's own sidecar so the semantic engine
                    // sees the new source text (F# → F# sidecar, C# → C#).
                    if let Ok(file_path) = paths::uri_to_path(uri.as_str()) {
                        let sidecar = sidecar_for_uri(uri, csharp_sidecar, fsharp_sidecar);
                        semantic::notify_did_change(&file_path, &change.text, runtime, sidecar);
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
                pull_diagnostics::state::begin_change();
                vfs.close(&params.text_document.uri);
                let _ = trees.remove(&params.text_document.uri);
                nav_cache.invalidate(&params.text_document.uri);
                if pull_diagnostics::state::is_pull() {
                    if let Err(error) = pull_diagnostics::changes::closed(
                        &params.text_document.uri,
                        runtime,
                        [csharp_sidecar, fsharp_sidecar],
                    ) {
                        warn!(%error, "Closed document could not reload disk text");
                    }
                    trigger_diagnostics(
                        &params.text_document.uri,
                        runtime,
                        csharp_sidecar,
                        fsharp_sidecar,
                        connection,
                    );
                } else if let Err(err) =
                    diagnostics::clear(&connection.sender, params.text_document.uri)
                {
                    warn!("Failed to clear diagnostics: {err:#}");
                }
            }
        }
        _ => {
            // Ignore unknown notifications per LSP spec.
        }
    }
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
    let Some(lang) = LangId::from_uri(uri).filter(|lang| lang.has_grammar()) else {
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
