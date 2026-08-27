//! Pure solution-tree assembly: solution text in, rendered tree out.
//!
//! Extracted from `lib.rs` so the whole parse -> read -> enrich -> format
//! pipeline runs without a `zed::Worktree`, which exists only inside Zed's
//! WASM host and cannot be constructed in a unit test. The extension entry
//! point passes a reader backed by `Worktree::read_text_file`; tests pass a
//! plain closure.

use crate::project;
use crate::solution::{self, SolutionProject};
use crate::tree::{self, EnrichedProject};

/// Parse a solution, read each project file for its dependencies, and render
/// the tree.
pub fn solution_tree<R>(sln_path: &str, sln_content: &str, read: R) -> String
where
    R: Fn(&str) -> Option<String>,
{
    let projects = solution::parse_solution(sln_content, sln_path);
    let enriched: Vec<EnrichedProject> = projects.iter().map(|proj| enrich(proj, &read)).collect();
    tree::format_solution_tree(sln_path, &enriched)
}

/// A project whose file cannot be read still appears in the tree, with no
/// dependencies. A missing or unreadable `.csproj` must never silently drop a
/// project the solution declares — the tree would then disagree with the
/// solution it claims to display.
fn enrich<R>(proj: &SolutionProject, read: &R) -> EnrichedProject
where
    R: Fn(&str) -> Option<String>,
{
    let deps = read(&proj.relative_path)
        .map(|content| project::parse_project_file(&content))
        .unwrap_or_default();

    EnrichedProject {
        name: proj.name.clone(),
        relative_path: proj.relative_path.clone(),
        nuget_packages: deps.nuget_packages,
        project_references: deps.project_references,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const SLNX: &str = r#"<Solution>
  <Project Path="src/Api/Api.csproj" />
  <Project Path="src/Core/Core.csproj" />
</Solution>"#;

    const API_CSPROJ: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Serilog" Version="4.2.0" />
    <ProjectReference Include="../Core/Core.csproj" />
  </ItemGroup>
</Project>"#;

    /// Reader that serves the two project files the solution declares.
    fn reader(path: &str) -> Option<String> {
        match path {
            "src/Api/Api.csproj" => Some(API_CSPROJ.to_owned()),
            "src/Core/Core.csproj" => Some("<Project Sdk=\"Microsoft.NET.Sdk\" />".to_owned()),
            _ => None,
        }
    }

    #[test]
    fn renders_every_project_with_its_dependencies() {
        let text = solution_tree("App.slnx", SLNX, reader);

        assert!(text.contains("Solution: App.slnx"), "{text}");
        assert!(text.contains("Api"), "{text}");
        assert!(text.contains("Core"), "{text}");
        assert!(text.contains("Serilog"), "{text}");
        assert!(text.contains("4.2.0"), "{text}");
    }

    /// The dependency-bearing project renders a Dependencies subtree; the empty
    /// one must not, or every leaf project would gain a hollow section.
    #[test]
    fn omits_the_dependencies_subtree_for_a_project_with_none() {
        let text = solution_tree("App.slnx", SLNX, reader);

        assert_eq!(
            text.matches("Dependencies").count(),
            1,
            "only Api has dependencies, so exactly one subtree is expected: {text}"
        );
    }

    /// An unreadable project file is the common case for a solution checked out
    /// without submodules. The project must still be listed.
    #[test]
    fn keeps_a_project_whose_file_cannot_be_read() {
        let text = solution_tree("App.slnx", SLNX, |_| None);

        assert!(text.contains("Api"), "{text}");
        assert!(text.contains("Core"), "{text}");
        assert!(
            !text.contains("Dependencies"),
            "nothing was readable, so no dependency subtree can be known: {text}"
        );
    }

    /// A solution declaring no projects still renders its header rather than an
    /// empty string, so the slash command output is never blank.
    #[test]
    fn renders_a_header_for_a_solution_with_no_projects() {
        let text = solution_tree("Empty.slnx", "<Solution />", reader);

        assert_eq!(text, "Solution: Empty.slnx\n");
    }

    /// The reader is keyed on the path the solution declares. Passing the wrong
    /// path silently yields a dependency-free tree, so pin the exact lookups.
    #[test]
    fn reads_each_project_at_the_path_the_solution_declares() {
        let seen = RefCell::new(Vec::new());

        let _ = solution_tree("App.slnx", SLNX, |path: &str| {
            seen.borrow_mut().push(path.to_owned());
            None
        });

        assert_eq!(
            seen.into_inner(),
            vec!["src/Api/Api.csproj", "src/Core/Core.csproj"]
        );
    }
}
