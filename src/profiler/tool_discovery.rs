//! Locate .NET diagnostic CLI tools on the system.
//!
//! Searches `PATH` first, then `dotnet tool list -g` output.
//! Caches discovered paths for subsequent calls.

use std::path::PathBuf;
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

/// Try to find a tool on PATH, then fall back to `dotnet tool list -g`.
fn find_tool(name: &str) -> Option<PathBuf> {
    if let Some(path) = find_on_path(name) {
        return Some(path);
    }
    find_via_dotnet_tool_list(name)
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

/// Parse `dotnet tool list -g` to find the tool's install path.
fn find_via_dotnet_tool_list(name: &str) -> Option<PathBuf> {
    debug!("{name} not on PATH, checking dotnet tool list -g");
    let output = std::process::Command::new("dotnet")
        .args(["tool", "list", "-g"])
        .output()
        .ok()?;

    if !output.status.success() {
        warn!("dotnet tool list -g failed");
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let found = stdout.lines().any(|line| {
        line.split_whitespace()
            .next()
            .is_some_and(|first| first.eq_ignore_ascii_case(name))
    });

    if found {
        // Tool is installed globally — dotnet resolves the shim automatically.
        Some(PathBuf::from(name))
    } else {
        None
    }
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
    fn find_via_dotnet_tool_list_nonexistent() {
        let result = find_via_dotnet_tool_list("nonexistent-tool-abc123xyz");
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
    fn find_via_dotnet_tool_list_runs_dotnet() {
        // dotnet-dump is commonly installed; either way, this exercises the code.
        let _ = find_via_dotnet_tool_list("dotnet-dump");
    }
}
