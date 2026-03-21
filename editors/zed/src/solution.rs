//! Parse .sln files to extract project entries.

/// A project entry extracted from a .sln file.
#[derive(Debug, Clone)]
pub struct SolutionProject {
    pub name: String,
    pub relative_path: String,
}

/// Parse a .sln file's text content and extract project entries.
///
/// The .sln format declares projects as:
/// ```text
/// Project("{type-guid}") = "Name", "relative\path.csproj", "{guid}"
/// EndProject
/// ```
///
/// Only .csproj and .fsproj entries are returned (solution folders are
/// excluded).
pub fn parse_solution(content: &str, sln_path: &str) -> Vec<SolutionProject> {
    let sln_dir = parent_dir(sln_path);
    content
        .lines()
        .filter_map(|line| parse_project_line(line, &sln_dir))
        .collect()
}

/// Extract a single project entry from a `Project(...)` line.
fn parse_project_line(line: &str, sln_dir: &str) -> Option<SolutionProject> {
    let trimmed = line.trim();
    if !trimmed.starts_with("Project(") {
        return None;
    }

    let after_eq = trimmed.split('=').nth(1)?;
    let parts: Vec<&str> = after_eq.split(',').collect();
    if parts.len() < 2 {
        return None;
    }

    let name = unquote(parts.first()?);
    let raw_path = unquote(parts.get(1)?);

    if !is_dotnet_project(&raw_path) {
        return None;
    }

    let normalized = normalize_path(&raw_path);
    let relative_path = join_paths(sln_dir, &normalized);

    Some(SolutionProject {
        name,
        relative_path,
    })
}

/// Check if a path points to a .NET project file.
fn is_dotnet_project(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".csproj") || lower.ends_with(".fsproj")
}

/// Remove surrounding whitespace and double quotes from a string.
fn unquote(value: &str) -> String {
    value.trim().trim_matches('"').to_string()
}

/// Normalize Windows backslashes to forward slashes.
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

/// Extract the parent directory from a path string.
fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[..idx].to_string(),
        None => String::new(),
    }
}

/// Join a directory and a relative path, handling empty directories.
fn join_paths(dir: &str, relative: &str) -> String {
    if dir.is_empty() {
        relative.to_string()
    } else {
        format!("{}/{}", dir, relative)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_SLN: &str = r#"
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyApp", "src\MyApp\MyApp.csproj", "{A1B2C3D4}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyApp.Tests", "tests\MyApp.Tests\MyApp.Tests.csproj", "{E5F6A7B8}"
EndProject
Project("{6EC3EE1D-3C4E-46DD-8F32-0CC8E7565705}") = "FSharpLib", "src\FSharpLib\FSharpLib.fsproj", "{C9D0E1F2}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "SolutionFolder", "SolutionFolder", "{12345678}"
EndProject
Global
EndGlobal
"#;

    #[test]
    fn parse_extracts_dotnet_projects_only() {
        let projects = parse_solution(SAMPLE_SLN, "MySolution.sln");
        assert_eq!(projects.len(), 3);
        assert_eq!(projects[0].name, "MyApp");
        assert_eq!(projects[0].relative_path, "src/MyApp/MyApp.csproj");
        assert_eq!(projects[1].name, "MyApp.Tests");
        assert_eq!(projects[2].name, "FSharpLib");
        assert!(projects[2].relative_path.ends_with(".fsproj"));
    }

    #[test]
    fn parse_normalizes_backslashes() {
        let projects = parse_solution(SAMPLE_SLN, "MySolution.sln");
        for proj in &projects {
            assert!(!proj.relative_path.contains('\\'));
        }
    }

    #[test]
    fn parse_handles_nested_sln_path() {
        let projects = parse_solution(SAMPLE_SLN, "repo/MySolution.sln");
        assert_eq!(projects[0].relative_path, "repo/src/MyApp/MyApp.csproj");
    }

    #[test]
    fn parse_empty_content_returns_empty() {
        let projects = parse_solution("", "empty.sln");
        assert!(projects.is_empty());
    }
}
