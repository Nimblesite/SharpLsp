//! Parse .csproj / .fsproj files to extract dependencies.

/// A NuGet package reference from a project file.
#[derive(Debug, Clone, Default)]
pub struct NuGetPackage {
    pub name: String,
    pub version: String,
}

/// A project-to-project reference from a project file.
#[derive(Debug, Clone, Default)]
pub struct ProjectReference {
    pub name: String,
    pub include_path: String,
}

/// All dependencies parsed from a single project file.
#[derive(Debug, Clone, Default)]
pub struct ProjectDependencies {
    pub nuget_packages: Vec<NuGetPackage>,
    pub project_references: Vec<ProjectReference>,
}

/// Parse a .csproj/.fsproj file's XML content for dependencies.
pub fn parse_project_file(content: &str) -> ProjectDependencies {
    ProjectDependencies {
        nuget_packages: parse_nuget_packages(content),
        project_references: parse_project_references(content),
    }
}

/// Extract `<PackageReference Include="..." Version="..." />` entries.
fn parse_nuget_packages(content: &str) -> Vec<NuGetPackage> {
    let mut packages: Vec<NuGetPackage> = content.lines().filter_map(parse_package_line).collect();
    packages.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    packages
}

/// Parse a single `<PackageReference>` line.
fn parse_package_line(line: &str) -> Option<NuGetPackage> {
    let trimmed = line.trim();
    if !contains_case_insensitive(trimmed, "<PackageReference") {
        return None;
    }
    let name = extract_xml_attribute(trimmed, "Include")?;
    let version = extract_xml_attribute(trimmed, "Version").unwrap_or_default();
    Some(NuGetPackage { name, version })
}

/// Extract `<ProjectReference Include="..." />` entries.
fn parse_project_references(content: &str) -> Vec<ProjectReference> {
    let mut refs: Vec<ProjectReference> =
        content.lines().filter_map(parse_project_ref_line).collect();
    refs.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.include_path.cmp(&b.include_path))
    });
    refs
}

/// Parse a single `<ProjectReference>` line.
fn parse_project_ref_line(line: &str) -> Option<ProjectReference> {
    let trimmed = line.trim();
    if !contains_case_insensitive(trimmed, "<ProjectReference") {
        return None;
    }
    let include_path = extract_xml_attribute(trimmed, "Include")?;
    let normalized = include_path.replace('\\', "/");
    let name = extract_file_stem(&normalized);
    Some(ProjectReference {
        name,
        include_path: normalized,
    })
}

/// Extract an XML attribute value: `Name="value"` -> `value`.
fn extract_xml_attribute(text: &str, attr_name: &str) -> Option<String> {
    let search = format!("{}=\"", attr_name);
    let start = text.find(&search)?;
    let value_start = start + search.len();
    let rest = &text[value_start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Extract the file stem from a path (filename without extension).
fn extract_file_stem(path: &str) -> String {
    let filename = path.rsplit('/').next().unwrap_or(path);
    match filename.rfind('.') {
        Some(idx) => filename[..idx].to_string(),
        None => filename.to_string(),
    }
}

/// Case-insensitive substring check.
fn contains_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_CSPROJ: &str = r#"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog" Version="4.0.0" />
    <PackageReference Include="Microsoft.Extensions.Logging" Version="8.0.0" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\SharedLib\SharedLib.csproj" />
    <ProjectReference Include="..\Common\Common.fsproj" />
  </ItemGroup>
</Project>
"#;

    #[test]
    fn parse_extracts_nuget_packages() {
        let deps = parse_project_file(SAMPLE_CSPROJ);
        assert_eq!(deps.nuget_packages.len(), 3);
        assert_eq!(deps.nuget_packages[0].name, "Microsoft.Extensions.Logging");
        assert_eq!(deps.nuget_packages[0].version, "8.0.0");
        assert_eq!(deps.nuget_packages[1].name, "Newtonsoft.Json");
        assert_eq!(deps.nuget_packages[2].name, "Serilog");
    }

    #[test]
    fn parse_extracts_project_references() {
        let deps = parse_project_file(SAMPLE_CSPROJ);
        assert_eq!(deps.project_references.len(), 2);
        assert_eq!(deps.project_references[0].name, "Common");
        assert_eq!(deps.project_references[1].name, "SharedLib");
    }

    #[test]
    fn parse_normalizes_reference_paths() {
        let deps = parse_project_file(SAMPLE_CSPROJ);
        for ref_item in &deps.project_references {
            assert!(!ref_item.include_path.contains('\\'));
        }
    }

    #[test]
    fn parse_empty_content() {
        let deps = parse_project_file("");
        assert!(deps.nuget_packages.is_empty());
        assert!(deps.project_references.is_empty());
    }

    #[test]
    fn extract_attribute_works() {
        let line = r#"<PackageReference Include="Foo" Version="1.2.3" />"#;
        assert_eq!(
            extract_xml_attribute(line, "Include"),
            Some("Foo".to_string())
        );
        assert_eq!(
            extract_xml_attribute(line, "Version"),
            Some("1.2.3".to_string())
        );
        assert_eq!(extract_xml_attribute(line, "Missing"), None);
    }
}
