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
    /// Path to the `.sln` file to scan.
    pub solution: String,
}

/// Full response for `forge/workspaceSymbols`.
#[derive(Debug, Serialize)]
pub struct WorkspaceSymbolsResponse {
    /// Projects discovered in the solution.
    pub projects: Vec<ProjectNode>,
    /// Virtual solution folders from the `.sln`.
    #[serde(rename = "solutionFolders")]
    pub solution_folders: Vec<SolutionFolderNode>,
}

/// A solution folder (virtual grouping in .sln).
#[derive(Debug, Serialize)]
pub struct SolutionFolderNode {
    /// Display name of the folder.
    pub name: String,
    /// Unique GUID from the `.sln`.
    pub guid: String,
    /// GUID of the parent folder, if nested.
    #[serde(rename = "parentGuid")]
    pub parent_guid: Option<String>,
}

/// A project in the solution.
#[derive(Debug, Serialize)]
pub struct ProjectNode {
    /// Project name (stem of `.csproj`/`.fsproj`).
    pub name: String,
    /// Absolute path to the project file.
    pub path: String,
    /// Symbols extracted from the project source files.
    pub symbols: Vec<FileSymbol>,
    /// Name of the parent solution folder, if any.
    #[serde(rename = "parentFolder")]
    pub parent_folder: Option<String>,
}

/// Symbols extracted from a single source file.
#[derive(Debug, Serialize)]
pub struct FileSymbol {
    /// Path to the source file.
    pub file: String,
    /// Top-level symbols in the file.
    pub symbols: Vec<SymbolNode>,
}

/// A symbol in the code hierarchy.
#[derive(Debug, Serialize)]
pub struct SymbolNode {
    /// Symbol identifier.
    pub name: String,
    /// LSP-style kind (e.g. "Class", "Method").
    pub kind: String,
    /// Optional type detail (return type, base class).
    pub detail: Option<String>,
    /// Access modifier (e.g. "public", "private").
    pub access: Option<String>,
    /// Source range of the symbol.
    pub range: SymbolRange,
    /// Nested child symbols.
    pub children: Vec<SymbolNode>,
}

/// Range within a file.
#[derive(Debug, Serialize)]
pub struct SymbolRange {
    /// Start of the range.
    pub start: SymbolPosition,
    /// End of the range.
    pub end: SymbolPosition,
}

/// Position within a file.
#[derive(Debug, Serialize)]
pub struct SymbolPosition {
    /// Zero-based line number.
    pub line: u32,
    /// Zero-based character offset.
    pub character: u32,
}

/// Handle the `forge/workspaceSymbols` request.
pub fn handle(
    params: &WorkspaceSymbolsParams,
    parsers: &TsParsers,
    vfs: &Vfs,
) -> Result<WorkspaceSymbolsResponse> {
    let sln_path = Path::new(&params.solution);
    let sln_data = discover_solution(sln_path)?;

    info!(
        "forge/workspaceSymbols: {} projects, {} folders from {}",
        sln_data.projects.len(),
        sln_data.folders.len(),
        sln_path.display()
    );

    let project_nodes: Vec<ProjectNode> = sln_data
        .projects
        .iter()
        .filter_map(|proj| {
            let mut node = build_project_node(proj, parsers, vfs).ok()?;
            // Resolve parent folder name from nesting.
            if let Some(guid) = &proj.guid {
                if let Some(parent_guid) = sln_data.nesting.get(guid) {
                    let parent_name = sln_data
                        .folders
                        .iter()
                        .find(|f| &f.guid == parent_guid)
                        .map(|f| f.name.clone());
                    node.parent_folder = parent_name;
                }
            }
            Some(node)
        })
        .collect();

    Ok(WorkspaceSymbolsResponse {
        projects: project_nodes,
        solution_folders: sln_data.folders,
    })
}

/// Parsed solution data: projects, folders, and nesting hierarchy.
struct SolutionData {
    /// Project entries discovered in the `.sln`.
    projects: Vec<ProjectInfo>,
    /// Solution folder entries.
    folders: Vec<SolutionFolderNode>,
    /// Maps project/folder GUID to parent folder GUID.
    nesting: std::collections::HashMap<String, String>,
}

/// Well-known type GUID for solution folders in `.sln` files.
const SOLUTION_FOLDER_GUID: &str = "2150E333-8FDC-42A3-9474-1A3956D46DE8";

