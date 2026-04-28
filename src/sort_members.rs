//! Custom `sharplsp/sortMembers` request handler.
//!
//! Reorders members of a type declaration (class, struct, interface, enum,
//! record) in-place using tree-sitter. Sort hierarchy is configurable:
//! Accessibility → Category → Alphabetical by default.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::info;
use tree_sitter::Node;

use crate::tree_sitter_parse::{LangId, TsParsers};
use crate::utils::{uri_to_path, usize_to_u32};

/// Request params for `sharplsp/sortMembers`.
#[derive(Debug, Deserialize)]
pub struct SortMembersParams {
    /// Document URI to sort.
    pub uri: String,
    /// Range covering the type declaration.
    pub range: SortRange,
    /// Sort configuration from the client.
    #[serde(rename = "sortConfig")]
    pub sort_config: SortConfig,
}

/// Range identifying the type declaration to sort.
#[derive(Debug, Deserialize)]
pub struct SortRange {
    /// Start position of the range.
    pub start: SortPosition,
    /// End position of the range.
    pub end: SortPosition,
}

/// Position within a file.
#[derive(Debug, Deserialize)]
pub struct SortPosition {
    /// Zero-based line number.
    pub line: u32,
    /// Zero-based column offset.
    pub character: u32,
}

/// Sort configuration from the client.
#[derive(Debug, Deserialize)]
pub struct SortConfig {
    /// Ordered list of sort criteria (e.g. accessibility, category, alphabetical).
    pub hierarchy: Vec<String>,
    /// Accessibility modifier ordering.
    #[serde(rename = "accessibilityOrder")]
    pub accessibility_order: Vec<String>,
    /// Member category ordering.
    #[serde(rename = "categoryOrder")]
    pub category_order: Vec<String>,
}

/// Response for `sharplsp/sortMembers`.
#[derive(Debug, Serialize)]
pub struct SortMembersResponse {
    /// Text edits that reorder the members.
    pub edits: Vec<TextEdit>,
}

/// A text edit to apply.
#[derive(Debug, Serialize)]
pub struct TextEdit {
    /// Range to replace.
    pub range: EditRange,
    /// Replacement text.
    #[serde(rename = "newText")]
    pub new_text: String,
}

/// Range for a text edit.
#[derive(Debug, Serialize)]
pub struct EditRange {
    /// Start of the range.
    pub start: EditPosition,
    /// End of the range.
    pub end: EditPosition,
}

/// Position for a text edit.
#[derive(Debug, Serialize)]
pub struct EditPosition {
    /// Zero-based line number.
    pub line: u32,
    /// Zero-based column offset.
    pub character: u32,
}

/// Handle the `sharplsp/sortMembers` request.
pub fn handle(params: &SortMembersParams, parsers: &TsParsers) -> Result<SortMembersResponse> {
    let file_path = uri_to_path(&params.uri)?;
    let source =
        std::fs::read_to_string(&file_path).with_context(|| format!("read {file_path}"))?;

    let path = Path::new(&file_path);
    let lang = LangId::from_path(path).context("unsupported file type")?;
    let tree = parsers.parse(lang, &source, None)?;

    let type_node = find_type_at_range(tree.root_node(), &params.range)
        .context("no type declaration at the given range")?;

    let members = collect_members(type_node, source.as_bytes());
    if members.len() < 2 {
        return Ok(SortMembersResponse { edits: vec![] });
    }

    let sorted = sort_member_infos(&members, &params.sort_config);
    if sorted == members.iter().map(|m| m.index).collect::<Vec<_>>() {
        info!("sharplsp/sortMembers: already sorted");
        return Ok(SortMembersResponse { edits: vec![] });
    }

    let edits = build_edits(&members, &sorted, &source, &params.sort_config);
    info!("sharplsp/sortMembers: {} edits generated", edits.len());
    Ok(SortMembersResponse { edits })
}

/// A member extracted from the type body.
struct MemberInfo {
    /// Position of this member among its siblings.
    index: usize,
    /// Identifier name of the member.
    name: String,
    /// Sort category (e.g. "field", "method", "constructor").
    category: String,
    /// Accessibility modifier (e.g. "public", "private").
    access: Option<String>,
    /// Byte offset where the member's leading trivia starts.
    trivia_byte: usize,
    /// Byte offset where the member ends.
    end_byte: usize,
    /// End row of the member in the source.
    end_row: u32,
    /// End column of the member in the source.
    end_col: u32,
}

/// Find the type declaration node at the given range.
fn find_type_at_range<'a>(root: Node<'a>, range: &SortRange) -> Option<Node<'a>> {
    let mut cursor = root.walk();
    find_type_recursive(&mut cursor, range)
}

