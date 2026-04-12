//! Fast-path XML edits for `PackageReference` / `PackageVersion` in `MSBuild` files.
//!
//! The `dotnet add package` CLI takes several seconds because it runs a full
//! restore before returning. For instant-feedback UX we need to edit the XML
//! ourselves and fire restore in the background.
//!
//! This module is deliberately **line-oriented** rather than round-trip XML:
//! round-trip XML writers re-serialise whitespace, comments, and attribute
//! ordering — all of which matter for project files that live in version
//! control. Line splicing preserves the file byte-for-byte except for the one
//! line we touch.
//!
//! Handles three shapes:
//! - `.csproj` / `.fsproj` / `Directory.Build.props` with `<PackageReference Include="..." Version="..."/>`
//! - `Directory.Packages.props` with `<PackageVersion Include="..." Version="..."/>`
//! - CPM-enabled csproj with `<PackageReference Include="..."/>` (no version)

use std::path::Path;

use anyhow::{Context, Result};
use tracing::info;

/// Result of a single-file edit operation.
#[derive(Debug, Clone)]
pub struct EditOutcome {
    /// Whether the file was actually changed on disk.
    pub modified: bool,
    /// Human-readable description of what happened.
    pub message: String,
}

/// Which element to use when adding a package entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageElement {
    /// `<PackageReference Include="..." Version="..."/>`
    Reference,
    /// `<PackageReference Include="..."/>` (CPM csproj — version in props).
    ReferenceNoVersion,
    /// `<PackageVersion Include="..." Version="..."/>` (Directory.Packages.props).
    Version,
}

impl PackageElement {
    /// Return the XML tag name for this element variant.
    fn tag(self) -> &'static str {
        match self {
            Self::Reference | Self::ReferenceNoVersion => "PackageReference",
            Self::Version => "PackageVersion",
        }
    }
}

/// Add or update a package entry in the given `MSBuild` XML file.
///
/// If a matching element already exists, its `Version` attribute is updated
/// (if applicable). Otherwise a new element is inserted into an existing
/// `<ItemGroup>`, creating one before `</Project>` if none exists.
pub fn add_package(
    path: &Path,
    package_id: &str,
    version: &str,
    element: PackageElement,
) -> Result<EditOutcome> {
    let original =
        std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;

    let updated = upsert(&original, package_id, version, element);
    if updated == original {
        info!(
            "xml_edit: {} already contains {} {} (unchanged)",
            path.display(),
            element.tag(),
            package_id
        );
        return Ok(EditOutcome {
            modified: false,
            message: format!("{package_id} already at {version}"),
        });
    }

    std::fs::write(path, &updated).with_context(|| format!("write {}", path.display()))?;
    info!(
        "xml_edit: wrote {} ({} {})",
        path.display(),
        element.tag(),
        package_id
    );
    Ok(EditOutcome {
        modified: true,
        message: format!("Updated {} in {}", package_id, path.display()),
    })
}

/// Remove a package entry from the given file.
pub fn remove_package(
    path: &Path,
    package_id: &str,
    element: PackageElement,
) -> Result<EditOutcome> {
    let original =
        std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;

    let updated = remove_entry(&original, package_id, element);
    if updated == original {
        return Ok(EditOutcome {
            modified: false,
            message: format!("{package_id} not present"),
        });
    }

    std::fs::write(path, &updated).with_context(|| format!("write {}", path.display()))?;
    info!(
        "xml_edit: removed {} {} from {}",
        element.tag(),
        package_id,
        path.display()
    );
    Ok(EditOutcome {
        modified: true,
        message: format!("Removed {package_id}"),
    })
}

// ── Core line-oriented upsert ───────────────────────────────────

/// Insert or update a package element in the raw XML string.
fn upsert(original: &str, package_id: &str, version: &str, element: PackageElement) -> String {
    let tag = element.tag();
    let needle = format!("Include=\"{package_id}\"");

    // Case 1: element already present — update version in place (unless
    // `ReferenceNoVersion`, in which case there's nothing to do).
    if let Some(line_idx) = find_line_with(original, tag, &needle) {
        return update_existing_line(original, line_idx, version, element);
    }

    // Case 2: insert a new element into the first ItemGroup that already
    // contains elements of the same tag kind, preferring an ItemGroup with
    // at least one `PackageReference` / `PackageVersion`.
    if let Some(pos) = find_insertion_point(original, tag) {
        let indent = detect_content_indent(original, pos, tag);
        let new_line = render_element(package_id, version, element, &indent);
        return splice_line(original, pos, &new_line);
    }

    // Case 3: no suitable ItemGroup — create one just before `</Project>`.
    create_item_group_with(original, package_id, version, element)
}

