//! Request routing: every `textDocument/*`, `workspace/*` and `sharplsp/*`
//! request is matched here and handed to its feature module, with the
//! sidecar chosen by the document's language. [SHARPLSP-ARCHITECTURE-ROUTING]

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use lsp_server::{Connection, Message, Request, Response};
use lsp_types::{
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
    Uri,
};
use tracing::{error, info, warn};
use tree_sitter::Tree;

use crate::diagnostic_publish::{
    converge_provisional_publication, republish_open_diagnostics, sidecar_for_uri,
};
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::{LangId, TsParsers};
use crate::vfs::Vfs;
use crate::{
    call_hierarchy, code_actions, cross_language, document_symbols, handlers, hierarchy,
    hot_reload, import_command, inlay_hints, nav_cache, nuget, project_edit, project_sources,
    razor, semantic, semantic_tokens, signature_help, solution_load, sort_members, statement_stop,
    target_framework, type_hierarchy, workspace_symbol_query, workspace_symbols,
};

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
pub(crate) fn handle_request(
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
                semantic::completion::handle_completion(req, runtime, sidecar, vfs)
            }
        }
        ResolveCompletionItem::METHOD => {
            let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
            semantic::completion::handle_completion_resolve(req, runtime, sidecar)
        }
        HoverRequest::METHOD => {
            if handlers::hover_has_no_symbol(&req, trees) {
                info!("Hover: skipped (whitespace or comment position)");
                Ok(serde_json::Value::Null)
            } else {
                let sidecar = pick_sidecar(&req, csharp_sidecar, fsharp_sidecar);
                semantic::hover::handle_hover(req, vfs, nav_cache, runtime, sidecar)
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
            semantic::rename::handle_prepare_rename(req, runtime, sidecar)
        }
        Rename::METHOD => {
            let (primary, fallback) =
                pick_sidecar_with_fallback(&req, csharp_sidecar, fsharp_sidecar);
            semantic::rename::handle_rename(req, runtime, primary, fallback)
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
            workspace_symbol_query::handle(req, parsers, vfs, runtime, fsharp_sidecar)
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
        "sharplsp/loadSolution" => solution_load::handle(
            req,
            runtime,
            [csharp_sidecar, fsharp_sidecar],
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
                crate::error_code_i32(lsp_server::ErrorCode::InternalError),
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
    if request_lang(&req) == Some(LangId::FSharp) && req.method != GotoImplementation::METHOD {
        cross_language::share_csharp_buffers(runtime, fsharp_sidecar, vfs);
    }
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
        "sharplsp/nuget/updatePreview" => nuget::update::handle_preview(req, runtime),
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
        // The reference behind an import quick fix ([REFACTOR-IMPORT-REFERENCE])
        "workspace/executeCommand" if import_command::is_import_command(&req) => {
            import_command::handle(&req, runtime, connection.sender.clone(), csharp_sidecar)
        }
        // MSBuild compile-order editing (GitHub #493, [SE-ADD-FILE-REQUEST])
        "sharplsp/project/addCompileItem" => {
            project_edit::handle_add_compile_item(req, runtime, csharp_sidecar)
        }
        "sharplsp/project/removeCompileItem" => {
            project_edit::handle_remove_compile_item(req, runtime, csharp_sidecar)
        }
        "sharplsp/project/compileItems" => {
            project_sources::handle_compile_items(req, runtime, fsharp_sidecar)
        }
        _ => {
            warn!("Unhandled request: {}", req.method);
            Err(anyhow::anyhow!("method not found"))
        }
    }
}

// ── Language-Based Sidecar Routing ────────────────────────────────

/// Pick the correct sidecar (C# or F#) based on the request's document URI.
pub(crate) fn pick_sidecar<'a>(
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
