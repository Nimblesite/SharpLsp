//! Object retention graph — build a reference graph from a managed heap dump
//! using `dumpobj`, `gcroot`, and `objsize` commands via `dotnet-dump analyze`.

use std::collections::{HashMap, HashSet, VecDeque};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use super::{dump_cmd, tool_discovery};

fn default_max_depth() -> usize {
    5
}

fn default_max_nodes() -> usize {
    100
}

/// Parameters for building an object graph.
#[derive(Debug, Deserialize)]
pub struct GetObjectGraphParams {
    pub dump_path: String,
    /// Starting object address (hex). If omitted, requires explicit address.
    pub root_address: String,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
    #[serde(default = "default_max_nodes")]
    pub max_nodes: usize,
    pub type_filter: Option<String>,
}

/// Result of an object graph query.
#[derive(Debug, Serialize)]
pub struct ObjectGraphResult {
    pub nodes: Vec<ObjectGraphNode>,
    pub edges: Vec<ObjectGraphEdge>,
    pub stats: ObjectGraphStats,
}

/// A node in the object retention graph.
#[derive(Debug, Clone, Serialize)]
pub struct ObjectGraphNode {
    pub id: String,
    pub type_name: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub retained_size_bytes: u64,
    pub instance_count: u64,
    pub is_root: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_kind: Option<String>,
    pub depth: usize,
}

/// A directed edge in the object graph (from holder to held object).
#[derive(Debug, Clone, Serialize)]
pub struct ObjectGraphEdge {
    pub from: String,
    pub to: String,
    pub field_name: String,
    pub reference_kind: ReferenceKind,
}

/// Whether a reference is strong or weak.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "PascalCase")]
pub enum ReferenceKind {
    Strong,
}

/// Summary statistics for a graph traversal.
#[derive(Debug, Serialize)]
pub struct ObjectGraphStats {
    pub total_nodes_traversed: usize,
    pub total_edges_traversed: usize,
    pub max_depth_reached: usize,
    pub truncated: bool,
}

/// Build an object retention graph starting from `root_address`.
pub async fn get_object_graph(params: GetObjectGraphParams) -> Result<ObjectGraphResult> {
    let tool = tool_discovery::require_dump()?;
    dump_cmd::validate_dump_path(&params.dump_path)?;

    info!(
        dump = %params.dump_path,
        root = %params.root_address,
        max_depth = params.max_depth,
        max_nodes = params.max_nodes,
        "Building object graph"
    );

    let mut nodes: HashMap<String, ObjectGraphNode> = HashMap::new();
    let mut edges: Vec<ObjectGraphEdge> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    let mut max_depth_reached: usize = 0;
    let mut truncated = false;

    queue.push_back((params.root_address.clone(), 0));

    while let Some((address, depth)) = queue.pop_front() {
        if visited.contains(&address) {
            continue;
        }
        if nodes.len() >= params.max_nodes {
            truncated = true;
            break;
        }

        visited.insert(address.clone());
        max_depth_reached = max_depth_reached.max(depth);

        let dumpobj_output = dump_cmd::run(tool, &params.dump_path, &format!("dumpobj {address}"))
            .await
            .context("dumpobj failed")?;

        let stdout = String::from_utf8_lossy(&dumpobj_output.stdout);
        let parsed = parse_dumpobj_for_graph(&stdout, &address, depth);

        if let Some(node) = parsed.node {
            // Apply type filter: only include nodes whose type_name matches.
            if let Some(ref filter) = params.type_filter {
                let filter_lower = filter.to_lowercase();
                if !node.type_name.to_lowercase().contains(&filter_lower) {
                    continue;
                }
            }

            // Enqueue children if depth allows.
            if depth < params.max_depth {
                for (field_name, child_addr) in &parsed.references {
                    let edge = ObjectGraphEdge {
                        from: address.clone(),
                        to: child_addr.clone(),
                        field_name: field_name.clone(),
                        reference_kind: ReferenceKind::Strong,
                    };
                    edges.push(edge);

                    if !visited.contains(child_addr) {
                        queue.push_back((child_addr.clone(), depth + 1));
                    }
                }
            }

            nodes.insert(address.clone(), node);
        }
    }

    // Annotate root nodes from gcroot output.
    annotate_roots(tool, &params.dump_path, &params.root_address, &mut nodes).await;

    let node_list: Vec<ObjectGraphNode> = nodes.into_values().collect();
    let total_nodes = node_list.len();
    let total_edges = edges.len();

    debug!(
        nodes = total_nodes,
        edges = total_edges,
        max_depth = max_depth_reached,
        "Object graph built"
    );

    Ok(ObjectGraphResult {
        nodes: node_list,
        edges,
        stats: ObjectGraphStats {
            total_nodes_traversed: total_nodes,
            total_edges_traversed: total_edges,
            max_depth_reached,
            truncated,
        },
    })
}

struct ParsedNode {
    node: Option<ObjectGraphNode>,
    references: Vec<(String, String)>,
}

