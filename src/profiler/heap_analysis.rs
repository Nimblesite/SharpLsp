//! Heap analysis via `dotnet-dump analyze` with scripted commands.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use super::{dump_cmd, tool_discovery};

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
    dump_cmd::validate_dump_path(&params.dump_path)?;

    info!(dump = %params.dump_path, "Analyzing heap statistics");

    // Run `dumpheap -stat` via dotnet-dump analyze with piped commands.
    let output = dump_cmd::run(tool, &params.dump_path, "dumpheap -stat")
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
    dump_cmd::validate_dump_path(&params.dump_path)?;

    info!(
        dump = %params.dump_path,
        address = %params.object_address,
        "Finding GC roots"
    );

    let command_str = format!("gcroot {}", params.object_address);

    let output = dump_cmd::run(tool, &params.dump_path, &command_str)
        .await
        .context("failed to run dotnet-dump analyze for gcroot")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let chains = parse_gcroot_output(&stdout);

    info!(chain_count = chains.len(), "GC root analysis complete");
    Ok(chains)
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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#[expect(
    clippy::indexing_slicing,
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

    #[test]
    fn test_parse_gcroot_output_multiple_chains() {
        let output = "\
Thread 1234:\n\
    00007ff800001111 00007ff800002222 System.String\n\
Thread 5678:\n\
    00007ff800003333 00007ff800004444 System.Object\n\
    ->  00007ff800005555 MyApp.Handler\n\
\n\
Found 2 unique root(s).\n";

        let chains = parse_gcroot_output(output);
        assert_eq!(chains.len(), 2);
        assert_eq!(chains[0].roots.len(), 1);
        assert_eq!(chains[1].roots.len(), 2);
    }

    #[test]
    fn test_parse_gcroot_output_handle_table() {
        let output = "\
HandleTable:\n\
    00007ff800001111 System.EventHandler\n\
\n\
Found 1 unique root(s).\n";

        let chains = parse_gcroot_output(output);
        assert_eq!(chains.len(), 1);
        assert_eq!(chains[0].roots.len(), 1);
    }

    #[test]
    fn test_parse_gcroot_output_empty() {
        let chains = parse_gcroot_output("Found 0 unique root(s).\n");
        assert!(chains.is_empty());
    }

    #[test]
    fn test_parse_gcroot_output_no_thread_header() {
        // Lines without a Thread/HandleTable header go into a single chain
        let output = "\
    00007ff800001111 System.Object\n\
    ->  00007ff800002222 MyApp.Service\n";

        let chains = parse_gcroot_output(output);
        assert_eq!(chains.len(), 1);
        assert_eq!(chains[0].roots.len(), 2);
    }

    #[test]
    fn test_parse_dumpheap_stat_full_output() {
        let output = "\
              MT    Count    TotalSize Class Name
00007ff8abcd1234     1500       48000 System.String
00007ff8abcd5678      200       16000 System.Object[]
Total 1700 objects
";
        let types = parse_dumpheap_stat(output);
        assert_eq!(types.len(), 2);
        assert_eq!(types[0].type_name, "System.String");
        assert_eq!(types[0].count, 1500);
        assert_eq!(types[0].total_size_bytes, 48000);
        assert_eq!(types[1].type_name, "System.Object[]");
        assert_eq!(types[1].count, 200);
    }

    #[test]
    fn test_parse_dumpheap_stat_empty_output() {
        assert!(parse_dumpheap_stat("").is_empty());
        assert!(parse_dumpheap_stat("\n\n").is_empty());
    }

    #[test]
    fn test_parse_dumpheap_stat_line_short_line() {
        assert!(parse_dumpheap_stat_line("foo bar").is_none());
        assert!(parse_dumpheap_stat_line("one two three").is_none());
    }

    #[test]
    fn test_parse_dumpheap_stat_line_non_numeric_count() {
        assert!(parse_dumpheap_stat_line("00007ff8  abc  1234 System.String").is_none());
    }

    #[test]
    fn test_default_limit() {
        assert_eq!(default_limit(), 50);
    }
}
