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
use crate::utils::usize_to_u32;
use crate::vfs::Vfs;

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
    vfs: &Vfs,
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
        .filter_map(|proj| build_project_node(proj, parsers, vfs).ok())
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
fn build_project_node(
    project: &ProjectInfo,
    parsers: &TsParsers,
    vfs: &Vfs,
) -> Result<ProjectNode> {
    let proj_dir = Path::new(&project.path)
        .parent()
        .context("project has no parent")?;

    let source_files = find_source_files(proj_dir);

    let symbols: Vec<FileSymbol> = source_files
        .iter()
        .filter_map(|file| parse_file_symbols(file, parsers, vfs).ok())
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

/// Read file content from VFS if the document is open, otherwise from disk.
fn vfs_or_disk(file_path: &str, vfs: &Vfs) -> Result<String> {
    // Try canonical path first (resolves symlinks).
    if let Some(content) = std::fs::canonicalize(file_path)
        .ok()
        .and_then(|c| try_vfs_uri(&c.to_string_lossy(), vfs))
    {
        return Ok(content);
    }
    // Retry with the original path — editors may use the symlinked form
    // (e.g. /tmp on macOS is a symlink to /private/tmp).
    if let Some(content) = try_vfs_uri(file_path, vfs) {
        return Ok(content);
    }
    tracing::trace!("VFS miss for {file_path}, reading from disk");
    std::fs::read_to_string(file_path).with_context(|| format!("read {file_path}"))
}

fn try_vfs_uri(path_str: &str, vfs: &Vfs) -> Option<String> {
    let uri = format!("file://{path_str}")
        .parse::<lsp_types::Uri>()
        .ok()?;
    vfs.get_content(&uri)
}

/// Parse a single source file and extract symbols.
/// Prefers VFS content (unsaved buffer) over disk for open documents.
fn parse_file_symbols(file_path: &str, parsers: &TsParsers, vfs: &Vfs) -> Result<FileSymbol> {
    let source = vfs_or_disk(file_path, vfs)?;

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

/// Extract the symbol name, handling field/event nested structure.
fn extract_ws_symbol_name(node: Node, source: &[u8]) -> Option<String> {
    if let Some(name_node) = node.child_by_field_name("name") {
        return name_node.utf8_text(source).ok().map(String::from);
    }
    // field_declaration / event_field_declaration: variable_declaration > variable_declarator
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

fn node_to_symbol(node: Node, source: &[u8]) -> Option<SymbolNode> {
    let kind = match node.kind() {
        "namespace_declaration" | "file_scoped_namespace_declaration" => "Namespace",
        "class_declaration" | "record_declaration" => "Class",
        "struct_declaration" => "Struct",
        "interface_declaration" => "Interface",
        "enum_declaration" => "Enum",
        "method_declaration" => "Method",
        "constructor_declaration" => "Constructor",
        "property_declaration" => "Property",
        "field_declaration" => "Field",
        "delegate_declaration" => "Function",
        "event_declaration" | "event_field_declaration" => "Event",
        "enum_member_declaration" => "EnumMember",
        _ => return None,
    };

    let name = extract_ws_symbol_name(node, source)?;

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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    fn make_symbol(name: &str, kind: &str) -> SymbolNode {
        SymbolNode {
            name: name.to_string(),
            kind: kind.to_string(),
            detail: None,
            access: None,
            range: SymbolRange {
                start: SymbolPosition {
                    line: 0,
                    character: 0,
                },
                end: SymbolPosition {
                    line: 0,
                    character: 0,
                },
            },
            children: Vec::new(),
        }
    }

    // ── extract_project_path ──

    #[test]
    fn extract_project_path_csproj() {
        let line = r#"Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyApp", "src\MyApp\MyApp.csproj", "{GUID}""#;
        let result = extract_project_path(line).unwrap();
        assert_eq!(result, "src/MyApp/MyApp.csproj");
    }

    #[test]
    fn extract_project_path_fsproj() {
        let line = r#"Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "MyLib", "lib\MyLib\MyLib.fsproj", "{GUID}""#;
        let result = extract_project_path(line).unwrap();
        assert_eq!(result, "lib/MyLib/MyLib.fsproj");
    }

    #[test]
    fn extract_project_path_non_project_line() {
        assert!(extract_project_path("Global").is_none());
        assert!(extract_project_path("").is_none());
        assert!(extract_project_path("  EndProject").is_none());
    }

    #[test]
    fn extract_project_path_solution_folder() {
        // Solution folders have a path like "SolutionFolder" — no .csproj/.fsproj
        let line = r#"Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{GUID}""#;
        assert!(extract_project_path(line).is_none());
    }

    // ── is_source_file ──

    #[test]
    fn is_source_file_cs() {
        assert!(is_source_file(Path::new("Program.cs")));
    }

    #[test]
    fn is_source_file_fs() {
        assert!(is_source_file(Path::new("Module.fs")));
    }

    #[test]
    fn is_source_file_txt_rejected() {
        assert!(!is_source_file(Path::new("readme.txt")));
    }

    #[test]
    fn is_source_file_rs_rejected() {
        assert!(!is_source_file(Path::new("main.rs")));
    }

    // ── reparent_file_scoped_members ──

    #[test]
    fn reparent_no_namespace_returns_unchanged() {
        let symbols = vec![
            make_symbol("MyClass", "Class"),
            make_symbol("MyStruct", "Struct"),
        ];
        let result = reparent_file_scoped_members(symbols);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "MyClass");
        assert_eq!(result[1].name, "MyStruct");
    }

    #[test]
    fn reparent_namespace_with_existing_children_unchanged() {
        let mut ns = make_symbol("MyApp", "Namespace");
        ns.children.push(make_symbol("Existing", "Class"));

        let symbols = vec![ns, make_symbol("Orphan", "Class")];
        let result = reparent_file_scoped_members(symbols);
        // Namespace already has type children, so no reparenting.
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "MyApp");
        assert_eq!(result[0].children.len(), 1);
        assert_eq!(result[1].name, "Orphan");
    }

    #[test]
    fn reparent_file_scoped_namespace_adopts_orphans() {
        let ns = make_symbol("MyApp.Models", "Namespace");
        let class1 = make_symbol("User", "Class");
        let class2 = make_symbol("Order", "Class");

        let symbols = vec![ns, class1, class2];
        let result = reparent_file_scoped_members(symbols);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "MyApp.Models");
        assert_eq!(result[0].kind, "Namespace");
        assert_eq!(result[0].children.len(), 2);
        assert_eq!(result[0].children[0].name, "User");
        assert_eq!(result[0].children[1].name, "Order");
    }
}
