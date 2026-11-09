//! `SharpLsp` server — main entry point.
//!
//! Implements LSP 3.17 lifecycle over stdio using `lsp-server`.

mod build_monitor;
mod call_hierarchy;
mod capabilities;
mod code_actions;
mod code_lens;
mod config;
mod config_debug;
mod configuration;
mod configuration_live;
mod cross_language;
mod diagnostic_publish;
mod diagnostics;
mod dispatch;
mod document_symbols;
mod folding;
// Formatting module is sequestered — not wired into the LSP server.
// Use CSharpier (C#) / Fantomas via Ionide (F#). See docs/formatting/README.md.
#[cfg(feature = "formatting")]
mod formatting;
mod handlers;
mod hierarchy;
mod hot_reload;
mod import_command;
mod inbound;
mod inlay_hints;
mod nav_cache;
mod notifications;
mod nuget;
mod paths;
mod postfix_completion;
mod profiler;
mod project_edit;
mod project_sources;
mod pull_diagnostics;
mod razor;
mod semantic;
mod semantic_tokens;
mod service_notifications;
mod sidecar;
mod signature_help;
mod solution_load;
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
mod workspace_symbol_query;
mod workspace_symbols;
mod workspace_targets;

use std::collections::HashMap;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::{Connection, Message, Response};
use lsp_types::{
    notification::{DidOpenTextDocument, Notification as _},
    InitializeParams, Uri,
};
use tracing::{error, info, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tree_sitter::Tree;

use crate::inbound::{diagnostic_requests, inbound_with_inputs, SHUTDOWN_ANSWERED};
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::TsParsers;
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
pub(crate) fn error_code_i32(code: lsp_server::ErrorCode) -> i32 {
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
    let server_capabilities = capabilities::build(&init_params.capabilities);
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
                dispatch::handle_request(
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
                    workspace_initialized = notifications::init_workspace_for_file(
                        &notif,
                        runtime,
                        [csharp_sidecar, fsharp_sidecar],
                    );
                }
                notifications::handle(
                    notif,
                    &mut notifications::DocumentContext {
                        vfs,
                        parsers: &parsers,
                        trees: &mut trees,
                        nav_cache: &mut nav_cache,
                        connection,
                        runtime,
                        sidecars: [csharp_sidecar, fsharp_sidecar],
                    },
                );
            }
            Message::Response(_) => {
                // We don't send requests to the client yet.
            }
        }
    }

    Ok(())
}