/// Parse `dumpobj` output to extract a graph node and its outgoing references.
fn parse_dumpobj_for_graph(output: &str, address: &str, depth: usize) -> ParsedNode {
    let mut type_name = String::new();
    let mut size_bytes: u64 = 0;
    let mut references: Vec<(String, String)> = Vec::new();
    let mut in_fields = false;
    let mut fields_header_seen = false;

    for line in output.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("Name:") {
            type_name = trimmed
                .strip_prefix("Name:")
                .unwrap_or("")
                .trim()
                .to_string();
            continue;
        }

        if trimmed.starts_with("Size:") {
            size_bytes = parse_size(trimmed);
            continue;
        }

        if trimmed.starts_with("Fields:") {
            in_fields = true;
            continue;
        }

        if in_fields {
            if !fields_header_seen && trimmed.contains("MT") && trimmed.contains("Name") {
                fields_header_seen = true;
                continue;
            }
            if fields_header_seen {
                if let Some((field_name, ref_addr)) = extract_reference_field(trimmed) {
                    references.push((field_name, ref_addr));
                }
            }
        }
    }

    if type_name.is_empty() {
        return ParsedNode {
            node: None,
            references: vec![],
        };
    }

    let display_name = short_type_name(&type_name);

    let node = ObjectGraphNode {
        id: address.to_string(),
        type_name,
        display_name,
        size_bytes,
        retained_size_bytes: size_bytes, // Updated later if objsize is available.
        instance_count: 1,
        is_root: false,
        root_kind: None,
        depth,
    };

    ParsedNode {
        node: Some(node),
        references,
    }
}