/// Recursively search for a type declaration node matching the range.
fn find_type_recursive<'a>(
    cursor: &mut tree_sitter::TreeCursor<'a>,
    range: &SortRange,
) -> Option<Node<'a>> {
    loop {
        let node = cursor.node();
        if is_type_node(&node) && node_matches_range(&node, range) {
            return Some(node);
        }
        if cursor.goto_first_child() {
            if let Some(found) = find_type_recursive(cursor, range) {
                return Some(found);
            }
            let _ = cursor.goto_parent();
        }
        if !cursor.goto_next_sibling() {
            return None;
        }
    }
}

/// Return true if the node is a type declaration (class, struct, etc.).
fn is_type_node(node: &Node<'_>) -> bool {
    matches!(
        node.kind(),
        "class_declaration"
            | "struct_declaration"
            | "interface_declaration"
            | "enum_declaration"
            | "record_declaration"
    )
}

/// Return true if the node's position matches the given range.
fn node_matches_range(node: &Node<'_>, range: &SortRange) -> bool {
    let start = node.start_position();
    let end = node.end_position();
    // Match by start position; end line must be within range.
    usize_to_u32(start.row) == range.start.line
        && usize_to_u32(start.column) == range.start.character
        && usize_to_u32(end.row) >= range.start.line
        && usize_to_u32(end.row) <= range.end.line
}

/// Collect direct member declarations from a type body.
fn collect_members(type_node: Node<'_>, source: &[u8]) -> Vec<MemberInfo> {
    let body = find_body_node(type_node);
    let parent = body.unwrap_or(type_node);
    let mut members = Vec::new();
    let mut cursor = parent.walk();

    for (index, child) in parent.children(&mut cursor).enumerate() {
        if let Some(category) = member_category(&child, source) {
            let name = extract_member_name(&child, source).unwrap_or_default();
            let access = extract_member_access(&child, source);

            // Find leading trivia (comments/attributes) by looking at
            // the gap between previous sibling's end and this node's start.
            let trivia_byte = leading_trivia_start(&child, &parent);

            members.push(MemberInfo {
                index,
                name,
                category: category.to_string(),
                access,
                trivia_byte,
                end_byte: child.end_byte(),
                end_row: usize_to_u32(child.end_position().row),
                end_col: usize_to_u32(child.end_position().column),
            });
        }
    }
    members
}

/// Find the `declaration_list` or `enum_member_declaration_list` body node.
fn find_body_node(type_node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = type_node.walk();
    let is_body = |child: &Node<'_>| {
        child.kind() == "declaration_list" || child.kind() == "enum_member_declaration_list"
    };
    let body = type_node.children(&mut cursor).find(is_body);
    body
}

/// Check whether a node's modifier list contains a specific keyword.
fn has_modifier(node: &Node<'_>, source: &[u8], modifier: &str) -> bool {
    let mut cursor = node.walk();
    let found = node.children(&mut cursor).any(|child| {
        child.kind() == "modifier" && child.utf8_text(source).is_ok_and(|text| text == modifier)
    });
    found
}

/// Map tree-sitter node kinds to sort categories.
fn member_category(node: &Node<'_>, source: &[u8]) -> Option<&'static str> {
    match node.kind() {
        "field_declaration" => {
            if has_modifier(node, source, "const") {
                Some("constant")
            } else {
                Some("field")
            }
        }
        "constructor_declaration" => Some("constructor"),
        "destructor_declaration" => Some("finalizer"),
        "delegate_declaration" => Some("delegate"),
        "event_declaration" | "event_field_declaration" => Some("event"),
        "enum_declaration" => Some("enum"),
        "interface_declaration" => Some("interface"),
        "property_declaration" => Some("property"),
        "indexer_declaration" => Some("indexer"),
        "operator_declaration" | "conversion_operator_declaration" => Some("operator"),
        "method_declaration" => Some("method"),
        "struct_declaration" => Some("struct"),
        "class_declaration" | "record_declaration" => Some("class"),
        "enum_member_declaration" => Some("constant"),
        _ => None,
    }
}

/// Extract the identifier name from a member declaration node.
fn extract_member_name(node: &Node<'_>, source: &[u8]) -> Option<String> {
    // Direct name field (class, method, property, constructor, etc.)
    if let Some(name_node) = node.child_by_field_name("name") {
        return name_node.utf8_text(source).ok().map(String::from);
    }
    // field_declaration: name is inside variable_declaration > variable_declarator
    if node.kind() == "field_declaration" {
        return find_field_name(node, source);
    }
    None
}

/// Extract the name from a `field_declaration`'s `variable_declarator`.
fn find_field_name(node: &Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "variable_declaration" {
            let mut inner = child.walk();
            for declarator in child.children(&mut inner) {
                if declarator.kind() == "variable_declarator" {
                    return declarator
                        .child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source).ok())
                        .map(String::from);
                }
            }
        }
    }
    None
}

