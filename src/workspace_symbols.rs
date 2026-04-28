//! Custom `sharplsp/workspaceSymbols` request handler.
//!
//! Walks all `.cs` / `.fs` files discovered via `.csproj` / `.fsproj` files
//! referenced by a `.sln` or `.slnx`, parses each with tree-sitter, and returns the
//! full code hierarchy grouped by project and namespace.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::info;
use tree_sitter::Node;

use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::{LangId, TsParsers};
use crate::utils::usize_to_u32;
use crate::vfs::Vfs;

/// Request params for `sharplsp/workspaceSymbols`.
#[derive(Debug, Deserialize)]
pub struct WorkspaceSymbolsParams {
    /// Path to the `.sln` or `.slnx` file to scan.
    pub solution: String,
}

/// Full response for `sharplsp/workspaceSymbols`.
#[derive(Debug, Serialize)]
pub struct WorkspaceSymbolsResponse {
    /// Projects discovered in the solution.
    pub projects: Vec<ProjectNode>,
    /// Virtual solution folders from the solution file.
    #[serde(rename = "solutionFolders")]
    pub solution_folders: Vec<SolutionFolderNode>,
}

/// A solution folder (virtual grouping in a solution file).
#[derive(Debug, Serialize)]
pub struct SolutionFolderNode {
    /// Display name of the folder.
    pub name: String,
    /// Stable solution-folder identity from the sidecar model.
    pub guid: String,
    /// Stable identity of the parent folder, if nested.
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

/// Sidecar DTO returned by `solution/read`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolutionFileModel {
    /// Absolute path to the solution file.
    path: String,
    /// Solution format: `sln` or `slnx`.
    format: String,
    /// Projects in declaration order.
    projects: Vec<SolutionProjectEntry>,
    /// Solution folders in declaration order.
    folders: Vec<SolutionFolderEntry>,
    /// Solution item files that are not project nodes.
    files: Vec<SolutionItemEntry>,
}

/// Sidecar DTO for a project entry in the solution model.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolutionProjectEntry {
    /// Project display name.
    display_name: String,
    /// Absolute project path.
    path: String,
    /// Original solution-relative project path.
    relative_path: String,
    /// Project type name, GUID, or extension.
    project_type: String,
    /// Stable identity from the solution model.
    identity: String,
    /// Parent solution folder display name.
    parent_folder: Option<String>,
    /// Parent solution folder path.
    parent_folder_path: Option<String>,
    /// Zero-based project declaration order.
    declaration_order: usize,
}

/// Sidecar DTO for a virtual solution folder.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolutionFolderEntry {
    /// Folder display name.
    name: String,
    /// Slash-delimited folder path.
    path: String,
    /// Stable identity from the solution model.
    identity: String,
    /// Parent folder path, if nested.
    parent_path: Option<String>,
    /// Parent folder name, if nested.
    parent_name: Option<String>,
    /// Zero-based folder declaration order.
    declaration_order: usize,
}

/// Sidecar DTO for a solution item file.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolutionItemEntry {
    /// Absolute file path.
    path: String,
    /// Original solution-relative file path.
    relative_path: String,
    /// Parent folder name.
    parent_folder: Option<String>,
    /// Parent folder path.
    parent_folder_path: Option<String>,
    /// Zero-based file declaration order.
    declaration_order: usize,
}

