//! Configuration system for `SharpLsp`.
//!
//! Loads settings from `sharplsp.toml` found by walking up from the workspace root.
//! Falls back to sensible defaults when no config file is present.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;
use tracing::{info, warn};

/// Top-level configuration loaded from `sharplsp.toml`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SharpLspConfig {
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

/// Server-level settings.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Log level filter (e.g. "info", "debug", "trace").
    pub log_level: String,
    /// Debounce window in milliseconds for semantic requests.
    pub debounce_ms: u64,
}

/// C# sidecar configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CSharpConfig {
    /// Whether C# support is enabled.
    pub enabled: bool,
    /// Path to the solution file. Auto-detected if empty.
    pub solution_path: String,
}

/// F# sidecar configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FSharpConfig {
    /// Whether F# support is enabled.
    pub enabled: bool,
}

/// Diagnostics configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DiagnosticsConfig {
    /// Whether to run Roslyn analyzers.
    pub analyzers_enabled: bool,
    /// Whether to run solution-wide analysis.
    pub solution_wide_analysis: bool,
    /// Project name patterns to include (empty = all projects).
    pub project_filter: Vec<String>,
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
        }
    }
}

/// Static-analyzer configuration. Drives the novel monorepo dead-code analyzer
/// implemented in both the F# (FCS) and C# (Roslyn) sidecars.
#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProfilerConfig {
    /// Maximum concurrent profiling sessions.
    pub max_concurrent_sessions: u32,
    /// Default trace duration in seconds (0 = unlimited).
    pub default_trace_duration: u32,
    /// Default trace output format.
    pub default_trace_format: String,
    /// Default counter providers.
    pub default_counter_providers: Vec<String>,
    /// Default counter refresh interval in seconds.
    pub default_counter_interval: u32,
    /// Output directory for trace/dump files.
    pub output_directory: String,
}

impl Default for ProfilerConfig {
    fn default() -> Self {
        Self {
            max_concurrent_sessions: 5,
            default_trace_duration: 30,
            default_trace_format: "speedscope".to_string(),
            default_counter_providers: vec!["System.Runtime".to_string()],
            default_counter_interval: 1,
            output_directory: ".sharplsp/profiles".to_string(),
        }
    }
}

/// The config file name we search for.
const CONFIG_FILE_NAME: &str = "sharplsp.toml";

/// Load configuration by searching for `sharplsp.toml` starting from `workspace_root`
/// and walking up to parent directories. Returns defaults if no file is found.
pub fn load_config(workspace_root: &Path) -> Result<SharpLspConfig> {
    if let Some(path) = find_config_file(workspace_root) {
        info!("Loading configuration from {}", path.display());
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let config: SharpLspConfig = toml::from_str(&content)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        Ok(config)
    } else {
        info!("No sharplsp.toml found, using default configuration");
        Ok(SharpLspConfig::default())
    }
}

