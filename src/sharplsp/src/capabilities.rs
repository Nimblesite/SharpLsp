//! The server capabilities advertised during LSP initialization.

use lsp_types::{
    FoldingRangeProviderCapability, HoverProviderCapability, OneOf,
    SelectionRangeProviderCapability, ServerCapabilities, TextDocumentSyncCapability,
    TextDocumentSyncKind,
};

use crate::{import_command, profiler, pull_diagnostics, razor, semantic_tokens};

/// Build the server capabilities advertised during LSP initialization.
pub(crate) fn build(client: &lsp_types::ClientCapabilities) -> ServerCapabilities {
    ServerCapabilities {
        // Implements [CONFIG-RESOLUTION]: discoverable by every LSP client, and
        // [PROFILER-SHARED-LIBRARY-HOST]: the profiler's runtimes and capabilities.
        experimental: Some(serde_json::json!({
            "configurationProvider": {"method": "sharplsp/configuration"},
            "lspProfiler": profiler::host::capability_block(),
        })),
        // Every profiler operation is a standard `workspace/executeCommand`.
        // The import quick fixes add their reference the same way ([REFACTOR-IMPORT-REFERENCE]).
        execute_command_provider: Some(lsp_types::ExecuteCommandOptions {
            commands: [
                profiler::host::ProfilerHost::command_names(),
                vec![import_command::COMMAND.to_string()],
            ]
            .concat(),
            work_done_progress_options: lsp_types::WorkDoneProgressOptions::default(),
        }),
        text_document_sync: Some(TextDocumentSyncCapability::Kind(TextDocumentSyncKind::FULL)),
        document_symbol_provider: Some(OneOf::Left(true)),
        folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
        selection_range_provider: Some(SelectionRangeProviderCapability::Simple(true)),
        linked_editing_range_provider: Some(
            lsp_types::LinkedEditingRangeServerCapabilities::Simple(true),
        ),
        completion_provider: Some(completion_options()),
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
        code_action_provider: Some(code_action_options()),
        // Formatting is intentionally disabled. Use CSharpier (C#) / Fantomas via Ionide (F#).
        // See docs/formatting/README.md for details on the sequestered formatter code.
        document_formatting_provider: None,
        document_range_formatting_provider: None,
        document_on_type_formatting_provider: None,
        semantic_tokens_provider: Some(semantic_tokens_options()),
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

/// Completion with resolve and the member-access / Razor markup triggers.
fn completion_options() -> lsp_types::CompletionOptions {
    lsp_types::CompletionOptions {
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
    }
}

/// Every code action kind the sidecars produce, resolved lazily.
fn code_action_options() -> lsp_types::CodeActionProviderCapability {
    lsp_types::CodeActionProviderCapability::Options(lsp_types::CodeActionOptions {
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
    })
}

/// Full, delta and range semantic tokens under the host's legend.
fn semantic_tokens_options() -> lsp_types::SemanticTokensServerCapabilities {
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
    )
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
