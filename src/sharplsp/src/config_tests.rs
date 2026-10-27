//! Configuration loading and defaults. [CONFIG-EDITOR-BRIDGE]
#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
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
    assert!(
        matches!(config.diagnostics.project_filter.as_slice(), []),
        "{:?}",
        config.diagnostics.project_filter
    );
    assert!(config.analyzers.dead_code);
    assert!(!config.analyzers.monorepo);
    assert_eq!(config.profiler.max_concurrent_sessions, 5);
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
    let config = load_config(temp.path(), &serde_json::json!({})).unwrap();
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

    let config = load_config(temp.path(), &serde_json::json!({})).unwrap();
    assert_eq!(config.server.log_level, "warn");
    assert_eq!(config.server.debounce_ms, 300);
    assert!(!config.fsharp.enabled);
    assert!(config.csharp.enabled);
}
