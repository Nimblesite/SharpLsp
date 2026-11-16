//! `MSBuild` documents in the diagnostics pipeline. Props files are entirely
//! host-owned; project files (F# and C#) keep their sidecar's diagnostics with
//! the host's `NuGet` findings appended. Implements [PKG-VULN-DIAG].

use anyhow::Result;
use lsp_types::Diagnostic;
use tracing::warn;

use crate::nuget::vulnerability::{appends_to_sidecar, document_diagnostics, owns_document};
use crate::sidecar::manager::CompilerRefusal;

/// The whole answer for a host-owned document; `None` when the sidecar is asked.
pub(super) async fn host_owned(file_path: &str) -> Option<Vec<Diagnostic>> {
    if owns_document(file_path) {
        Some(document_diagnostics(file_path).await)
    } else {
        None
    }
}

/// The sidecar method that diagnoses `file_path`.
pub(super) fn sidecar_method(file_path: &str) -> &'static str {
    if appends_to_sidecar(file_path) {
        "workspace/diagnostics/project"
    } else {
        "workspace/diagnostics"
    }
}

/// The compiler's answer with a project file's host findings appended. A
/// project the compiler refuses (it never loaded it) has no compiler truth, but
/// the host's audit does: its findings stand alone.
pub(super) async fn with_host_findings(
    file_path: &str,
    compiler: Result<Vec<Diagnostic>>,
) -> Result<Vec<Diagnostic>> {
    if !appends_to_sidecar(file_path) {
        return compiler;
    }
    let mut diagnostics = match compiler {
        Ok(found) => found,
        Err(error) if error.downcast_ref::<CompilerRefusal>().is_some() => {
            warn!(file_path, error = %format_args!("{error:#}"), "Compiler refused the project; reporting host findings only");
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    diagnostics.extend(document_diagnostics(file_path).await);
    Ok(diagnostics)
}