/// Discover projects, folders, and nesting from a `.sln` file.
fn discover_solution(sln_path: &Path) -> Result<SolutionData> {
    let sln_dir = sln_path.parent().context("sln has no parent")?;
    let content = std::fs::read_to_string(sln_path)
        .with_context(|| format!("read {}", sln_path.display()))?;

    let mut projects = Vec::new();
    let mut folders = Vec::new();
    let mut nesting = std::collections::HashMap::new();

    // Parse projects and solution folders.
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("Project(") {
            continue;
        }

        if let Some((type_guid, name, path, proj_guid)) = parse_project_line(trimmed) {
            if type_guid.to_uppercase() == SOLUTION_FOLDER_GUID {
                folders.push(SolutionFolderNode {
                    name,
                    guid: proj_guid.clone(),
                    parent_guid: None,
                });
            } else if path.ends_with(".csproj") || path.ends_with(".fsproj") {
                let normalized = path.replace('\\', "/");
                let full_path = sln_dir.join(&normalized);
                if full_path.exists() {
                    let proj_name = Path::new(&normalized)
                        .file_stem()
                        .map_or_else(|| normalized.clone(), |s| s.to_string_lossy().to_string());
                    projects.push(ProjectInfo {
                        name: proj_name,
                        path: full_path.to_string_lossy().to_string(),
                        guid: Some(proj_guid),
                    });
                }
            }
        }
    }

    // Parse NestedProjects section for folder hierarchy.
    let mut in_nested = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.contains("GlobalSection(NestedProjects)") {
            in_nested = true;
            continue;
        }
        if in_nested && trimmed == "EndGlobalSection" {
            break;
        }
        if in_nested {
            // Format: {CHILD-GUID} = {PARENT-GUID}
            if let Some((child, parent)) = parse_nested_line(trimmed) {
                let _ = nesting.insert(child, parent);
            }
        }
    }

    // Set parent_guid on folders.
    for folder in &mut folders {
        folder.parent_guid = nesting.get(&folder.guid).cloned();
    }

    Ok(SolutionData {
        projects,
        folders,
        nesting,
    })
}

/// Parse a `Project(...)` line into (`type_guid`, `name`, `path`, `proj_guid`).
fn parse_project_line(line: &str) -> Option<(String, String, String, String)> {
    // Project("{TYPE-GUID}") = "Name", "Path", "{PROJ-GUID}"
    let after_paren = line.strip_prefix("Project(\"")?;
    let type_end = after_paren.find('"')?;
    let type_guid = after_paren[..type_end].to_string();
    let rest = &after_paren[type_end..];

    let parts: Vec<&str> = rest.split(',').collect();
    if parts.len() < 3 {
        return None;
    }

    let name = parts
        .first()?
        .split('=')
        .nth(1)?
        .trim()
        .trim_matches('"')
        .to_string();
    let path = parts.get(1)?.trim().trim_matches('"').to_string();
    let guid = parts
        .get(2)?
        .trim()
        .trim_matches('"')
        .trim_matches('{')
        .trim_matches('}')
        .to_string();

    Some((type_guid, name, path, format!("{{{guid}}}")))
}

/// Parse a `NestedProjects` line into (`child_guid`, `parent_guid`).
fn parse_nested_line(line: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = line.split('=').collect();
    if parts.len() != 2 {
        return None;
    }
    let child = parts.first()?.trim().to_string();
    let parent = parts.get(1)?.trim().to_string();
    if child.starts_with('{') && parent.starts_with('{') {
        Some((child, parent))
    } else {
        None
    }
}

/// Parse a .sln `Project(...)` line to extract the relative path.
#[cfg(test)]
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

/// Intermediate representation of a project discovered in a `.sln`.
struct ProjectInfo {
    /// Project name.
    name: String,
    /// Absolute path to the project file.
    path: String,
    /// GUID from the solution file.
    guid: Option<String>,
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
        parent_folder: None,
    })
}

/// Recursively find `.cs` and `.fs` files under a directory.
fn find_source_files(dir: &Path) -> Vec<String> {
    let mut files = Vec::new();
    collect_source_files(dir, &mut files);
    files
}

/// Recursively collect `.cs` and `.fs` files, skipping build output.
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

/// Check whether the path has a `.cs` or `.fs` extension.
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

/// Attempt to read file content from the VFS using a `file://` URI.
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

