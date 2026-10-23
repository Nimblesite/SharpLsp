//! Diagnostic presentation policy. Implements [DIAG-CONFIG].

use anyhow::Result;
use lsp_types::Diagnostic;

use crate::config::DiagnosticsConfig;

/// Read the authoritative session policy without retaining another configuration copy.
pub(super) fn configured(diagnostics: Vec<Diagnostic>) -> Result<Vec<Diagnostic>> {
    let config = crate::pull_diagnostics::state::configuration()?;
    Ok(apply(diagnostics.into_iter(), &config))
}

/// Filter before limiting each file, preserving compiler order and unlimited zero.
pub(super) fn apply(
    diagnostics: impl Iterator<Item = Diagnostic>,
    config: &DiagnosticsConfig,
) -> Vec<Diagnostic> {
    let limit = if config.max_per_file == 0 {
        usize::MAX
    } else {
        config.max_per_file
    };
    diagnostics
        .filter(|diagnostic| {
            diagnostic
                .severity
                .is_none_or(|severity| severity <= config.min_severity.lsp())
        })
        .take(limit)
        .collect()
}
