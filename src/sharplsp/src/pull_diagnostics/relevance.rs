//! Which compilers a watched-file batch concerns: only those whose loaded graph
//! a touched path belongs to, so a project no compiler loaded never reloads one.
//! [DIAG-LSP-REFRESH] [DIAG-ARCHITECTURE-SCOPE] [DIAG-RESTORE]

use std::collections::HashSet;
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::Result;
use lsp_types::{FileChangeType, FileEvent};

use crate::paths;
use crate::sidecar::manager::SidecarManager;

/// The project-file kinds each compiler loads, in sidecar order: C#, then F#.
const KINDS: [&[&str]; 2] = [&["csproj", "sln", "slnx"], &["fsproj", "sln", "slnx"]];

/// How a touched path can concern a compiler.
enum Touched {
    /// A project or solution file.
    Graph(String),
    /// Inherited or imported build and analyzer configuration.
    Config(String),
    /// An SDK restore output, judged by when it was written.
    Output(String),
    /// A source added or removed.
    Moved(String),
    /// A source edited in place.
    Edited(String),
}

/// Which compilers `changes` concern; a rescan concerns every compiler.
pub(super) async fn concerned(
    rescan: bool,
    changes: &[FileEvent],
    sidecars: [Option<&Arc<SidecarManager>>; 2],
) -> Result<[bool; 2]> {
    if rescan {
        return Ok(sidecars.map(|sidecar| sidecar.is_some()));
    }
    let touched = classify(changes)?;
    let mut concerned = [false; 2];
    for ((flag, sidecar), kinds) in concerned.iter_mut().zip(sidecars).zip(KINDS) {
        if let Some(sidecar) = sidecar.filter(|_| !touched.is_empty()) {
            let graph = LoadedGraph::of(sidecar, kinds).await?;
            *flag = touched.iter().any(|path| graph.concerns(path));
        }
    }
    Ok(concerned)
}

/// The touched paths that can alter a compiler's inputs.
fn classify(changes: &[FileEvent]) -> Result<Vec<Touched>> {
    changes
        .iter()
        .filter_map(|change| touched(change).transpose())
        .collect()
}

/// What one touched path is to a compiler, if anything.
fn touched(change: &FileEvent) -> Result<Option<Touched>> {
    let path = paths::uri_to_path(change.uri.as_str())?;
    let source = paths::is_user_diagnostic_source(&path);
    Ok(if paths::diagnostic_restore_output(&path) {
        Some(Touched::Output(path))
    } else if paths::is_project_graph_file(&path) {
        Some(Touched::Graph(path))
    } else if paths::diagnostic_requires_reload(&path) {
        Some(Touched::Config(path))
    } else if source && change.typ == FileChangeType::CHANGED {
        Some(Touched::Edited(path))
    } else if source {
        Some(Touched::Moved(path))
    } else {
        None
    })
}

/// What one compiler has loaded: enough to tell whether a path concerns it.
struct LoadedGraph {
    /// Directories of the projects it loaded.
    projects: Vec<String>,
    /// Comparison keys of every source and project file it knows.
    inputs: HashSet<String>,
    /// The workspace it opened; a folder discovers new projects beneath it.
    target: Option<String>,
    /// When its last open completed.
    settled: Option<SystemTime>,
    /// The project-file kinds its language loads.
    kinds: &'static [&'static str],
}

impl LoadedGraph {
    /// Read once any open in progress completes, so it is the graph it loaded.
    async fn of(sidecar: &SidecarManager, kinds: &'static [&'static str]) -> Result<Self> {
        let (target, settled) = {
            let opened = sidecar.lock_workspace().await;
            (opened.target.clone(), opened.settled)
        };
        let documents = super::engine_documents(sidecar).await?;
        Ok(Self {
            projects: project_directories(&documents),
            inputs: documents
                .iter()
                .flat_map(|document| [&document.file_path, &document.project_path])
                .map(|path| paths::comparison_key(path))
                .collect(),
            target,
            settled,
            kinds,
        })
    }

    /// Whether `touched` can change what this compiler compiles.
    fn concerns(&self, touched: &Touched) -> bool {
        match touched {
            Touched::Graph(path) => self.loads_project_file(path),
            Touched::Config(path) => paths::directory_of(path).is_some_and(|directory| {
                let directory = directory.to_string_lossy();
                self.any_project(|project| paths::path_within(&directory, project))
            }),
            Touched::Output(path) => {
                paths::output_owner(path).is_some_and(|owner| {
                    self.any_project(|project| paths::native_paths_equal(project, &owner))
                }) && written_after(path, self.settled)
            }
            Touched::Moved(path) => self.any_project(|project| paths::path_within(project, path)),
            Touched::Edited(path) => {
                self.any_project(|project| paths::path_within(project, path))
                    && !self.inputs.contains(&paths::comparison_key(path))
            }
        }
    }

    /// A project file of its language it loaded, its target, or one its folder discovers.
    fn loads_project_file(&self, path: &str) -> bool {
        paths::has_extension(path, self.kinds)
            && (self.inputs.contains(&paths::comparison_key(path))
                || self.target.as_deref().is_some_and(|target| {
                    paths::native_paths_equal(target, path)
                        || (paths::is_directory(target) && paths::path_within(target, path))
                }))
    }

    /// Whether one of its project directories satisfies `matches`.
    fn any_project(&self, matches: impl Fn(&str) -> bool) -> bool {
        self.projects.iter().any(|project| matches(project))
    }
}

/// The distinct directories of the projects `documents` belong to.
fn project_directories(documents: &[super::DiagnosticDocument]) -> Vec<String> {
    let mut directories: Vec<String> = documents
        .iter()
        .filter_map(|document| paths::directory_of(&document.project_path))
        .map(|directory| directory.to_string_lossy().into_owned())
        .collect();
    directories.sort();
    directories.dedup();
    directories
}

/// Whether `path` changed after `settled`: restore outputs written before the
/// compiler's latest open completed were consumed by that open's own restore.
/// An unreadable time, a removed file, counts as changed.
fn written_after(path: &str, settled: Option<SystemTime>) -> bool {
    let modified = std::fs::metadata(path).and_then(|metadata| metadata.modified());
    match (modified, settled) {
        (Ok(modified), Some(settled)) => modified > settled,
        _ => true,
    }
}