/// Walk a tree-sitter node and collect recognized symbols.
fn collect_symbols(node: Node<'_>, source: &[u8]) -> Vec<SymbolNode> {
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
fn extract_ws_symbol_name(node: Node<'_>, source: &[u8]) -> Option<String> {
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

/// Map a tree-sitter node to a `SymbolNode` if it is a recognized declaration.
fn node_to_symbol(node: Node<'_>, source: &[u8]) -> Option<SymbolNode> {
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
fn extract_access(node: Node<'_>, source: &[u8]) -> Option<String> {
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
fn extract_type_detail(node: Node<'_>, source: &[u8]) -> Option<String> {
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
    clippy::indexing_slicing,
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

    // ── collect_source_files / find_source_files ──

    #[test]
    fn find_source_files_returns_cs_and_fs_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        std::fs::write(dir.join("Foo.cs"), "").unwrap();
        std::fs::write(dir.join("Bar.fs"), "").unwrap();
        std::fs::write(dir.join("readme.txt"), "").unwrap();

        let mut files = Vec::new();
        collect_source_files(dir, &mut files);

        assert_eq!(files.len(), 2, "must find exactly 2 source files");
        assert!(files.iter().any(|f| f.ends_with("Foo.cs")));
        assert!(files.iter().any(|f| f.ends_with("Bar.fs")));
    }

    #[test]
    fn collect_source_files_skips_bin_obj_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        // Create a src file at root level.
        std::fs::write(dir.join("Main.cs"), "").unwrap();

        // Create bin/obj directories with files that must NOT be collected.
        std::fs::create_dir(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin").join("App.dll"), "").unwrap();
        // Trick: put a .cs file in bin to verify it's skipped.
        std::fs::write(dir.join("bin").join("Gen.cs"), "").unwrap();

        std::fs::create_dir(dir.join("obj")).unwrap();
        std::fs::write(dir.join("obj").join("Build.cs"), "").unwrap();

        let mut files = Vec::new();
        collect_source_files(dir, &mut files);

        assert_eq!(files.len(), 1, "must skip bin/obj, got: {files:?}");
        assert!(files[0].ends_with("Main.cs"));
    }

    #[test]
    fn collect_source_files_skips_nonexistent_directory() {
        let path = Path::new("/nonexistent/path/that/does/not/exist");
        let mut files = Vec::new();
        // Must not panic — simply returns nothing.
        collect_source_files(path, &mut files);
        assert!(files.is_empty());
    }

    #[test]
    fn collect_source_files_recurses_into_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        let sub = dir.join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join("Nested.cs"), "").unwrap();
        std::fs::write(dir.join("Root.cs"), "").unwrap();

        let mut files = Vec::new();
        collect_source_files(dir, &mut files);

        assert_eq!(files.len(), 2, "must recurse into subdirs");
        assert!(files.iter().any(|f| f.ends_with("Nested.cs")));
        assert!(files.iter().any(|f| f.ends_with("Root.cs")));
    }

    // ── parse_project_line ──

    #[test]
    fn parse_project_line_returns_parts() {
        let line = r#"Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyApp", "src/MyApp.csproj", "{11111111-1111-1111-1111-111111111111}""#;
        let result = parse_project_line(line);
        assert!(result.is_some());
        let (type_guid, name, path, proj_guid) = result.unwrap();
        assert!(type_guid.contains("FAE04EC0"));
        assert_eq!(name, "MyApp");
        assert_eq!(path, "src/MyApp.csproj");
        assert!(proj_guid.contains("11111111"));
    }

    #[test]
    fn parse_project_line_returns_none_for_invalid() {
        assert!(parse_project_line("not a project line").is_none());
        assert!(parse_project_line("Project(\"only-one-part\")").is_none());
    }

    // ── parse_nested_line ──

    #[test]
    fn parse_nested_line_valid() {
        let line = "{CHILD-GUID} = {PARENT-GUID}";
        let result = parse_nested_line(line);
        assert!(result.is_some());
        let (child, parent) = result.unwrap();
        assert_eq!(child, "{CHILD-GUID}");
        assert_eq!(parent, "{PARENT-GUID}");
    }

    #[test]
    fn parse_nested_line_invalid_returns_none() {
        assert!(parse_nested_line("no equals sign here").is_none());
        assert!(parse_nested_line("no-brace = no-brace").is_none());
    }
}