/// Handle the `sharplsp/workspaceSymbols` request.
pub fn handle(
    params: &WorkspaceSymbolsParams,
    parsers: &TsParsers,
    vfs: &Vfs,
    runtime: &tokio::runtime::Runtime,
    solution_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<WorkspaceSymbolsResponse> {
    let sln_data = read_solution(params, runtime, solution_sidecar)?;

    info!(
        "sharplsp/workspaceSymbols: {} projects, {} folders, {} files from {} ({})",
        sln_data.projects.len(),
        sln_data.folders.len(),
        sln_data.file_count,
        sln_data.path,
        sln_data.format
    );

    let project_nodes: Vec<ProjectNode> = sln_data
        .projects
        .iter()
        .filter_map(|proj| {
            let mut node = build_project_node(proj, parsers, vfs).ok()?;
            node.parent_folder.clone_from(&proj.parent_folder);
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
    /// Absolute solution path.
    path: String,
    /// Solution format.
    format: String,
    /// Project entries discovered in the solution.
    projects: Vec<ProjectInfo>,
    /// Solution folder entries.
    folders: Vec<SolutionFolderNode>,
    /// Number of solution item files ignored for project tree purposes.
    file_count: usize,
}

/// Read solution structure from the sidecar-owned solution model.
fn read_solution(
    params: &WorkspaceSymbolsParams,
    runtime: &tokio::runtime::Runtime,
    solution_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<SolutionData> {
    let model = request_solution_model(&params.solution, runtime, solution_sidecar)?;
    let projects = model_projects(&model);
    let folders = model_folders(&model.folders);
    let file_count = solution_item_count(&model.files);
    Ok(SolutionData {
        path: model.path,
        format: model.format,
        projects,
        folders,
        file_count,
    })
}

/// Ask the sidecar to read a solution file with the official serializers.
fn request_solution_model(
    solution: &str,
    runtime: &tokio::runtime::Runtime,
    solution_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<SolutionFileModel> {
    let sidecar = solution_sidecar.context("sharplsp/workspaceSymbols requires a sidecar")?;
    let payload = rmp_serde::to_vec(solution).context("serialize solution/read request")?;
    let response = runtime
        .block_on(sidecar.request("solution/read", payload))
        .context("sidecar solution/read request")?;
    rmp_serde::from_slice(&response).context("deserialize solution/read response")
}

/// Convert sidecar project entries to workspace-symbol project info.
fn model_projects(model: &SolutionFileModel) -> Vec<ProjectInfo> {
    let mut projects: Vec<ProjectInfo> = model
        .projects
        .iter()
        .filter(|project| is_dotnet_project(project))
        .map(|project| project_info(project, &model.folders))
        .collect();
    projects.sort_by(|left, right| {
        left.declaration_order
            .cmp(&right.declaration_order)
            .then_with(|| left.identity.cmp(&right.identity))
    });
    projects
}

/// Convert a sidecar project DTO to local project info.
fn project_info(project: &SolutionProjectEntry, folders: &[SolutionFolderEntry]) -> ProjectInfo {
    ProjectInfo {
        name: project_name(project),
        path: project.path.clone(),
        identity: project.identity.clone(),
        parent_folder: parent_folder_name(project, folders),
        declaration_order: project.declaration_order,
    }
}

/// Resolve a project display name, falling back to the project file stem.
fn project_name(project: &SolutionProjectEntry) -> String {
    if !project.display_name.is_empty() {
        return project.display_name.clone();
    }

    Path::new(&project.path).file_stem().map_or_else(
        || project.relative_path.clone(),
        |stem| stem.to_string_lossy().to_string(),
    )
}

/// Resolve a project's parent solution-folder name.
fn parent_folder_name(
    project: &SolutionProjectEntry,
    folders: &[SolutionFolderEntry],
) -> Option<String> {
    project.parent_folder.clone().or_else(|| {
        let parent_path = project.parent_folder_path.as_ref()?;
        folders
            .iter()
            .find(|folder| folder.path == *parent_path)
            .map(|folder| folder.name.clone())
    })
}

/// Convert sidecar folder entries to workspace-symbol folder nodes.
fn model_folders(folders: &[SolutionFolderEntry]) -> Vec<SolutionFolderNode> {
    let mut ordered: Vec<&SolutionFolderEntry> = folders.iter().collect();
    ordered.sort_by_key(|folder| folder.declaration_order);
    ordered
        .into_iter()
        .map(|folder| SolutionFolderNode {
            name: folder.name.clone(),
            guid: folder.identity.clone(),
            parent_guid: parent_folder_identity(folder, folders),
        })
        .collect()
}

/// Resolve a parent folder identity from a slash-delimited folder path.
fn parent_folder_identity(
    folder: &SolutionFolderEntry,
    folders: &[SolutionFolderEntry],
) -> Option<String> {
    folder
        .parent_path
        .as_ref()
        .and_then(|parent_path| {
            folders
                .iter()
                .find(|candidate| candidate.path == *parent_path)
                .map(|parent| parent.identity.clone())
        })
        .or_else(|| {
            let parent_name = folder.parent_name.as_ref()?;
            folders
                .iter()
                .find(|candidate| candidate.name == *parent_name)
                .map(|parent| parent.identity.clone())
        })
}

/// Count solution item files while touching every field in the sidecar DTO.
fn solution_item_count(files: &[SolutionItemEntry]) -> usize {
    files
        .iter()
        .filter(|file| {
            !file.path.is_empty()
                || !file.relative_path.is_empty()
                || file.parent_folder.is_some()
                || file.parent_folder_path.is_some()
                || file.declaration_order > 0
        })
        .count()
}

/// Check whether the sidecar project entry is a C# or F# project.
fn is_dotnet_project(project: &SolutionProjectEntry) -> bool {
    is_dotnet_project_path(&project.path)
        || is_dotnet_project_path(&project.relative_path)
        || is_dotnet_project_type(&project.project_type)
}

/// Check whether a path points at a C# or F# project file.
fn is_dotnet_project_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("csproj") || extension.eq_ignore_ascii_case("fsproj")
        })
}

/// Check whether a project type marker identifies a C# or F# project.
fn is_dotnet_project_type(project_type: &str) -> bool {
    project_type.eq_ignore_ascii_case(".csproj") || project_type.eq_ignore_ascii_case(".fsproj")
}

/// Intermediate representation of a project discovered in a solution.
struct ProjectInfo {
    /// Project name.
    name: String,
    /// Absolute path to the project file.
    path: String,
    /// Stable identity from the solution model.
    identity: String,
    /// Name of the parent solution folder, if any.
    parent_folder: Option<String>,
    /// Zero-based declaration order from the solution model.
    declaration_order: usize,
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
        parent_folder: project.parent_folder.clone(),
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
}
