//! Configuration system for `SharpLsp`.
//!
//! Loads settings from `sharplsp.toml` found by walking up from the workspace root.
//! Falls back to sensible defaults when no config file is present.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// Top-level configuration loaded from `sharplsp.toml`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SharpLspConfig {
    /// Editor-independent test build settings. Implements [TEST-BUILD-CONFIGURATION].
    pub testing: TestingConfig,
    /// Editor-independent debugger policy.
    pub debug: crate::config_debug::DebugConfig,
    /// General server settings.
    pub server: ServerConfig,
    /// C# sidecar configuration.
    pub csharp: CSharpConfig,
    /// F# sidecar configuration.
    pub fsharp: FSharpConfig,
    /// Diagnostics settings.
    pub diagnostics: DiagnosticsConfig,
    /// Static analyzer settings (dead-code, monorepo gating).
    pub analyzers: AnalyzersConfig,
    /// Profiler settings.
    pub profiler: ProfilerConfig,
}

/// Configuration shared by test discovery, execution and debugging.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct TestingConfig {
    /// `MSBuild` configuration, explicitly Debug unless the user overrides it.
    pub configuration: String,
}

impl Default for TestingConfig {
    fn default() -> Self {
        Self {
            configuration: "Debug".to_owned(),
        }
    }
}

/// Server-level settings.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Log level filter (e.g. "info", "debug", "trace").
    pub log_level: String,
    /// Debounce window in milliseconds for semantic requests.
    pub debounce_ms: u64,
}

/// C# sidecar configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct CSharpConfig {
    /// Whether C# support is enabled.
    pub enabled: bool,
    /// Path to the solution file. Auto-detected if empty.
    pub solution_path: String,
}

/// F# sidecar configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct FSharpConfig {
    /// Whether F# support is enabled.
    pub enabled: bool,
}

/// Diagnostics configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct DiagnosticsConfig {
    /// Whether to run Roslyn analyzers.
    pub analyzers_enabled: bool,
    /// Whether to run solution-wide analysis.
    pub solution_wide_analysis: bool,
    /// Project name patterns to include (empty = all projects).
    pub project_filter: Vec<String>,
    /// Drop diagnostics below this severity. Implements [DIAG-CONFIG].
    pub min_severity: MinimumDiagnosticSeverity,
    /// Maximum diagnostics per file after filtering; zero is unlimited. [DIAG-CONFIG]
    pub max_per_file: usize,
    /// Coalesce diagnostic refreshes for this many milliseconds. [DIAG-LSP-REFRESH]
    pub refresh_debounce_ms: u64,
    /// Restore stale project assets before explicitly opening a workspace. [DIAG-RESTORE]
    pub auto_restore_on_open: bool,
}

/// Validated diagnostic severity threshold. Implements [DIAG-CONFIG].
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MinimumDiagnosticSeverity {
    /// Compiler or analyzer errors only.
    Error,
    /// Errors and warnings.
    Warning,
    /// Errors, warnings and informational diagnostics.
    Info,
    /// Include hints as well.
    #[default]
    Hint,
}

impl MinimumDiagnosticSeverity {
    /// The threshold uses the protocol's existing severity ordering.
    pub fn lsp(self) -> lsp_types::DiagnosticSeverity {
        match self {
            Self::Error => lsp_types::DiagnosticSeverity::ERROR,
            Self::Warning => lsp_types::DiagnosticSeverity::WARNING,
            Self::Info => lsp_types::DiagnosticSeverity::INFORMATION,
            Self::Hint => lsp_types::DiagnosticSeverity::HINT,
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            log_level: "info".to_string(),
            debounce_ms: 150,
        }
    }
}

impl Default for CSharpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            solution_path: String::new(),
        }
    }
}

impl CSharpConfig {
    /// The path to hand the C# sidecar's `workspace/open`.
    ///
    /// A workspace root holding more than one `.sln`/`.slnx` is ambiguous, and
    /// the sidecar's recursive discovery deliberately refuses to guess — it
    /// returns no target, and the whole solution fails to load. `solution_path`
    /// is how the user resolves that: it names the solution to open, absolute
    /// or relative to the workspace root.
    ///
    /// Falls back to the root — restoring plain auto-discovery — when unset, or
    /// when the configured path names no existing file. Implements
    /// [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
    pub fn open_target(&self, workspace_root: &Path) -> PathBuf {
        let configured = self.solution_path.trim();
        if configured.is_empty() {
            return workspace_root.to_path_buf();
        }

        let candidate = Path::new(configured);
        let resolved = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            workspace_root.join(candidate)
        };

        if resolved.is_file() {
            info!("Opening configured solution {}", resolved.display());
            return resolved;
        }

        warn!(
            "csharp.solution_path `{configured}` does not name an existing file ({}); \
             falling back to workspace-root discovery",
            resolved.display()
        );
        workspace_root.to_path_buf()
    }
}

impl Default for FSharpConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl Default for DiagnosticsConfig {
    fn default() -> Self {
        Self {
            analyzers_enabled: true,
            solution_wide_analysis: true,
            project_filter: Vec::new(),
            min_severity: MinimumDiagnosticSeverity::default(),
            max_per_file: 0,
            refresh_debounce_ms: 2_000,
            auto_restore_on_open: true,
        }
    }
}

/// Static-analyzer configuration. Drives the novel monorepo dead-code analyzer
/// implemented in both the F# (FCS) and C# (Roslyn) sidecars.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AnalyzersConfig {
    /// Whether the dead-code analyzer runs at all.
    pub dead_code: bool,
    /// When `true`, the workspace is the entire world: a public symbol with no
    /// uses anywhere is genuinely dead and is reported as an **error**. When
    /// `false`, public symbols are assumed to be an external API and only
    /// private/internal dead code is reported (as a warning).
    pub monorepo: bool,
}

impl Default for AnalyzersConfig {
    fn default() -> Self {
        Self {
            dead_code: true,
            monorepo: false,
        }
    }
}

/// Profiler configuration.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProfilerConfig {
    /// Maximum concurrent profiling sessions (CPU and memory together).
    pub max_concurrent_sessions: u32,
    /// Output directory for profile artifacts, relative to the workspace root.
    pub output_directory: String,
}

impl Default for ProfilerConfig {
    fn default() -> Self {
        Self {
            max_concurrent_sessions: 5,
            output_directory: ".sharplsp/profiles".to_string(),
        }
    }
}

/// The config file name we search for.
const CONFIG_FILE_NAME: &str = "sharplsp.toml";

/// Load configuration by searching for `sharplsp.toml` starting from `workspace_root`
/// and walking up to parent directories, with the editor's `client` settings layered
/// on top. Returns defaults if no file is found.
pub fn load_config(workspace_root: &Path, client: &serde_json::Value) -> Result<SharpLspConfig> {
    let value = crate::configuration::resolve(
        workspace_root,
        crate::configuration::user_config_file().as_deref(),
        client,
        serde_json::json!({}),
    )?;
    Ok(serde_json::from_value(value)?)
}

/// Walk up from `start` looking for `sharplsp.toml`.
pub(crate) fn find_config_file(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join(CONFIG_FILE_NAME);
        if candidate.is_file() {
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