/// Find the index of the first line containing `<{tag}` and `needle`.
fn find_line_with(text: &str, tag: &str, needle: &str) -> Option<usize> {
    text.lines().enumerate().find_map(|(idx, line)| {
        let trimmed = line.trim_start();
        if trimmed.starts_with(&format!("<{tag}")) && line.contains(needle) {
            Some(idx)
        } else {
            None
        }
    })
}

/// Replace the version attribute (or strip it) on an existing element line.
fn update_existing_line(
    original: &str,
    line_idx: usize,
    version: &str,
    element: PackageElement,
) -> String {
    let lines: Vec<&str> = original.lines().collect();
    let line = lines.get(line_idx).copied().unwrap_or("");

    let new_line: String = match element {
        PackageElement::ReferenceNoVersion => {
            // Strip any existing Version="..." attribute.
            strip_version_attr(line)
        }
        _ => replace_or_insert_version(line, version),
    };

    if new_line == line {
        return original.to_string();
    }

    let mut out = String::with_capacity(original.len() + 16);
    for (i, l) in lines.iter().enumerate() {
        if i == line_idx {
            out.push_str(&new_line);
        } else {
            out.push_str(l);
        }
        out.push('\n');
    }
    // Preserve trailing-newline state of original.
    if !original.ends_with('\n') {
        let _ = out.pop();
    }
    out
}

/// Replace `Version="..."` in a line, or append it before `/>` if absent.
fn replace_or_insert_version(line: &str, version: &str) -> String {
    // Find `Version="..."` and replace.
    if let Some(start) = line.find("Version=\"") {
        let after = &line[start + "Version=\"".len()..];
        if let Some(end_rel) = after.find('"') {
            let end = start + "Version=\"".len() + end_rel;
            let mut updated = String::with_capacity(line.len() + 8);
            updated.push_str(&line[..start + "Version=\"".len()]);
            updated.push_str(version);
            updated.push_str(&line[end..]);
            return updated;
        }
    }
    // No Version attr — insert before the closing `/>`.
    if let Some(close) = line.rfind("/>") {
        let mut updated = String::with_capacity(line.len() + version.len() + 16);
        updated.push_str(line[..close].trim_end());
        updated.push_str(" Version=\"");
        updated.push_str(version);
        updated.push_str("\" />");
        return updated;
    }
    line.to_string()
}

/// Remove the ` Version="..."` attribute from a line.
fn strip_version_attr(line: &str) -> String {
    if let Some(start) = line.find(" Version=\"") {
        let after = &line[start + " Version=\"".len()..];
        if let Some(end_rel) = after.find('"') {
            let end = start + " Version=\"".len() + end_rel + 1;
            let mut updated = String::with_capacity(line.len());
            updated.push_str(&line[..start]);
            updated.push_str(&line[end..]);
            return updated;
        }
    }
    line.to_string()
}

/// Find the byte offset of an insertion point: the line just before the
/// `</ItemGroup>` of the first item group that already contains a package
/// element of the requested tag. Returns `None` if no such item group.
fn find_insertion_point(text: &str, tag: &str) -> Option<usize> {
    let item_group_open = text.match_indices("<ItemGroup").map(|(i, _)| i);
    for open in item_group_open {
        // Slice from this item group to the end.
        let rest = text.get(open..)?;
        let close_rel = rest.find("</ItemGroup>")?;
        let group = rest.get(..close_rel)?;
        if group.contains(&format!("<{tag}")) {
            return Some(open + close_rel);
        }
    }
    None
}

/// Detect the indentation used by sibling content inside the `ItemGroup`
/// that ends at `pos` (where `pos` points at `</ItemGroup>`). We scan
/// backwards for the nearest line containing a `<{tag}` element and copy
/// its leading whitespace. Falls back to 4 spaces.
fn detect_content_indent(text: &str, pos: usize, tag: &str) -> String {
    let prefix = text.get(..pos).unwrap_or("");
    let open_marker = format!("<{tag}");
    for line in prefix.lines().rev() {
        if line.contains(&open_marker) {
            let indent_len = line.chars().take_while(|c| c.is_whitespace()).count();
            return line.get(..indent_len).unwrap_or("    ").to_string();
        }
    }
    "    ".to_string()
}

/// Render a new `PackageReference` or `PackageVersion` XML element string.
fn render_element(
    package_id: &str,
    version: &str,
    element: PackageElement,
    indent: &str,
) -> String {
    match element {
        PackageElement::Reference => {
            format!("{indent}<PackageReference Include=\"{package_id}\" Version=\"{version}\" />")
        }
        PackageElement::ReferenceNoVersion => {
            format!("{indent}<PackageReference Include=\"{package_id}\" />")
        }
        PackageElement::Version => {
            format!("{indent}<PackageVersion Include=\"{package_id}\" Version=\"{version}\" />")
        }
    }
}

