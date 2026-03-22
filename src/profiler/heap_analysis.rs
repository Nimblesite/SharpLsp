//! Heap analysis via `dotnet-dump analyze` with scripted commands.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tracing::{debug, info};

use super::tool_discovery;

/// Parameters for heap analysis.
#[derive(Debug, Deserialize)]
pub struct AnalyzeHeapParams {
    pub dump_path: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    pub type_filter: Option<String>,
}

/// Heap statistics result.
#[derive(Debug, Serialize)]
pub struct HeapStats {
    pub total_objects: u64,
    pub total_size_bytes: u64,
    pub types: Vec<HeapTypeInfo>,
}

/// Per-type heap statistics.
#[derive(Debug, Clone, Serialize)]
pub struct HeapTypeInfo {
    pub type_name: String,
    pub count: u64,
    pub total_size_bytes: u64,
}

/// Parameters for GC root analysis.
#[derive(Debug, Deserialize)]
pub struct FindGcRootsParams {
    pub dump_path: String,
    pub object_address: String,
}

/// A node in a GC root chain.
#[derive(Debug, Clone, Serialize)]
pub struct GcRootNode {
    pub address: String,
    pub type_name: String,
    pub root_kind: String,
}

/// A chain from an object to its GC root.
#[derive(Debug, Serialize)]
pub struct GcRootChain {
    pub roots: Vec<GcRootNode>,
}

/// Analyze heap statistics from a dump file.
pub async fn analyze_heap(params: AnalyzeHeapParams) -> Result<HeapStats> {
    let tool = tool_discovery::require_dump()?;
    validate_dump_path(&params.dump_path)?;

    info!(dump = %params.dump_path, "Analyzing heap statistics");

    // Run `dumpheap -stat` via dotnet-dump analyze with piped commands.
    let output = run_dump_command(tool, &params.dump_path, "dumpheap -stat")
        .await
        .context("failed to run dotnet-dump analyze")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut types = parse_dumpheap_stat(&stdout);

    // Apply type filter if specified.
    if let Some(ref filter) = params.type_filter {
        let filter_lower = filter.to_lowercase();
        types.retain(|t| t.type_name.to_lowercase().contains(&filter_lower));
    }

    // Sort by total size descending.
    types.sort_by(|a, b| b.total_size_bytes.cmp(&a.total_size_bytes));

    // Apply limit.
    types.truncate(params.limit);

    let total_objects: u64 = types.iter().map(|t| t.count).sum();
    let total_size_bytes: u64 = types.iter().map(|t| t.total_size_bytes).sum();

    debug!(
        type_count = types.len(),
        total_objects = total_objects,
        total_size = total_size_bytes,
        "Heap analysis complete"
    );

    Ok(HeapStats {
        total_objects,
        total_size_bytes,
        types,
    })
}

/// Find GC roots for a specific object address.
pub async fn find_gc_roots(params: FindGcRootsParams) -> Result<Vec<GcRootChain>> {
    let tool = tool_discovery::require_dump()?;
    validate_dump_path(&params.dump_path)?;

    info!(
        dump = %params.dump_path,
        address = %params.object_address,
        "Finding GC roots"
    );

    let command_str = format!("gcroot {}", params.object_address);

    let output = run_dump_command(tool, &params.dump_path, &command_str)
        .await
        .context("failed to run dotnet-dump analyze for gcroot")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let chains = parse_gcroot_output(&stdout);

    info!(chain_count = chains.len(), "GC root analysis complete");
    Ok(chains)
}

/// Run a command in the dotnet-dump analyze interactive session.
///
/// Spawns `dotnet-dump analyze <dump>`, writes the command + exit to stdin,
/// then collects the full stdout output.
async fn run_dump_command(
    tool: &std::path::Path,
    dump_path: &str,
    command: &str,
) -> Result<std::process::Output> {
    let mut child = tokio::process::Command::new(tool)
        .args(["analyze", dump_path])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("spawn dotnet-dump analyze")?;

    let input = format!("{command}\nexit\n");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes()).await;
        // Drop stdin to signal EOF.
        drop(stdin);
    }

    child
        .wait_with_output()
        .await
        .context("wait for dotnet-dump analyze")
}

/// Parse `dumpheap -stat` output into type info structs.
///
/// Expected format:
/// ```text
///               MT    Count    TotalSize Class Name
/// 00007ff...    1234     98765 System.String
/// 00007ff...     567     45678 System.Object[]
/// ```
fn parse_dumpheap_stat(output: &str) -> Vec<HeapTypeInfo> {
    output
        .lines()
        .filter_map(parse_dumpheap_stat_line)
        .collect()
}

