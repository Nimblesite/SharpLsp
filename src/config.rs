//! Configuration system for Forge LSP.
//!
//! Loads settings from `forge.toml` found by walking up from the workspace root.
//! Falls back to sensible defaults when no config file is present.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;
use tracing::info;

/// Top-level configuration loaded from `forge.toml`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ForgeConfig {
    /// General server settings.
    pub server: ServerConfig,
    /// C# sidecar configuration.
    pub csharp: CSharpConfig,
    /// F# sidecar configuration.
    pub fsharp: FSharpConfig,
    /// Diagnostics settings.
    pub diagnostics: DiagnosticsConfig,
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
            output_directory: ".forge/profiles".to_string(),
        }
    }
}

/// The config file name we search for.
const CONFIG_FILE_NAME: &str = "forge.toml";

/// Load configuration by searching for `forge.toml` starting from `workspace_root`
/// and walking up to parent directories. Returns defaults if no file is found.
pub fn load_config(workspace_root: &Path) -> Result<ForgeConfig> {
    if let Some(path) = find_config_file(workspace_root) {
        info!("Loading configuration from {}", path.display());
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let config: ForgeConfig = toml::from_str(&content)
            .with_context(|| format!("failed to parse {}", path.display()))?;
        Ok(config)
    } else {
        info!("No forge.toml found, using default configuration");
        Ok(ForgeConfig::default())
    }
}

/// Walk up from `start` looking for `forge.toml`.
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
        let config = ForgeConfig::default();
        assert_eq!(config.server.log_level, "info");
        assert_eq!(config.server.debounce_ms, 150);
        assert!(config.csharp.enabled);
        assert!(config.fsharp.enabled);
        assert!(config.diagnostics.analyzers_enabled);
        assert!(config.diagnostics.solution_wide_analysis);
        assert!(config.diagnostics.project_filter.is_empty());
        assert_eq!(config.profiler.max_concurrent_sessions, 5);
        assert_eq!(config.profiler.default_trace_duration, 30);
        assert_eq!(config.profiler.output_directory, ".forge/profiles");
    }

    #[test]
    fn test_parse_minimal_toml() {
        let toml_str = "";
        let config: ForgeConfig = toml::from_str(toml_str).unwrap();
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
        let config: ForgeConfig = toml::from_str(toml_str).unwrap();
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

    #[test]
    fn test_unknown_fields_rejected() {
        let toml_str = r"
[server]
nonexistent_field = true
";
        let result: std::result::Result<ForgeConfig, _> = toml::from_str(toml_str);
        assert!(result.is_err());
    }

    #[test]
    fn test_find_config_file_in_directory() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("forge.toml");
        fs::write(&config_path, "[server]\nlog_level = \"trace\"\n").unwrap();

        let found = find_config_file(temp.path());
        assert_eq!(found, Some(config_path));
    }

    #[test]
    fn test_find_config_file_walks_up() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("forge.toml");
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
        let config_path = temp.path().join("forge.toml");
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