/// Insert `new_line` just before the byte offset `pos` (which points at
/// `</ItemGroup>`). Preserves the original newline style.
fn splice_line(original: &str, pos: usize, new_line: &str) -> String {
    let mut out = String::with_capacity(original.len() + new_line.len() + 1);
    let before = original.get(..pos).unwrap_or("");
    let after = original.get(pos..).unwrap_or("");
    out.push_str(before);
    // Ensure the new line starts on its own line.
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(new_line);
    out.push('\n');
    out.push_str(after);
    out
}

/// Create a new `<ItemGroup>` with one package element before `</Project>`.
fn create_item_group_with(
    original: &str,
    package_id: &str,
    version: &str,
    element: PackageElement,
) -> String {
    let close = original.rfind("</Project>");
    let Some(close) = close else {
        // Not a valid project file — append.
        let mut out = original.to_string();
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("<ItemGroup>\n");
        out.push_str(&render_element(package_id, version, element, "  "));
        out.push('\n');
        out.push_str("</ItemGroup>\n");
        return out;
    };

    let before = original.get(..close).unwrap_or("");
    let after = original.get(close..).unwrap_or("");
    let indent = "  ";
    let mut out = String::with_capacity(original.len() + 128);
    out.push_str(before);
    if !before.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(indent);
    out.push_str("<ItemGroup>\n");
    out.push_str(indent);
    out.push_str("  ");
    out.push_str(render_element(package_id, version, element, "").trim_start());
    out.push('\n');
    out.push_str(indent);
    out.push_str("</ItemGroup>\n");
    out.push_str(after);
    out
}