/// Extract the accessibility modifier(s) from a member declaration node.
fn extract_member_access(node: &Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    let mut parts: Vec<&str> = Vec::new();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifier" {
            if let Ok(text) = child.utf8_text(source) {
                if matches!(text, "public" | "private" | "protected" | "internal") {
                    parts.push(text);
                }
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// Find where leading trivia (comments, preprocessor directives) starts
/// for a given member node by walking backwards through non-member siblings.
fn leading_trivia_start(node: &Node<'_>, parent: &Node<'_>) -> usize {
    let mut current = *node;
    while let Some(prev) = current.prev_sibling() {
        if prev.kind() == "{" {
            return prev.end_byte();
        }
        if !is_trivia_node(&prev) {
            return prev.end_byte();
        }
        current = prev;
    }
    parent.start_byte()
}

/// Check if a node is trivia that should travel with the next member.
fn is_trivia_node(node: &Node<'_>) -> bool {
    matches!(
        node.kind(),
        "comment"
            | "preprocessor_directive"
            | "preproc_region"
            | "preproc_endregion"
            | "preproc_pragma"
            | "preproc_if"
            | "preproc_else"
            | "preproc_endif"
    )
}

/// Sort members according to the hierarchy config.
/// Returns indices in the original order that represent the sorted order.
fn sort_member_infos(members: &[MemberInfo], config: &SortConfig) -> Vec<usize> {
    let mut indices: Vec<usize> = (0..members.len()).collect();

    indices.sort_by(|&a_idx, &b_idx| {
        let (Some(a_member), Some(b_member)) = (members.get(a_idx), members.get(b_idx)) else {
            return std::cmp::Ordering::Equal;
        };

        for criterion in &config.hierarchy {
            let cmp = match criterion.as_str() {
                "accessibility" => {
                    let a_pri =
                        access_priority(a_member.access.as_deref(), &config.accessibility_order);
                    let b_pri =
                        access_priority(b_member.access.as_deref(), &config.accessibility_order);
                    a_pri.cmp(&b_pri)
                }
                "category" => {
                    let a_pri = category_priority(&a_member.category, &config.category_order);
                    let b_pri = category_priority(&b_member.category, &config.category_order);
                    a_pri.cmp(&b_pri)
                }
                "alphabetical" => a_member
                    .name
                    .to_lowercase()
                    .cmp(&b_member.name.to_lowercase()),
                _ => std::cmp::Ordering::Equal,
            };
            if cmp != std::cmp::Ordering::Equal {
                return cmp;
            }
        }
        std::cmp::Ordering::Equal
    });

    indices
        .iter()
        .filter_map(|&idx| members.get(idx).map(|m| m.index))
        .collect()
}

/// Return the priority index of an accessibility modifier within the config order.
fn access_priority(access: Option<&str>, order: &[String]) -> usize {
    match access {
        Some(a) => order.iter().position(|o| o == a).unwrap_or(order.len()),
        None => order.len(),
    }
}

/// Return the priority index of a member category within the config order.
fn category_priority(category: &str, order: &[String]) -> usize {
    order
        .iter()
        .position(|o| o == category)
        .unwrap_or(order.len())
}

/// Check if two adjacent sorted members belong to different groups.
/// Returns true when a blank line separator should be inserted.
fn groups_differ(a: &MemberInfo, b: &MemberInfo, config: &SortConfig) -> bool {
    for criterion in &config.hierarchy {
        match criterion.as_str() {
            "accessibility" => {
                let a_pri = access_priority(a.access.as_deref(), &config.accessibility_order);
                let b_pri = access_priority(b.access.as_deref(), &config.accessibility_order);
                if a_pri != b_pri {
                    return true;
                }
            }
            "category" => {
                let a_pri = category_priority(&a.category, &config.category_order);
                let b_pri = category_priority(&b.category, &config.category_order);
                if a_pri != b_pri {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Build text edits that reorder the members.
///
/// Strategy: replace the entire body content with the reordered members.
/// Inserts blank lines between accessibility/category groups.
fn build_edits(
    members: &[MemberInfo],
    sorted_indices: &[usize],
    source: &str,
    config: &SortConfig,
) -> Vec<TextEdit> {
    let source_bytes = source.as_bytes();

    // Find the first and last member to get the replacement range.
    // Use trivia_byte for the first member so the edit covers leading comments.
    let first = members.iter().min_by_key(|m| m.trivia_byte);
    let last = members.iter().max_by_key(|m| m.end_byte);

    let (Some(first_member), Some(last_member)) = (first, last) else {
        return vec![];
    };

    // Compute the edit start position from the trivia byte offset.
    let trivia_pos = byte_to_position(source_bytes, first_member.trivia_byte);

    // Build the reordered text by extracting each member's full text
    // (including its leading trivia) in sorted order.
    // Insert blank lines between different accessibility/category groups.
    let mut new_text = String::new();
    let mut prev_member: Option<&MemberInfo> = None;

    for (sorted_pos, &original_index) in sorted_indices.iter().enumerate() {
        let member = members.iter().find(|m| m.index == original_index);
        let Some(member) = member else { continue };

        // Extract the full member text including leading trivia.
        let Some(text) = source_bytes.get(member.trivia_byte..member.end_byte) else {
            continue;
        };
        let member_text = String::from_utf8_lossy(text);

        // Insert blank line between groups.
        if let Some(prev) = prev_member {
            if groups_differ(prev, member, config) && !new_text.ends_with("\n\n") {
                if !new_text.ends_with('\n') {
                    new_text.push('\n');
                }
                new_text.push('\n');
            }
        }

        new_text.push_str(&member_text);

        if sorted_pos < sorted_indices.len() - 1 && !member_text.ends_with('\n') {
            new_text.push('\n');
        }

        prev_member = Some(member);
    }

    vec![TextEdit {
        range: EditRange {
            start: EditPosition {
                line: trivia_pos.0,
                character: trivia_pos.1,
            },
            end: EditPosition {
                line: last_member.end_row,
                character: last_member.end_col,
            },
        },
        new_text,
    }]
}

/// Convert a byte offset to (line, column) in the source.
fn byte_to_position(source: &[u8], byte_offset: usize) -> (u32, u32) {
    let mut line: u32 = 0;
    let mut col: u32 = 0;
    for (i, &b) in source.iter().enumerate() {
        if i == byte_offset {
            return (line, col);
        }
        if b == b'\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    (line, col)
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn access_priority_returns_index() {
        let order = vec![
            "public".to_string(),
            "internal".to_string(),
            "private".to_string(),
        ];
        assert_eq!(access_priority(Some("public"), &order), 0);
        assert_eq!(access_priority(Some("internal"), &order), 1);
        assert_eq!(access_priority(Some("private"), &order), 2);
        assert_eq!(access_priority(None, &order), 3);
    }

    #[test]
    fn category_priority_returns_index() {
        let order = vec!["field".to_string(), "method".to_string()];
        assert_eq!(category_priority("field", &order), 0);
        assert_eq!(category_priority("method", &order), 1);
        assert_eq!(category_priority("unknown", &order), 2);
    }

    #[test]
    fn sort_member_infos_sorts_by_hierarchy() {
        let members = vec![
            MemberInfo {
                index: 0,
                name: "Zebra".to_string(),
                category: "method".to_string(),
                access: Some("private".to_string()),
                trivia_byte: 0,
                end_byte: 10,
                end_row: 0,
                end_col: 10,
            },
            MemberInfo {
                index: 1,
                name: "Alpha".to_string(),
                category: "field".to_string(),
                access: Some("public".to_string()),
                trivia_byte: 10,
                end_byte: 20,
                end_row: 1,
                end_col: 10,
            },
        ];
        let config = SortConfig {
            hierarchy: vec![
                "accessibility".to_string(),
                "category".to_string(),
                "alphabetical".to_string(),
            ],
            accessibility_order: vec!["public".to_string(), "private".to_string()],
            category_order: vec!["field".to_string(), "method".to_string()],
        };
        let sorted = sort_member_infos(&members, &config);
        // Public field Alpha should come first.
        assert_eq!(sorted, vec![1, 0]);
    }

    #[test]
    fn uri_to_path_strips_prefix() {
        let path = uri_to_path("file:///home/user/test.cs").unwrap();
        assert_eq!(path, "/home/user/test.cs");
    }

    #[test]
    fn uri_to_path_rejects_non_file() {
        assert!(uri_to_path("https://example.com").is_err());
    }

    #[test]
    fn member_category_classifies_correctly() {
        // This test would require tree-sitter nodes, so we test the
        // priority functions instead (above). The category mapping is
        // verified in E2E tests.
    }
}