fn parse_dumpheap_stat_line(line: &str) -> Option<HeapTypeInfo> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("MT") || trimmed.starts_with("Total") {
        return None;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    // Expected: MT, Count, TotalSize, ClassName (may contain spaces)
    if parts.len() < 4 {
        return None;
    }

    // First token is MT (hex address), skip it.
    let count: u64 = parts.get(1)?.parse().ok()?;
    let total_size: u64 = parts.get(2)?.parse().ok()?;
    let type_name = parts.get(3..)?.join(" ");

    Some(HeapTypeInfo {
        type_name,
        count,
        total_size_bytes: total_size,
    })
}

/// Parse `gcroot` output into root chains.
///
/// Expected format:
/// ```text
/// Thread abcd:
///     00007ff... 00007ff... System.String
///     ->  00007ff... System.Collections.Generic.List`1
///     ->  00007ff... MyApp.Service
///
/// Found 1 unique root(s).
/// ```
fn parse_gcroot_output(output: &str) -> Vec<GcRootChain> {
    let mut chains: Vec<GcRootChain> = Vec::new();
    let mut current_roots: Vec<GcRootNode> = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("Thread") || trimmed.starts_with("HandleTable") {
            if !current_roots.is_empty() {
                chains.push(GcRootChain {
                    roots: std::mem::take(&mut current_roots),
                });
            }
            continue;
        }

        if trimmed.starts_with("Found") || trimmed.is_empty() {
            continue;
        }

        // Parse root node lines: "-> address TypeName" or "address address TypeName"
        let clean = trimmed.trim_start_matches("->").trim();
        let parts: Vec<&str> = clean.split_whitespace().collect();
        if parts.len() >= 2 {
            // The first hex-looking token is the address.
            let address = (*parts.first().unwrap_or(&"")).to_string();
            let type_name = if parts.len() > 2
                && parts
                    .get(1)
                    .is_some_and(|p| p.starts_with("0x") || p.len() > 8)
            {
                parts.get(2..).unwrap_or_default().join(" ")
            } else {
                parts.get(1..).unwrap_or_default().join(" ")
            };

            current_roots.push(GcRootNode {
                address,
                type_name,
                root_kind: if trimmed.starts_with("->") {
                    "Reference".to_string()
                } else {
                    "Root".to_string()
                },
            });
        }
    }

    if !current_roots.is_empty() {
        chains.push(GcRootChain {
            roots: current_roots,
        });
    }

    chains
}

fn default_limit() -> usize {
    50
}

/// Verify the dump file exists before invoking `dotnet-dump analyze`.
fn validate_dump_path(path: &str) -> Result<()> {
    if !std::path::Path::new(path).exists() {
        anyhow::bail!("dump file not found: {path}");
    }
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_dumpheap_stat_line() {
        let line = "00007ff8abcd1234     1500       48000 System.String";
        let info = parse_dumpheap_stat_line(line).unwrap();
        assert_eq!(info.type_name, "System.String");
        assert_eq!(info.count, 1500);
        assert_eq!(info.total_size_bytes, 48000);
    }

    #[test]
    fn test_parse_dumpheap_stat_header_skipped() {
        assert!(parse_dumpheap_stat_line("MT    Count    TotalSize Class Name").is_none());
        assert!(parse_dumpheap_stat_line("Total 12345 objects").is_none());
    }

    #[test]
    fn test_parse_dumpheap_stat_multiword_type() {
        let line = "00007ff8abcd1234       10         320 System.Collections.Generic.List`1[[System.String]]";
        let info = parse_dumpheap_stat_line(line).unwrap();
        assert_eq!(
            info.type_name,
            "System.Collections.Generic.List`1[[System.String]]"
        );
    }

    #[test]
    fn test_parse_gcroot_output() {
        let output = "\
Thread abcd:\n\
    00007ff800001111 00007ff800002222 System.String\n\
    ->  00007ff800003333 MyApp.Service\n\
\n\
Found 1 unique root(s).\n";

        let chains = parse_gcroot_output(output);
        assert_eq!(chains.len(), 1);
        assert_eq!(chains[0].roots.len(), 2);
        assert_eq!(chains[0].roots[0].root_kind, "Root");
        assert_eq!(chains[0].roots[1].root_kind, "Reference");
        assert_eq!(chains[0].roots[1].type_name, "MyApp.Service");
    }
}
