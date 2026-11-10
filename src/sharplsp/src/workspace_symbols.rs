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

use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::TsParsers;
use crate::vfs::Vfs;

mod file_symbols;
use file_symbols::file_symbols;

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

impl SymbolRange {
    /// The range from `start` to `end`, each a `(line, character)` pair.
    pub const fn new(start: (u32, u32), end: (u32, u32)) -> Self {
        Self {
            start: SymbolPosition {
                line: start.0,
                character: start.1,
            },
            end: SymbolPosition {
                line: end.0,
                character: end.1,
            },
        }
    }
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
    let (projects, solution_folders) = if crate::workspace_targets::is_solution(target) {
        let sln = read_solution(params, runtime, solution_sidecar)?;
        info!(
            "sharplsp/workspaceSymbols: {} projects, {} folders, {} files from {} ({})",
            sln.projects.len(),
            sln.folders.len(),
            sln.file_count,
            sln.path,
            sln.format
        );
        (sln.projects, sln.folders)
    } else {
        let projects = crate::workspace_targets::projects_of(target)
            .iter()
            .enumerate()
            .map(|(order, path)| standalone_project(path, order))
            .collect();
        (projects, Vec::new())
    };
    let projects = projects
        .iter()
        .filter_map(|project| {
            let mut node =
                build_project_node(project, parsers, vfs, runtime, fsharp_sidecar).ok()?;
            node.parent_folder.clone_from(&project.parent_folder);
            Some(node)
        })
        .collect();
    Ok(WorkspaceSymbolsResponse {
        projects,
        solution_folders,
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

#[cfg(test)]
#[path = "workspace_symbols_tests.rs"]
mod tests;
