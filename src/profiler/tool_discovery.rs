//! Locate .NET diagnostic CLI tools on the system.
//!
//! Searches `PATH` first, then well-known .NET global tool shim directories.
//! Caches discovered paths for subsequent calls.

use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use tracing::{debug, info, warn};

/// Cached tool paths, populated on first access.
static TOOL_PATHS: OnceLock<ToolPaths> = OnceLock::new();

/// Resolved paths for each diagnostic tool.
#[derive(Debug)]
pub struct ToolPaths {
    /// Path to `dotnet-trace`, if found.
    pub trace: Option<PathBuf>,
    /// Path to `dotnet-counters`, if found.
    pub counters: Option<PathBuf>,
    /// Path to `dotnet-dump`, if found.
    pub dump: Option<PathBuf>,
}

/// Get cached tool paths, discovering them on first call.
pub fn get() -> &'static ToolPaths {
    TOOL_PATHS.get_or_init(discover)
}

/// Resolve a specific tool, returning an error with install instructions if missing.
pub fn require_trace() -> Result<&'static PathBuf> {
    get()
        .trace
        .as_ref()
        .context("dotnet-trace not found. Install with: dotnet tool install -g dotnet-trace")
}

/// Resolve `dotnet-counters`, returning an error with install instructions if missing.
pub fn require_counters() -> Result<&'static PathBuf> {
    get()
        .counters
        .as_ref()
        .context("dotnet-counters not found. Install with: dotnet tool install -g dotnet-counters")
}

/// Resolve `dotnet-dump`, returning an error with install instructions if missing.
pub fn require_dump() -> Result<&'static PathBuf> {
    get()
        .dump
        .as_ref()
        .context("dotnet-dump not found. Install with: dotnet tool install -g dotnet-dump")
}

/// Discover all diagnostic tools.
fn discover() -> ToolPaths {
    info!("Discovering .NET diagnostic tools");
    let trace = find_tool("dotnet-trace");
    let counters = find_tool("dotnet-counters");
    let dump = find_tool("dotnet-dump");

    log_discovery("dotnet-trace", trace.as_ref());
    log_discovery("dotnet-counters", counters.as_ref());
    log_discovery("dotnet-dump", dump.as_ref());

    ToolPaths {
        trace,
        counters,
        dump,
    }
}

/// Try to find a tool on PATH, then fall back to .NET global tool shims.
fn find_tool(name: &str) -> Option<PathBuf> {
    if let Some(path) = find_on_path(name) {
        return Some(path);
    }
    find_global_tool_shim(name)
}

/// Check if the tool is directly available on PATH via `which`/`where`.
fn find_on_path(name: &str) -> Option<PathBuf> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let output = std::process::Command::new(cmd).arg(name).output().ok()?;

    if !output.status.success() {
        return None;
    }

    let path_str = String::from_utf8_lossy(&output.stdout);
    let first_line = path_str.lines().next()?.trim();
    if first_line.is_empty() {
        return None;
    }

    let path = PathBuf::from(first_line);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Check the conventional .NET global tool shim locations without invoking dotnet.
fn find_global_tool_shim(name: &str) -> Option<PathBuf> {
    debug!("{name} not on PATH, checking .NET global tool shims");
    find_global_tool_shim_in_roots(name, &global_tool_roots())
}

/// Look for a tool shim under the provided global-tool roots.
fn find_global_tool_shim_in_roots(name: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let file_name = tool_file_name(name);
    roots
        .iter()
        .map(|root| root.join(&file_name))
        .find(|path| path.exists())
}

/// Return conventional .NET global tool directories for the current user.
fn global_tool_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    push_env_global_tool_root(&mut roots, "DOTNET_CLI_HOME");
    push_env_global_tool_root(&mut roots, "HOME");
    #[cfg(windows)]
    push_env_global_tool_root(&mut roots, "USERPROFILE");
    roots
}

/// Add an environment variable's global-tool root when the variable is set.
fn push_env_global_tool_root(roots: &mut Vec<PathBuf>, key: &str) {
    if let Some(home) = env::var_os(key) {
        let home = PathBuf::from(home);
        push_global_tool_root(roots, &home);
    }
}