/// Extract a reference field from a `dumpobj` field line.
///
/// Returns `(field_name, reference_address)` if this is a non-null reference field.
fn extract_reference_field(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("---") {
        return None;
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    // Need at least: MT, FieldToken, Offset, Type, VT, Attr, Value, Name
    if tokens.len() < 8 {
        return None;
    }

    let name = (*tokens.last()?).to_string();
    let value_str = *tokens.get(tokens.len() - 2)?;
    let vt_idx = tokens.len() - 4;
    let vt = *tokens.get(vt_idx)?;

    // VT=0 means reference type.
    if vt != "0" {
        return None;
    }

    // Attr must be "instance" (not static).
    let attr = *tokens.get(tokens.len() - 3)?;
    if attr != "instance" {
        return None;
    }

    // Skip null references.
    if value_str.chars().all(|c| c == '0') || value_str == "null" {
        return None;
    }

    Some((name, value_str.to_string()))
}

/// Annotate root nodes in the graph by running `gcroot` on the start address.
async fn annotate_roots(
    tool: &std::path::Path,
    dump_path: &str,
    root_address: &str,
    nodes: &mut HashMap<String, ObjectGraphNode>,
) {
    let cmd = format!("gcroot {root_address}");
    let Ok(output) = dump_cmd::run(tool, dump_path, &cmd).await else {
        return;
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let trimmed = line.trim();
        let root_kind = if trimmed.starts_with("Thread") {
            Some("Stack".to_string())
        } else if trimmed.to_lowercase().contains("static") {
            Some("Static".to_string())
        } else if trimmed.to_lowercase().contains("pinned") {
            Some("Pinned".to_string())
        } else if trimmed.to_lowercase().contains("finalizer") {
            Some("Finalizer".to_string())
        } else if trimmed.to_lowercase().contains("threadlocal") {
            Some("ThreadLocal".to_string())
        } else {
            None
        };

        if let Some(kind) = root_kind {
            // Extract an address from the line if possible.
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if let Some(addr) = parts.get(1) {
                if let Some(node) = nodes.get_mut(*addr) {
                    node.is_root = true;
                    node.root_kind = Some(kind);
                }
            }
        }
    }
}

/// Parse the Size field: `Size: 52(0x34) bytes` → 52.
fn parse_size(line: &str) -> u64 {
    let after_colon = line.strip_prefix("Size:").unwrap_or(line).trim();
    after_colon
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

/// Extract the last segment of a fully-qualified type name.
fn short_type_name(full: &str) -> String {
    // For generic types like "System.Collections.Generic.List`1[[System.String]]",
    // return the part after the last dot before the backtick.
    let base = full.split('`').next().unwrap_or(full);
    base.split('.').next_back().unwrap_or(base).to_string()
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#[expect(
    clippy::expect_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    const DUMPOBJ_OUTPUT: &str = "\
Name:        MyApp.Service
MethodTable: 00007ff8abcd9999
Size:        32(0x20) bytes
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007ff80003  4000200      8        System.String  0 instance 00007ff812345678 _name
00007ff80004  4000201     10  System.Object[]  0 instance 0000000000000000 _items
00007ff80005  4000202     18         System.Int32  1 instance                5 _count
";

    #[test]
    fn test_parse_dumpobj_for_graph_extracts_references() {
        let parsed = parse_dumpobj_for_graph(DUMPOBJ_OUTPUT, "0xabcd", 0);
        let node = parsed.node.unwrap();

        assert_eq!(node.type_name, "MyApp.Service");
        assert_eq!(node.size_bytes, 32);
        assert_eq!(node.id, "0xabcd");
        assert_eq!(node.depth, 0);
        assert_eq!(node.display_name, "Service");

        // Only non-null reference fields.
        assert_eq!(parsed.references.len(), 1);
        let first_ref = parsed.references.first().expect("reference must exist");
        assert_eq!(first_ref.0, "_name");
        assert_eq!(first_ref.1, "00007ff812345678");
    }

    #[test]
    fn test_parse_dumpobj_for_graph_no_name_returns_none() {
        let output = "Some garbage output\n with no Name: line";
        let parsed = parse_dumpobj_for_graph(output, "0x1234", 0);
        assert!(parsed.node.is_none());
    }

    #[test]
    fn test_short_type_name() {
        assert_eq!(short_type_name("System.String"), "String");
        assert_eq!(
            short_type_name("System.Collections.Generic.List`1[[System.String]]"),
            "List"
        );
        assert_eq!(short_type_name("MyApp.Service"), "Service");
        assert_eq!(short_type_name("Service"), "Service");
    }

    #[test]
    fn test_parse_size() {
        assert_eq!(parse_size("Size:        52(0x34) bytes"), 52);
        assert_eq!(parse_size("Size:        1024(0x400) bytes"), 1024);
    }

    #[test]
    fn test_extract_reference_field_non_null() {
        let line =
            "00007ff80003  4000200      8        System.String  0 instance 00007ff812345678 _name";
        let result = extract_reference_field(line);
        assert!(result.is_some());
        let (field, addr) = result.unwrap();
        assert_eq!(field, "_name");
        assert_eq!(addr, "00007ff812345678");
    }

    #[test]
    fn test_extract_reference_field_null_skipped() {
        let line =
            "00007ff80004  4000201     10  System.Object[]  0 instance 0000000000000000 _items";
        let result = extract_reference_field(line);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_reference_field_value_type_skipped() {
        let line =
            "00007ff80005  4000202     18         System.Int32  1 instance                5 _count";
        let result = extract_reference_field(line);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_reference_field_separator_line_skipped() {
        assert!(extract_reference_field("---").is_none());
        assert!(extract_reference_field("   ---   ").is_none());
    }

    #[test]
    fn test_extract_reference_field_empty_line_skipped() {
        assert!(extract_reference_field("").is_none());
        assert!(extract_reference_field("   ").is_none());
    }

    #[test]
    fn test_extract_reference_field_short_line_skipped() {
        assert!(extract_reference_field("foo bar baz").is_none());
    }

    #[test]
    fn test_extract_reference_field_static_attr_skipped() {
        let line =
            "00007ff80003  4000200      8        System.String  0   static 00007ff812345678 _shared";
        let result = extract_reference_field(line);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_reference_field_null_literal_skipped() {
        let line = "00007ff80003  4000200      8        System.String  0 instance null _name";
        let result = extract_reference_field(line);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_dumpobj_for_graph_multiple_references() {
        let output = "\
Name:        MyApp.Container
MethodTable: 00007ff8abcd9999
Size:        64(0x40) bytes
Fields:
              MT    Field   Offset                 Type VT     Attr            Value Name
00007ff80003  4000200      8        System.String  0 instance 00007ff811111111 _first
00007ff80004  4000201     10        System.String  0 instance 00007ff822222222 _second
";
        let parsed = parse_dumpobj_for_graph(output, "0xroot", 2);
        let node = parsed.node.unwrap();

        assert_eq!(node.type_name, "MyApp.Container");
        assert_eq!(node.size_bytes, 64);
        assert_eq!(node.depth, 2);
        assert!(!node.is_root);
        assert!(node.root_kind.is_none());
        assert_eq!(node.instance_count, 1);
        assert_eq!(node.retained_size_bytes, 64);

        assert_eq!(parsed.references.len(), 2);
        assert_eq!(parsed.references[0].0, "_first");
        assert_eq!(parsed.references[0].1, "00007ff811111111");
        assert_eq!(parsed.references[1].0, "_second");
        assert_eq!(parsed.references[1].1, "00007ff822222222");
    }

    #[test]
    fn test_parse_dumpobj_for_graph_no_fields_section() {
        let output = "\
Name:        System.Object
MethodTable: 00007ff8abcd0000
Size:        24(0x18) bytes
";
        let parsed = parse_dumpobj_for_graph(output, "0xabc", 1);
        let node = parsed.node.unwrap();
        assert_eq!(node.type_name, "System.Object");
        assert_eq!(node.display_name, "Object");
        assert!(parsed.references.is_empty());
    }

    #[test]
    fn test_parse_size_edge_cases() {
        assert_eq!(parse_size("Size: 0(0x0) bytes"), 0);
        assert_eq!(parse_size("Size: bytes"), 0);
        assert_eq!(parse_size("not a size line"), 0);
    }

    #[test]
    fn test_short_type_name_no_dots() {
        assert_eq!(short_type_name("Int32"), "Int32");
    }

    #[test]
    fn test_short_type_name_nested_generic() {
        assert_eq!(
            short_type_name("System.Collections.Generic.Dictionary`2[[K],[V]]"),
            "Dictionary"
        );
    }
}