/// Remove the first line matching `<{tag} ... Include="{package_id}" ...>`.
fn remove_entry(original: &str, package_id: &str, element: PackageElement) -> String {
    let tag = element.tag();
    let needle = format!("Include=\"{package_id}\"");
    let lines: Vec<&str> = original.lines().collect();
    let mut keep: Vec<&str> = Vec::with_capacity(lines.len());
    let mut removed = false;
    for line in &lines {
        let trimmed = line.trim_start();
        if !removed && trimmed.starts_with(&format!("<{tag}")) && line.contains(&needle) {
            removed = true;
            continue;
        }
        keep.push(line);
    }
    if !removed {
        return original.to_string();
    }
    let mut out = keep.join("\n");
    if original.ends_with('\n') {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMPLE_CSPROJ: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
"#;

    #[test]
    fn adds_new_reference_to_existing_item_group() {
        let out = upsert(SIMPLE_CSPROJ, "Serilog", "3.1.0", PackageElement::Reference);
        assert!(out.contains("Include=\"Serilog\" Version=\"3.1.0\""));
        assert!(out.contains("Include=\"Newtonsoft.Json\""));
        // Indentation preserved.
        assert!(out.contains("    <PackageReference Include=\"Serilog\""));
    }

    #[test]
    fn updates_existing_version() {
        let out = upsert(
            SIMPLE_CSPROJ,
            "Newtonsoft.Json",
            "13.0.4",
            PackageElement::Reference,
        );
        assert!(out.contains("Version=\"13.0.4\""));
        assert!(!out.contains("Version=\"13.0.3\""));
    }

    #[test]
    fn no_change_when_already_present_and_same_version() {
        let out = upsert(
            SIMPLE_CSPROJ,
            "Newtonsoft.Json",
            "13.0.3",
            PackageElement::Reference,
        );
        assert_eq!(out, SIMPLE_CSPROJ);
    }

    #[test]
    fn removes_reference() {
        let out = remove_entry(SIMPLE_CSPROJ, "Newtonsoft.Json", PackageElement::Reference);
        assert!(!out.contains("Newtonsoft.Json"));
    }

    #[test]
    fn cpm_reference_has_no_version() {
        let out = upsert(
            SIMPLE_CSPROJ,
            "Serilog",
            "3.1.0",
            PackageElement::ReferenceNoVersion,
        );
        assert!(out.contains("<PackageReference Include=\"Serilog\" />"));
        assert!(!out.contains("Include=\"Serilog\" Version="));
    }

    #[test]
    fn package_version_for_cpm_props() {
        let props = r#"<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>
"#;
        let out = upsert(props, "Serilog", "3.1.0", PackageElement::Version);
        assert!(out.contains("<PackageVersion Include=\"Serilog\" Version=\"3.1.0\""));
        assert!(!out.contains("Version=\"3.0.0\""));
    }

    #[test]
    fn creates_item_group_if_none_exists() {
        let bare = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
"#;
        let out = upsert(bare, "Serilog", "3.1.0", PackageElement::Reference);
        assert!(out.contains("<ItemGroup>"));
        assert!(out.contains("Include=\"Serilog\" Version=\"3.1.0\""));
    }

    #[test]
    fn build_props_file_gets_reference() {
        let props = r#"<Project>
  <ItemGroup>
    <PackageReference Include="Common.Package" Version="1.0.0" />
  </ItemGroup>
</Project>
"#;
        let out = upsert(props, "Another.Package", "2.0.0", PackageElement::Reference);
        assert!(out.contains("Common.Package"));
        assert!(out.contains("Another.Package"));
    }

    #[test]
    fn preserves_formatting_exactly_for_untouched_content() {
        // Comments and whitespace should survive.
        let src = "<Project>\n  <!-- keep me -->\n  <ItemGroup>\n    <PackageReference Include=\"A\" Version=\"1.0.0\" />\n  </ItemGroup>\n</Project>\n";
        let out = upsert(src, "B", "2.0.0", PackageElement::Reference);
        assert!(out.contains("<!-- keep me -->"));
        assert!(out.contains('A'));
        assert!(out.contains('B'));
    }

    #[test]
    fn no_trailing_newline_preserved() {
        // Input without trailing newline must produce output without trailing newline.
        let src = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <ItemGroup>\n    <PackageReference Include=\"A\" Version=\"1.0.0\" />\n  </ItemGroup>\n</Project>";
        let out = upsert(src, "B", "2.0.0", PackageElement::Reference);
        assert!(!out.ends_with('\n'), "output must not add trailing newline");
        assert!(out.contains("Include=\"B\""));
    }

    #[test]
    fn replace_or_insert_version_inserts_when_no_version_attr() {
        // A line with Include but no Version= attr.
        let line = "    <PackageReference Include=\"Foo\" />";
        let out = replace_or_insert_version(line, "1.2.3");
        assert!(out.contains("Version=\"1.2.3\""));
        assert!(out.ends_with("/>"));
    }

    #[test]
    fn strip_version_attr_removes_version() {
        let line = "    <PackageReference Include=\"Foo\" Version=\"1.2.3\" />";
        let out = strip_version_attr(line);
        assert!(!out.contains("Version="));
        assert!(out.contains("Include=\"Foo\""));
    }

    #[test]
    fn strip_version_attr_no_op_when_absent() {
        let line = "    <PackageReference Include=\"Foo\" />";
        let out = strip_version_attr(line);
        assert_eq!(out, line);
    }

    #[test]
    fn removes_package_when_absent_returns_unchanged() {
        let out = remove_entry(SIMPLE_CSPROJ, "NonExistent", PackageElement::Reference);
        assert_eq!(out, SIMPLE_CSPROJ);
    }

    #[test]
    fn upsert_version_element_removes_version_attr() {
        // PackageElement::ReferenceNoVersion should strip Version= from existing entries.
        let out = upsert(
            SIMPLE_CSPROJ,
            "Newtonsoft.Json",
            "13.0.3",
            PackageElement::ReferenceNoVersion,
        );
        // The existing Newtonsoft.Json entry should now have no Version attribute.
        assert!(!out.contains("Newtonsoft.Json\" Version="));
    }

    #[test]
    fn add_package_writes_new_package_to_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("Project.csproj");
        std::fs::write(&path, SIMPLE_CSPROJ).unwrap();

        let result = add_package(&path, "Serilog", "3.1.0", PackageElement::Reference).unwrap();
        assert!(result.modified);

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("Include=\"Serilog\" Version=\"3.1.0\""));
    }

    #[test]
    fn add_package_no_change_when_already_present() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("Project.csproj");
        std::fs::write(&path, SIMPLE_CSPROJ).unwrap();

        let result =
            add_package(&path, "Newtonsoft.Json", "13.0.3", PackageElement::Reference).unwrap();
        assert!(!result.modified);
        assert!(result.message.contains("already at 13.0.3"));
    }

    #[test]
    fn remove_package_from_file_modifies_content() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("Project.csproj");
        std::fs::write(&path, SIMPLE_CSPROJ).unwrap();

        let result = remove_package(&path, "Newtonsoft.Json", PackageElement::Reference).unwrap();
        assert!(result.modified);

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains("Newtonsoft.Json"));
    }

    #[test]
    fn remove_package_no_change_when_not_present() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("Project.csproj");
        std::fs::write(&path, SIMPLE_CSPROJ).unwrap();

        let result = remove_package(&path, "NonExistent", PackageElement::Reference).unwrap();
        assert!(!result.modified);
    }
}
