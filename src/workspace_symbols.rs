//! Custom `forge/workspaceSymbols` request handler.
//!
//! Walks all `.cs` / `.fs` files discovered via `.csproj` / `.fsproj` files
//! referenced by a `.sln`, parses each with tree-sitter, and returns the
//! full code hierarchy grouped by project and namespace.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::info;
use tree_sitter::Node;

use crate::tree_sitter_parse::{LangId, TsParsers};

/// Request params for `forge/workspaceSymbols`.
#[derive(Debug, Deserialize)]
pub struct WorkspaceSymbolsParams {
    pub solution: String,
}

/// Full response for `forge/workspaceSymbols`.
#[derive(Debug, Serialize)]
pub struct WorkspaceSymbolsResponse {
    pub projects: Vec<ProjectNode>,
}

/// A project in the solution.
#[derive(Debug, Serialize)]
pub struct ProjectNode {
    pub name: String,
    pub path: String,
    pub symbols: Vec<FileSymbol>,
}

/// Symbols extracted from a single source file.
#[derive(Debug, Serialize)]
pub struct FileSymbol {
    pub file: String,
    pub symbols: Vec<SymbolNode>,
}

/// A symbol in the code hierarchy.
#[derive(Debug, Serialize)]
pub struct SymbolNode {
    pub name: String,
    pub kind: String,
    pub detail: Option<String>,
    pub access: Option<String>,
    pub range: SymbolRange,
    pub children: Vec<SymbolNode>,
}

/// Range within a file.
#[derive(Debug, Serialize)]
pub struct SymbolRange {
    pub start: SymbolPosition,
    pub end: SymbolPosition,
}

/// Position within a file.
#[derive(Debug, Serialize)]
pub struct SymbolPosition {
    pub line: u32,
    pub character: u32,
}

/// Handle the `forge/workspaceSymbols` request.
pub fn handle(
    params: &WorkspaceSymbolsParams,
    parsers: &TsParsers,
) -> Result<WorkspaceSymbolsResponse> {
    let sln_path = Path::new(&params.solution);
    let projects = discover_projects(sln_path)?;

    info!(
        "forge/workspaceSymbols: {} projects from {}",
        projects.len(),
        sln_path.display()
    );

    let project_nodes: Vec<ProjectNode> = projects
        .iter()
        .filter_map(|proj| build_project_node(proj, parsers).ok())
        .collect();

    Ok(WorkspaceSymbolsResponse {
        projects: project_nodes,
    })
}

/// Discover `.csproj` / `.fsproj` paths from a `.sln` file.
fn discover_projects(sln_path: &Path) -> Result<Vec<ProjectInfo>> {
    let sln_dir = sln_path.parent().context("sln has no parent")?;
    let content = std::fs::read_to_string(sln_path)
        .with_context(|| format!("read {}", sln_path.display()))?;

    let mut projects = Vec::new();
    for line in content.lines() {
        if let Some(proj_path) = extract_project_path(line) {
            let full_path = sln_dir.join(&proj_path);
            if full_path.exists() {
                let name = Path::new(&proj_path)
                    .file_stem()
                    .map_or_else(|| proj_path.clone(), |s| s.to_string_lossy().to_string());
                projects.push(ProjectInfo {
                    name,
                    path: full_path.to_string_lossy().to_string(),
                });
            }
        }
    }

    Ok(projects)
}

/// Parse a .sln `Project(...)` line to extract the relative path.
fn extract_project_path(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("Project(") {
        return None;
    }

    // Format: Project("{GUID}") = "Name", "Path.csproj", "{GUID}"
    let parts: Vec<&str> = trimmed.split(',').collect();
    let path_part = parts.get(1)?.trim().trim_matches('"');

    if path_part.ends_with(".csproj") || path_part.ends_with(".fsproj") {
        // Normalize backslashes to forward slashes.
        Some(path_part.replace('\\', "/"))
    } else {
        None
    }
}

struct ProjectInfo {
    name: String,
    path: String,
}

/// Build a `ProjectNode` by finding and parsing all source files.
fn build_project_node(project: &ProjectInfo, parsers: &TsParsers) -> Result<ProjectNode> {
    let proj_dir = Path::new(&project.path)
        .parent()
        .context("project has no parent")?;

    let source_files = find_source_files(proj_dir);

    let symbols: Vec<FileSymbol> = source_files
        .iter()
        .filter_map(|file| parse_file_symbols(file, parsers).ok())
        .filter(|fs| !fs.symbols.is_empty())
        .collect();

    Ok(ProjectNode {
        name: project.name.clone(),
        path: project.path.clone(),
        symbols,
    })
}

/// Recursively find `.cs` and `.fs` files under a directory.
fn find_source_files(dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_source_files(dir, &mut files);
    files
}

