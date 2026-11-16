//! Sidecar diagnostic wire records and their LSP `Diagnostic` mapping.

use lsp_types::{
    CodeDescription, Diagnostic, DiagnosticSeverity, DiagnosticTag, NumberOrString, Position,
    Range, Uri,
};
use tracing::debug;

/// Wire type matching C# `DiagnosticResult` `[Key(N)]` ordering.
///
/// Field order is significant — `MessagePack` uses positional keys.
#[derive(serde::Deserialize)]
pub(super) struct SidecarDiagnostic {
    /// Original file path (unused; kept for positional `MessagePack` alignment).
    pub(super) _file_path: String,
    /// Zero-based start line of the diagnostic span.
    pub(super) start_line: u32,
    /// Zero-based start column of the diagnostic span.
    pub(super) start_character: u32,
    /// Zero-based end line of the diagnostic span.
    pub(super) end_line: u32,
    /// Zero-based end column of the diagnostic span.
    pub(super) end_character: u32,
    /// Human-readable diagnostic message.
    pub(super) message: String,
    /// Roslyn severity string (`Error`, `Warning`, `Info`, or `Hidden`).
    pub(super) severity: String,
    /// Compiler or analyzer diagnostic code (e.g. `CS0219`).
    pub(super) code: String,
    /// The rule's documentation link (`DiagnosticDescriptor.HelpLinkUri`);
    /// empty when the source sidecar sends none ([DIAG-CATEGORIES-ANALYZER]).
    #[serde(default)]
    pub(super) help_link: String,
    /// LSP `DiagnosticTag` numbers: unnecessary, deprecated; empty for every
    /// other finding ([DIAG-CATEGORIES-TAGS]).
    #[serde(default)]
    pub(super) tags: Vec<i32>,
}

/// Map a sidecar diagnostic to an LSP `Diagnostic`.
pub(super) fn to_lsp_diagnostic(result: SidecarDiagnostic, source_tag: &str) -> Diagnostic {
    Diagnostic {
        range: Range::new(
            Position::new(result.start_line, result.start_character),
            Position::new(result.end_line, result.end_character),
        ),
        severity: Some(map_severity(&result.severity)),
        code: Some(NumberOrString::String(result.code)),
        code_description: code_description(&result.help_link),
        tags: lsp_tags(&result.tags),
        source: Some(source_tag.to_string()),
        message: result.message,
        ..Diagnostic::default()
    }
}

/// The rule's documentation page as LSP `codeDescription.href`, so the
/// editor links each finding to its rule exactly as the official C# extension
/// does ([DIAG-CATEGORIES-ANALYZER]). Absent when the sidecar sent no link; a
/// link that is not a valid URI is dropped with a trace, never a panic.
fn code_description(help_link: &str) -> Option<CodeDescription> {
    if help_link.is_empty() {
        return None;
    }
    match help_link.parse::<Uri>() {
        Ok(href) => Some(CodeDescription { href }),
        Err(error) => {
            debug!(help_link, %error, "Dropping malformed diagnostic help link");
            None
        }
    }
}

/// The finding's LSP tags, so the editor greys out unnecessary code and strikes
/// through a use of an obsolete symbol; none when the sidecar sent none, and an
/// unknown number is dropped ([DIAG-CATEGORIES-TAGS]).
fn lsp_tags(tags: &[i32]) -> Option<Vec<DiagnosticTag>> {
    let known: Vec<DiagnosticTag> = tags
        .iter()
        .filter_map(|tag| match *tag {
            1 => Some(DiagnosticTag::UNNECESSARY),
            2 => Some(DiagnosticTag::DEPRECATED),
            _ => None,
        })
        .collect();
    (!known.is_empty()).then_some(known)
}

/// Map Roslyn severity string to LSP `DiagnosticSeverity`.
pub(super) fn map_severity(severity: &str) -> DiagnosticSeverity {
    match severity {
        "Error" => DiagnosticSeverity::ERROR,
        "Warning" => DiagnosticSeverity::WARNING,
        "Info" => DiagnosticSeverity::INFORMATION,
        _ => DiagnosticSeverity::HINT,
    }
}