/// Walk up from `start` looking for `sharplsp.toml`.
fn find_config_file(start: &Path) -> Option<PathBuf> {
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
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_default_config() {
        let config = SharpLspConfig::default();
        assert_eq!(config.server.log_level, "info");
        assert_eq!(config.server.debounce_ms, 150);
        assert!(config.csharp.enabled);
        assert!(config.fsharp.enabled);
        assert!(config.diagnostics.analyzers_enabled);
        assert!(config.diagnostics.solution_wide_analysis);
        assert!(config.diagnostics.project_filter.is_empty());
        assert!(config.analyzers.dead_code);
        assert!(!config.analyzers.monorepo);
        assert_eq!(config.profiler.max_concurrent_sessions, 5);
        assert_eq!(config.profiler.default_trace_duration, 30);
        assert_eq!(config.profiler.output_directory, ".sharplsp/profiles");
    }

    #[test]
    fn test_parse_minimal_toml() {
        let toml_str = "";
        let config: SharpLspConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.server.debounce_ms, 150);
    }

    #[test]
    fn test_parse_partial_toml() {
        let toml_str = r#"
[server]
log_level = "debug"
debounce_ms = 200

[csharp]
solution_path = "MyApp.sln"

[diagnostics]
solution_wide_analysis = true
project_filter = ["MyApp.Core", "MyApp.Api"]
"#;
        let config: SharpLspConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.server.log_level, "debug");
        assert_eq!(config.server.debounce_ms, 200);
        assert_eq!(config.csharp.solution_path, "MyApp.sln");
        assert!(config.diagnostics.solution_wide_analysis);
        assert_eq!(
            config.diagnostics.project_filter,
            vec!["MyApp.Core", "MyApp.Api"]
        );
        // Defaults still apply for unset fields
        assert!(config.fsharp.enabled);
    }

    /// A configured `solution_path` must be the path opened, not the workspace
    /// root. Sending the root leaves the sidecar to rediscover, and in a root
    /// holding several solutions that discovery is ambiguous and loads nothing —
    /// no hover, no completions, no diagnostics. Implements
    /// [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
    #[test]
    fn test_relative_solution_path_is_opened_not_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let app = root.join("app");
        fs::create_dir_all(&app).unwrap();
        let sln = app.join("App.sln");
        fs::write(&sln, "").unwrap();
        // A second solution elsewhere is what makes discovery ambiguous.
        fs::create_dir_all(root.join("other")).unwrap();
        fs::write(root.join("other").join("Other.sln"), "").unwrap();

        let config = CSharpConfig {
            enabled: true,
            solution_path: "app/App.sln".to_string(),
        };

        assert_eq!(config.open_target(root), sln);
    }

    #[test]
    fn test_absolute_solution_path_is_opened() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sln = root.join("Explicit.sln");
        fs::write(&sln, "").unwrap();

        let config = CSharpConfig {
            enabled: true,
            solution_path: sln.to_string_lossy().to_string(),
        };

        assert_eq!(config.open_target(root), sln);
    }

    #[test]
    fn test_empty_solution_path_falls_back_to_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        assert_eq!(CSharpConfig::default().open_target(root), root);
    }

    /// A stale or misspelled `solution_path` must not wedge the sidecar on a
    /// path that does not exist — auto-discovery is the safer fallback.
    #[test]
    fn test_missing_solution_path_falls_back_to_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let config = CSharpConfig {
            enabled: true,
            solution_path: "does/not/exist.sln".to_string(),
        };

        assert_eq!(config.open_target(root), root);
    }

    /// A directory is not a solution; treat it as unset rather than opening it
    /// as though it were a file the user chose.
    #[test]
    fn test_directory_solution_path_falls_back_to_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("app")).unwrap();

        let config = CSharpConfig {
            enabled: true,
            solution_path: "app".to_string(),
        };

        assert_eq!(config.open_target(root), root);
    }

    #[test]
    fn test_unknown_fields_rejected() {
        let toml_str = r"
[server]
nonexistent_field = true
";
        let result: std::result::Result<SharpLspConfig, _> = toml::from_str(toml_str);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_analyzers_section() {
        let toml_str = r"
[analyzers]
dead_code = true
monorepo = true
";
        let config: SharpLspConfig = toml::from_str(toml_str).unwrap();
        assert!(config.analyzers.dead_code);
        assert!(config.analyzers.monorepo);
    }

    #[test]
    fn test_analyzers_partial_override_keeps_defaults() {
        // Only `monorepo` set: `dead_code` must fall back to its default of true.
        let toml_str = r"
[analyzers]
monorepo = true
";
        let config: SharpLspConfig = toml::from_str(toml_str).unwrap();
        assert!(config.analyzers.dead_code);
        assert!(config.analyzers.monorepo);
    }

    #[test]
    fn test_analyzers_defaults_when_section_absent() {
        let config: SharpLspConfig = toml::from_str("").unwrap();
        assert!(config.analyzers.dead_code);
        assert!(!config.analyzers.monorepo);
    }

    #[test]
    fn test_analyzers_unknown_field_rejected() {
        let toml_str = r"
[analyzers]
bogus = true
";
        let result: std::result::Result<SharpLspConfig, _> = toml::from_str(toml_str);
        assert!(result.is_err());
    }

    #[test]
    fn test_find_config_file_in_directory() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("sharplsp.toml");
        fs::write(&config_path, "[server]\nlog_level = \"trace\"\n").unwrap();

        let found = find_config_file(temp.path());
        assert_eq!(found, Some(config_path));
    }

    #[test]
    fn test_find_config_file_walks_up() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("sharplsp.toml");
        fs::write(&config_path, "").unwrap();

        let subdir = temp.path().join("src").join("deep");
        fs::create_dir_all(&subdir).unwrap();

        let found = find_config_file(&subdir);
        assert_eq!(found, Some(config_path));
    }

    #[test]
    fn test_find_config_file_none() {
        let temp = tempfile::tempdir().unwrap();
        let found = find_config_file(temp.path());
        assert!(found.is_none());
    }

    #[test]
    fn test_load_config_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let config = load_config(temp.path()).unwrap();
        assert_eq!(config.server.log_level, "info");
    }

    #[test]
    fn test_load_config_from_file() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("sharplsp.toml");
        fs::write(
            &config_path,
            r#"
[server]
log_level = "warn"
debounce_ms = 300

[fsharp]
enabled = false
"#,
        )
        .unwrap();

        let config = load_config(temp.path()).unwrap();
        assert_eq!(config.server.log_level, "warn");
        assert_eq!(config.server.debounce_ms, 300);
        assert!(!config.fsharp.enabled);
        assert!(config.csharp.enabled);
    }
}
