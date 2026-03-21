//! Format solution and project data as an indented text tree.

use crate::project::{NuGetPackage, ProjectReference};

/// A project enriched with parsed dependency information.
#[derive(Debug, Clone)]
pub struct EnrichedProject {
    pub name: String,
    pub relative_path: String,
    pub nuget_packages: Vec<NuGetPackage>,
    pub project_references: Vec<ProjectReference>,
}

/// Format the full solution tree as a text string.
pub fn format_solution_tree(sln_path: &str, projects: &[EnrichedProject]) -> String {
    let mut output = String::with_capacity(1024);
    output.push_str(&format!("Solution: {}\n", sln_path));

    for (idx, project) in projects.iter().enumerate() {
        let is_last = idx == projects.len() - 1;
        format_project(&mut output, project, is_last);
    }

    output
}

/// Format a single project node with its dependencies.
fn format_project(output: &mut String, project: &EnrichedProject, is_last: bool) {
    let prefix = if is_last { CORNER } else { TEE };
    let file = extract_filename(&project.relative_path);
    output.push_str(&format!(
        "{} Project: {} ({})\n",
        prefix, project.name, file
    ));

    let continuation = if is_last { BLANK } else { PIPE };
    let has_deps = has_dependencies(project);

    if has_deps {
        format_dependencies(output, project, continuation);
    }
}

/// Format the Dependencies subtree for a project.
fn format_dependencies(output: &mut String, project: &EnrichedProject, cont: &str) {
    output.push_str(&format!("{}{} Dependencies\n", cont, CORNER));
    let dep_cont = format!("{}{}", cont, BLANK);

    let has_packages = !project.nuget_packages.is_empty();
    let has_refs = !project.project_references.is_empty();

    if has_packages {
        let pkg_prefix = if has_refs { TEE } else { CORNER };
        format_packages(output, &project.nuget_packages, &dep_cont, pkg_prefix);
    }

    if has_refs {
        format_project_refs(output, &project.project_references, &dep_cont);
    }
}

/// Format the Packages subfolder.
fn format_packages(output: &mut String, packages: &[NuGetPackage], cont: &str, prefix: &str) {
    output.push_str(&format!("{}{} Packages\n", cont, prefix));
    let is_last_section = prefix == CORNER;
    let pkg_cont = if is_last_section {
        format!("{}{}", cont, BLANK)
    } else {
        format!("{}{}", cont, PIPE)
    };

    for (idx, pkg) in packages.iter().enumerate() {
        let item_prefix = if idx == packages.len() - 1 {
            CORNER
        } else {
            TEE
        };
        let version_display = format_version(&pkg.version);
        output.push_str(&format!(
            "{}{} {}{}\n",
            pkg_cont, item_prefix, pkg.name, version_display
        ));
    }
}

/// Format the Project References subfolder.
fn format_project_refs(output: &mut String, refs: &[ProjectReference], cont: &str) {
    output.push_str(&format!("{}{} Project References\n", cont, CORNER));
    let ref_cont = format!("{}{}", cont, BLANK);

    for (idx, reference) in refs.iter().enumerate() {
        let item_prefix = if idx == refs.len() - 1 { CORNER } else { TEE };
        output.push_str(&format!(
            "{}{} {} ({})\n",
            ref_cont, item_prefix, reference.name, reference.include_path
        ));
    }
}

/// Check whether a project has any dependencies to display.
fn has_dependencies(project: &EnrichedProject) -> bool {
    !project.nuget_packages.is_empty() || !project.project_references.is_empty()
}

/// Format a version string for display (empty version omitted).
fn format_version(version: &str) -> String {
    if version.is_empty() {
        String::new()
    } else {
        format!(" {}", version)
    }
}

/// Extract the filename from a path.
fn extract_filename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

// ── Box-drawing constants ───────────────────────────────────────

const TEE: &str = "\u{251c}\u{2500}\u{2500}";
const CORNER: &str = "\u{2514}\u{2500}\u{2500}";
const PIPE: &str = "\u{2502}   ";
const BLANK: &str = "    ";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{NuGetPackage, ProjectReference};

    fn sample_projects() -> Vec<EnrichedProject> {
        vec![
            EnrichedProject {
                name: "MyApp".to_string(),
                relative_path: "src/MyApp/MyApp.csproj".to_string(),
                nuget_packages: vec![
                    NuGetPackage {
                        name: "Newtonsoft.Json".to_string(),
                        version: "13.0.3".to_string(),
                    },
                    NuGetPackage {
                        name: "Serilog".to_string(),
                        version: "4.0.0".to_string(),
                    },
                ],
                project_references: vec![ProjectReference {
                    name: "SharedLib".to_string(),
                    include_path: "../SharedLib/SharedLib.csproj".to_string(),
                }],
            },
            EnrichedProject {
                name: "SharedLib".to_string(),
                relative_path: "src/SharedLib/SharedLib.csproj".to_string(),
                nuget_packages: vec![],
                project_references: vec![],
            },
        ]
    }

    #[test]
    fn format_includes_solution_header() {
        let output = format_solution_tree("My.sln", &sample_projects());
        assert!(output.starts_with("Solution: My.sln\n"));
    }

    #[test]
    fn format_includes_all_projects() {
        let output = format_solution_tree("My.sln", &sample_projects());
        assert!(output.contains("Project: MyApp (MyApp.csproj)"));
        assert!(output.contains("Project: SharedLib (SharedLib.csproj)"));
    }

    #[test]
    fn format_includes_packages() {
        let output = format_solution_tree("My.sln", &sample_projects());
        assert!(output.contains("Newtonsoft.Json 13.0.3"));
        assert!(output.contains("Serilog 4.0.0"));
    }

    #[test]
    fn format_includes_project_references() {
        let output = format_solution_tree("My.sln", &sample_projects());
        assert!(output.contains("SharedLib"));
        assert!(output.contains("Project References"));
    }

    #[test]
    fn format_empty_solution() {
        let output = format_solution_tree("Empty.sln", &[]);
        assert_eq!(output, "Solution: Empty.sln\n");
    }

    #[test]
    fn format_project_without_deps_has_no_dependencies_section() {
        let projects = vec![EnrichedProject {
            name: "Bare".to_string(),
            relative_path: "Bare.csproj".to_string(),
            nuget_packages: vec![],
            project_references: vec![],
        }];
        let output = format_solution_tree("B.sln", &projects);
        assert!(!output.contains("Dependencies"));
    }
}
