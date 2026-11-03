//! Shared restore outcomes for install and uninstall.

use super::types;

/// Install/uninstall responses that may trigger a background restore.
pub trait RestoreOutcome {
    /// Whether the operation succeeded.
    fn succeeded(&self) -> bool;
    /// Paths of files the operation modified.
    fn modified_files(&self) -> &[String];
}

impl RestoreOutcome for types::InstallResponse {
    fn succeeded(&self) -> bool {
        self.success
    }

    fn modified_files(&self) -> &[String] {
        &self.modified_files
    }
}

impl RestoreOutcome for types::UninstallResponse {
    fn succeeded(&self) -> bool {
        self.success
    }

    fn modified_files(&self) -> &[String] {
        &self.modified_files
    }
}
