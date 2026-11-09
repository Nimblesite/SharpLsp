//! Custom `sharplsp/workspaceSymbols` request handler.
//! Implements [SE-WORKSPACE-SYMBOLS-REQUEST], [SE-SYMBOL-KINDS], and [SE-FSHARP-SYMBOLS].
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
use crate::tree_sitter_parse::{parse_file, LangId, TsParsers};
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
    /// The declared name alone (LSP `selectionRange`): where a reveal lands,
    /// never on the attribute lines `range` starts at. [TEST-GOTO-SOURCE]
    #[serde(rename = "selectionRange")]
    pub selection_range: SymbolRange,
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
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<WorkspaceSymbolsResponse> {
    let target = Path::new(&params.solution);
    if !crate::workspace_targets::is_solution(target) {
        let projects = crate::workspace_targets::projects_of(target)
            .iter()
            .enumerate()
            .map(|(order, path)| standalone_project(path, order))
            .filter_map(|project| {
                build_project_node(&project, parsers, vfs, runtime, fsharp_sidecar).ok()
            })
            .collect();
        return Ok(WorkspaceSymbolsResponse {
            projects,
            solution_folders: Vec::new(),
        });
    }
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
            let mut node = build_project_node(proj, parsers, vfs, runtime, fsharp_sidecar).ok()?;
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

/// A project named directly rather than read from a solution.
fn standalone_project(path: &str, declaration_order: usize) -> ProjectInfo {
    ProjectInfo {
        name: crate::paths::file_stem_of(path).unwrap_or_else(|| path.to_string()),
        path: path.to_string(),
        identity: path.to_string(),
        parent_folder: None,
        declaration_order,
    }
}

/// Resolve a project display name, falling back to the project file stem.
fn project_name(project: &SolutionProjectEntry) -> String {
    if !project.display_name.is_empty() {
        return project.display_name.clone();
    }

    crate::paths::file_stem_of(&project.path).unwrap_or_else(|| project.relative_path.clone())
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
pub(crate) fn is_dotnet_project_path(path: &str) -> bool {
    crate::paths::has_extension(path, &["csproj", "fsproj"])
}

/// Check whether a project type marker identifies a C# or F# project.
fn is_dotnet_project_type(project_type: &str) -> bool {
    crate::paths::is_extension(project_type, &["csproj", "fsproj"])
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
///
/// `.cs` files are parsed syntactically with tree-sitter; `.fs` files have no
/// host grammar, so their symbols are sourced from the FCS sidecar's
/// documentSymbol — the same path the editor outline uses — so F# projects show
/// their files and symbols exactly like C# projects (#119). `[SE-FSHARP-SYMBOLS]`
fn build_project_node(
    project: &ProjectInfo,
    parsers: &TsParsers,
    vfs: &Vfs,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<ProjectNode> {
    let proj_dir = Path::new(&project.path)
        .parent()
        .context("project has no parent")?;

    let source_files = crate::project_sources::project_source_files(
        Path::new(&project.path),
        proj_dir,
        runtime,
        fsharp_sidecar,
    );

    let symbols: Vec<FileSymbol> = source_files
        .iter()
        .filter_map(|file| file_symbols(file, parsers, vfs, runtime, fsharp_sidecar).ok())
        .filter(|fs| !fs.symbols.is_empty())
        .collect();

    Ok(ProjectNode {
        name: project.name.clone(),
        path: project.path.clone(),
        symbols,
        parent_folder: project.parent_folder.clone(),
    })
}

/// Extract a file's symbols, dispatching by language: tree-sitter for C#, the
/// FCS sidecar for F#.
fn file_symbols(
    file_path: &str,
    parsers: &TsParsers,
    vfs: &Vfs,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<FileSymbol> {
    match LangId::from_path(Path::new(file_path)) {
        Some(LangId::FSharp) => parse_fsharp_file_symbols(file_path, runtime, fsharp_sidecar),
        _ => parse_file_symbols(file_path, parsers, vfs),
    }
}

/// Extract an F# file's symbols via the FCS sidecar's documentSymbol, mapping
/// the result into the Solution Explorer's symbol model. `[SE-FSHARP-SYMBOLS]`
fn parse_fsharp_file_symbols(
    file_path: &str,
    runtime: &tokio::runtime::Runtime,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<FileSymbol> {
    let sidecar = fsharp_sidecar.context("F# sidecar unavailable for F# symbol extraction")?;
    let items = crate::document_symbols::fetch_fsharp_document_symbols(
        runtime,
        sidecar,
        file_path.to_string(),
    )?;
    Ok(FileSymbol {
        file: file_path.to_string(),
        symbols: items.iter().map(map_sidecar_symbol).collect(),
    })
}

/// Map a sidecar document symbol (and its children) into a `SymbolNode`. Uses
/// the full symbol range to match the C# tree-sitter path's `node_to_symbol`.
fn map_sidecar_symbol(item: &crate::document_symbols::SidecarDocumentSymbol) -> SymbolNode {
    SymbolNode {
        name: item.name.clone(),
        kind: item.kind.clone(),
        detail: None,
        access: None,
        range: SymbolRange {
            start: SymbolPosition {
                line: item.start_line,
                character: item.start_character,
            },
            end: SymbolPosition {
                line: item.end_line,
                character: item.end_character,
            },
        },
        selection_range: SymbolRange {
            start: SymbolPosition {
                line: item.selection_start_line,
                character: item.selection_start_character,
            },
            end: SymbolPosition {
                line: item.selection_end_line,
                character: item.selection_end_character,
            },
        },
        children: item.children.iter().map(map_sidecar_symbol).collect(),
    }
}

/// Parse a single source file and extract symbols.
/// Prefers VFS content (unsaved buffer) over disk for open documents.
/// Implements [SE-LIVE-BUFFER].
fn parse_file_symbols(file_path: &str, parsers: &TsParsers, vfs: &Vfs) -> Result<FileSymbol> {
    let (source, tree) = parse_file(file_path, parsers, vfs)?;

    let symbols = collect_symbols(tree.root_node(), source.as_bytes());
    let symbols = top_level_program(tree.root_node())
        .into_iter()
        .chain(reparent_file_scoped_members(symbols))
        .collect();

    Ok(FileSymbol {
        file: file_path.to_string(),
        symbols,
    })
}

/// Top-level statements compile into the global-namespace `Program` class, so a
/// file of them lists as `Program`, spanning its first to last statement ([SE-TREE]).
fn top_level_program(root: Node<'_>) -> Option<SymbolNode> {
    let mut cursor = root.walk();
    let statements: Vec<Node<'_>> = root
        .children(&mut cursor)
        .filter(|child| child.kind() == "global_statement")
        .collect();
    let (first, last) = (*statements.first()?, *statements.last()?);
    Some(SymbolNode {
        name: "Program".to_string(),
        kind: "Class".to_string(),
        detail: None,
        access: None,
        range: SymbolRange {
            start: node_range(first).start,
            end: node_range(last).end,
        },
        selection_range: node_range(first),
        children: Vec::new(),
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

    let (name, name_node) = crate::syntax::extract_symbol_name(node, source)?;

    let detail = extract_type_detail(node, source);
    let access = crate::sort_members::extract_access_modifiers(&node, source);
    let children = collect_symbols(node, source);

    Some(SymbolNode {
        name,
        kind: kind.to_string(),
        detail,
        access,
        range: node_range(node),
        selection_range: node_range(name_node),
        children,
    })
}

/// The span a tree-sitter node covers, in 0-based lines and characters.
fn node_range(node: Node<'_>) -> SymbolRange {
    let position = |point: tree_sitter::Point| SymbolPosition {
        line: usize_to_u32(point.row),
        character: usize_to_u32(point.column),
    };
    SymbolRange {
        start: position(node.start_position()),
        end: position(node.end_position()),
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
#[path = "workspace_symbols_tests.rs"]
mod tests;