/// Add `<home>/.dotnet/tools` to the root list, avoiding duplicates.
fn push_global_tool_root(roots: &mut Vec<PathBuf>, home: &Path) {
    let root = home.join(".dotnet").join("tools");
    if !roots.iter().any(|existing| existing == &root) {
        roots.push(root);
    }
}

/// Return the platform-specific executable file name for a global tool shim.
#[cfg(windows)]
fn tool_file_name(name: &str) -> String {
    format!("{name}.exe")
}

/// Return the platform-specific executable file name for a global tool shim.
#[cfg(not(windows))]
fn tool_file_name(name: &str) -> String {
    name.to_string()
}

/// Log whether a diagnostic tool was found.
fn log_discovery(name: &str, path: Option<&PathBuf>) {
    if let Some(p) = path {
        info!("{name} found: {}", p.display());
    } else {
        warn!("{name} not found");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_on_path_finds_existing_tool() {
        // `ls` (or `cmd` on Windows) is always on PATH.
        let tool = if cfg!(windows) { "cmd" } else { "ls" };
        let result = find_on_path(tool);
        assert!(result.is_some(), "{tool} should be on PATH");
        assert!(result.as_ref().is_some_and(|p| p.exists()));
    }

    #[test]
    fn find_on_path_returns_none_for_nonexistent() {
        let result = find_on_path("nonexistent-tool-abc123xyz");
        assert!(result.is_none());
    }

    #[test]
    fn find_tool_returns_some_for_existing() {
        let tool = if cfg!(windows) { "cmd" } else { "ls" };
        assert!(find_tool(tool).is_some());
    }

    #[test]
    fn find_tool_returns_none_for_nonexistent() {
        assert!(find_tool("nonexistent-tool-abc123xyz").is_none());
    }

    #[test]
    fn find_global_tool_shim_nonexistent() {
        let result = find_global_tool_shim("nonexistent-tool-abc123xyz");
        assert!(result.is_none());
    }

    #[test]
    fn get_returns_static_ref() {
        let paths = get();
        // Calling get() twice returns the same reference.
        let paths2 = get();
        assert!(std::ptr::eq(paths, paths2));
    }

    #[test]
    fn log_discovery_found() {
        let path = PathBuf::from("/usr/bin/dotnet-trace");
        log_discovery("dotnet-trace", Some(&path));
    }

    #[test]
    fn log_discovery_not_found() {
        log_discovery("dotnet-missing", None);
    }

    #[test]
    fn discover_populates_tool_paths() {
        let paths = discover();
        // At minimum, the struct is constructed with Some/None for each tool.
        // We just verify it doesn't panic.
        let _ = format!("{paths:?}");
    }

    #[test]
    fn require_trace_returns_result() {
        // May be Ok or Err depending on whether dotnet-trace is installed.
        let _ = require_trace();
    }

    #[test]
    fn require_counters_returns_result() {
        let _ = require_counters();
    }

    #[test]
    fn require_dump_returns_result() {
        let _ = require_dump();
    }

    #[test]
    fn find_global_tool_shim_in_roots_finds_existing_shim() -> Result<()> {
        let tmp = tempfile::tempdir().context("create temp dir")?;
        let tool = tmp.path().join(tool_file_name("dotnet-dump"));
        std::fs::write(&tool, "").context("write shim")?;

        let result = find_global_tool_shim_in_roots("dotnet-dump", &[tmp.path().to_path_buf()]);
        assert_eq!(result.as_deref(), Some(tool.as_path()));
        Ok(())
    }

    #[test]
    fn push_global_tool_root_deduplicates_roots() {
        let mut roots = Vec::new();
        let home = PathBuf::from("/tmp/sharplsp-home");

        push_global_tool_root(&mut roots, &home);
        push_global_tool_root(&mut roots, &home);

        assert_eq!(roots.len(), 1);
        assert_eq!(
            roots.first().map(PathBuf::as_path),
            Some(Path::new("/tmp/sharplsp-home/.dotnet/tools"))
        );
    }
}