fn collect_source_files(dir: &Path, files: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string());
            // Skip build output and hidden directories.
            if matches!(
                name.as_deref(),
                Some("bin" | "obj" | ".git" | "node_modules")
            ) {
                continue;
            }
            collect_source_files(&path, files);
        } else if is_source_file(&path) {
            files.push(path.to_string_lossy().to_string());
        }
    }
}

fn is_source_file(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()), Some("cs" | "fs"))
}

/// Parse a single source file and extract symbols.
fn parse_file_symbols(file_path: &str, parsers: &TsParsers) -> Result<FileSymbol> {
    let source = std::fs::read_to_string(file_path).with_context(|| format!("read {file_path}"))?;

    let path = Path::new(file_path);
    let lang = LangId::from_path(path).context("unsupported file type")?;
    let tree = parsers.parse(lang, &source, None)?;

    let symbols = collect_symbols(tree.root_node(), source.as_bytes());
    let symbols = reparent_file_scoped_members(symbols);

    Ok(FileSymbol {
        file: file_path.to_string(),
        symbols,
    })
}

/// Fix file-scoped namespace hierarchy.
///
/// `tree-sitter-c-sharp` 0.23 emits `file_scoped_namespace_declaration`
/// without nesting subsequent type declarations as children — they appear
/// as siblings at the root level. Detect this and move them inside.
fn reparent_file_scoped_members(symbols: Vec<SymbolNode>) -> Vec<SymbolNode> {
    let ns_count = symbols.iter().filter(|s| s.kind == "Namespace").count();
    let has_root_types = symbols.iter().any(|s| s.kind != "Namespace");

    if ns_count != 1 || !has_root_types {
        return symbols;
    }

    // Only reparent if the namespace has no type children already.
    let ns_has_types = symbols
        .iter()
        .find(|s| s.kind == "Namespace")
        .is_some_and(|ns| ns.children.iter().any(|c| c.kind != "Namespace"));

    if ns_has_types {
        return symbols;
    }

    let (mut namespaces, types): (Vec<_>, Vec<_>) =
        symbols.into_iter().partition(|s| s.kind == "Namespace");

    if let Some(ns) = namespaces.first_mut() {
        ns.children.extend(types);
    }

    namespaces
}

fn collect_symbols(node: Node, source: &[u8]) -> Vec<SymbolNode> {
    let mut symbols = Vec::new();
    let mut cursor = node.walk();

    for child in node.children(&mut cursor) {
        if let Some(sym) = node_to_symbol(child, source) {
            symbols.push(sym);
        } else {
            symbols.extend(collect_symbols(child, source));
        }
    }

    symbols
}

fn node_to_symbol(node: Node, source: &[u8]) -> Option<SymbolNode> {
    let (kind, name_field) = match node.kind() {
        "namespace_declaration" | "file_scoped_namespace_declaration" => ("Namespace", "name"),
        "class_declaration" | "record_declaration" => ("Class", "name"),
        "struct_declaration" => ("Struct", "name"),
        "interface_declaration" => ("Interface", "name"),
        "enum_declaration" => ("Enum", "name"),
        "method_declaration" => ("Method", "name"),
        "constructor_declaration" => ("Constructor", "name"),
        "property_declaration" => ("Property", "name"),
        "field_declaration" => ("Field", "name"),
        "delegate_declaration" => ("Function", "name"),
        "event_declaration" => ("Event", "name"),
        "enum_member_declaration" => ("EnumMember", "name"),
        _ => return None,
    };

    let name_node = node.child_by_field_name(name_field)?;
    let name = name_node.utf8_text(source).ok()?.to_string();

    let detail = extract_type_detail(node, source);
    let access = extract_access(node, source);

    let range = SymbolRange {
        start: SymbolPosition {
            line: usize_to_u32(node.start_position().row),
            character: usize_to_u32(node.start_position().column),
        },
        end: SymbolPosition {
            line: usize_to_u32(node.end_position().row),
            character: usize_to_u32(node.end_position().column),
        },
    };

    let children = collect_symbols(node, source);

    Some(SymbolNode {
        name,
        kind: kind.to_string(),
        detail,
        access,
        range,
        children,
    })
}

/// Extract access modifier (public, private, protected, internal).
fn extract_access(node: Node, source: &[u8]) -> Option<String> {
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

/// Extract type info (base class, return type) for display.
fn extract_type_detail(node: Node, source: &[u8]) -> Option<String> {
    match node.kind() {
        "class_declaration" | "struct_declaration" | "record_declaration" => node
            .child_by_field_name("bases")
            .and_then(|b| b.utf8_text(source).ok())
            .map(|s| s.trim_start_matches(": ").to_string()),
        "property_declaration" | "field_declaration" => node
            .child_by_field_name("type")
            .and_then(|t| t.utf8_text(source).ok())
            .map(String::from),
        "method_declaration" => node
            .child_by_field_name("type")
            .and_then(|t| t.utf8_text(source).ok())
            .map(|ret| format!("() : {ret}")),
        _ => None,
    }
}

fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
