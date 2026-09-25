//! Targets `sharplsp/workspaceSymbols` accepts besides a solution: a single
//! project file, or a folder holding projects - what a workspace without a
//! solution discovers its tests from. Implements [SE-WORKSPACE-SYMBOLS-REQUEST].

use std::path::Path;

use crate::source_walk::collect_files;
use crate::workspace_symbols::is_dotnet_project_path;

/// Whether `target` names a solution file (`.sln` / `.slnx`), in any casing.
pub(crate) fn is_solution(target: &Path) -> bool {
    target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("sln") || extension.eq_ignore_ascii_case("slnx")
        })
}

/// The C# and F# projects a non-solution target stands for: the project file
/// itself, or every project under a folder, build output skipped, in path order.
pub(crate) fn projects_of(target: &Path) -> Vec<String> {
    if target.is_file() {
        let path = target.to_string_lossy().to_string();
        return if is_dotnet_project_path(&path) {
            vec![path]
        } else {
            Vec::new()
        };
    }
    let mut projects = Vec::new();
    collect_files(target, is_project_file, &mut projects);
    projects.sort();
    projects
}

/// Whether `path` is a C# or F# project file, in any casing.
fn is_project_file(path: &Path) -> bool {
    is_dotnet_project_path(&path.to_string_lossy())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "test code - panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_stands_for_every_project_under_it_but_not_build_output() {
        let root = tempfile::tempdir().unwrap();
        for project in [
            "App/App.csproj",
            "Tests/Tests.FSPROJ",
            "App/bin/Stale.csproj",
        ] {
            let path = root.path().join(project);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "<Project />").unwrap();
        }
        std::fs::write(root.path().join("App/readme.md"), "not a project").unwrap();

        let found: Vec<String> = projects_of(root.path())
            .iter()
            .map(|path| path.replace('\\', "/"))
            .collect();

        assert_eq!(found.len(), 2, "bin/ output is not a project: {found:?}");
        assert!(found[0].ends_with("App/App.csproj"), "{found:?}");
        assert!(
            found[1].ends_with("Tests/Tests.FSPROJ"),
            "any casing: {found:?}"
        );
    }

    #[test]
    fn a_project_file_stands_for_itself_and_a_solution_is_not_a_project_target() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Lib.fsproj");
        std::fs::write(&project, "<Project />").unwrap();
        let notes = root.path().join("notes.txt");
        std::fs::write(&notes, "").unwrap();

        assert_eq!(
            projects_of(&project),
            vec![project.to_string_lossy().to_string()]
        );
        assert!(
            projects_of(&notes).is_empty(),
            "a non-project file stands for nothing"
        );
        assert!(is_solution(Path::new("/w/App.SLNX")) && is_solution(Path::new("a.sln")));
        assert!(!is_solution(&project), "a project is not a solution");
    }
}
