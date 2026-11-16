//! What one published package version depends on, read from its `.nuspec`: the
//! flat container of an `HTTP` source, or the `.nupkg` of a folder feed.
//! Implements [PKG-VULN-FIX]: a parent version that pulls a fixed child is the
//! lower-impact fix for a transitive vulnerability.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use quick_xml::events::{BytesStart, Event};
use tracing::warn;

use super::parse::attribute_value;
use super::sources;

/// One declared dependency: the package and the version range it asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    /// The package depended on.
    pub id: String,
    /// The `NuGet` version range; empty when the dependency names none.
    pub range: String,
}

/// The dependency groups of `package_id` at `version`, one per target
/// framework; a package that declares its dependencies without groups has
/// one. `None` when no source of the project has that version.
pub async fn of(project: &str, package_id: &str, version: &str) -> Option<Vec<Vec<Dependency>>> {
    let sources = sources::resolve(Path::new(project));
    for source in &sources.http {
        match sources::nuspec(source, package_id, version).await {
            Ok(Some(text)) => return Some(groups(&text)),
            Ok(None) => {}
            Err(error) => warn!(source = %source, %error, "Package manifest unavailable"),
        }
    }
    folder_nuspec(&sources.folders, package_id, version).map(|text| groups(&text))
}

/// The `.nuspec` inside `{id}.{version}.nupkg` in the first folder feed that
/// holds it.
fn folder_nuspec(folders: &[PathBuf], package_id: &str, version: &str) -> Option<String> {
    let wanted = format!("{package_id}.{version}.nupkg").to_ascii_lowercase();
    folders.iter().find_map(|folder| {
        let package = std::fs::read_dir(folder).ok()?.find_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            (name.to_ascii_lowercase() == wanted).then(|| entry.path())
        })?;
        packed_nuspec(&package)
    })
}

/// The manifest at the root of a `.nupkg`, which is a zip archive.
fn packed_nuspec(package: &Path) -> Option<String> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(package).ok()?).ok()?;
    let manifest = archive
        .file_names()
        .filter_map(Result::ok)
        .find(|name| !name.contains('/') && name.to_ascii_lowercase().ends_with(".nuspec"))?
        .into_owned();
    let mut text = String::new();
    let _ = archive
        .by_name(&manifest)
        .ok()?
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

/// The dependency groups a `.nuspec` declares, read through the XML parser.
pub(crate) fn groups(nuspec: &str) -> Vec<Vec<Dependency>> {
    let mut reader = quick_xml::Reader::from_str(nuspec);
    let mut groups: Vec<Vec<Dependency>> = Vec::new();
    let mut grouped = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element) | Event::Empty(element)) => {
                match element.local_name().as_ref() {
                    b"group" => {
                        grouped = true;
                        groups.push(Vec::new());
                    }
                    b"dependency" => {
                        if !grouped && groups.is_empty() {
                            groups.push(Vec::new());
                        }
                        let declared = dependency(&element, reader.decoder());
                        if let (Some(group), Some(declared)) = (groups.last_mut(), declared) {
                            group.push(declared);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => return groups,
            Ok(_) => {}
        }
    }
}

/// One `<dependency id="…" version="…" />`.
fn dependency(
    element: &BytesStart<'_>,
    decoder: quick_xml::encoding::Decoder,
) -> Option<Dependency> {
    let id = attribute_value(element, "id", decoder).ok()??;
    let range = attribute_value(element, "version", decoder)
        .ok()
        .flatten()
        .unwrap_or_default();
    Some(Dependency { id, range })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dependency on `id` asking for `range`.
    fn on(id: &str, range: &str) -> Dependency {
        Dependency {
            id: id.to_owned(),
            range: range.to_owned(),
        }
    }

    #[test]
    fn groups_are_read_per_target_framework_and_without_groups() {
        let grouped = r#"<?xml version="1.0"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Parent</id>
    <dependencies>
      <group targetFramework="net8.0">
        <dependency id="Child" version="1.5.0" exclude="Build,Analyzers" />
        <dependency id="Other" version="[2.0.0, 3.0.0)" />
      </group>
      <group targetFramework="netstandard2.0" />
      <group targetFramework="net10.0">
        <dependency id="Child" version="2.0.0" />
      </group>
    </dependencies>
  </metadata>
</package>"#;
        assert_eq!(
            groups(grouped),
            vec![
                vec![on("Child", "1.5.0"), on("Other", "[2.0.0, 3.0.0)")],
                Vec::new(),
                vec![on("Child", "2.0.0")],
            ]
        );
        let flat = r#"<package><metadata><dependencies>
            <dependency id="A &amp; B" version="1.0.0" />
            <dependency id="NoRange" />
            <dependency version="9.9.9" />
        </dependencies></metadata></package>"#;
        assert_eq!(
            groups(flat),
            vec![vec![on("A & B", "1.0.0"), on("NoRange", "")]],
            "entities are decoded; a dependency without an id is skipped"
        );
        assert_eq!(
            groups("<package><metadata /></package>"),
            Vec::<Vec<Dependency>>::new()
        );
        assert_eq!(groups("not xml <<"), Vec::<Vec<Dependency>>::new());
    }

    #[test]
    fn a_folder_feed_package_yields_its_manifest() {
        use std::io::Write as _;
        let Ok(feed) = tempfile::tempdir() else {
            return;
        };
        let package = feed.path().join("Parent.1.1.0.nupkg");
        let manifest = r#"<package><metadata><dependencies><group targetFramework="net10.0"><dependency id="Child" version="1.5.0" /></group></dependencies></metadata></package>"#;
        let written = std::fs::File::create(&package).ok().and_then(|file| {
            let mut archive = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            archive
                .start_file("lib/net10.0/Parent.nuspec", options)
                .ok()?;
            archive.write_all(b"<package />").ok()?;
            archive.start_file("Parent.nuspec", options).ok()?;
            archive.write_all(manifest.as_bytes()).ok()?;
            archive.finish().ok()
        });
        assert!(written.is_some(), "the fixture package is written");
        let folders = [feed.path().to_path_buf()];
        let found = folder_nuspec(&folders, "parent", "1.1.0").map(|text| groups(&text));
        assert_eq!(
            found,
            Some(vec![vec![on("Child", "1.5.0")]]),
            "the root manifest"
        );
        assert_eq!(
            folder_nuspec(&folders, "Parent", "1.2.0"),
            None,
            "no such version"
        );
        assert_eq!(
            folder_nuspec(&[], "Parent", "1.1.0"),
            None,
            "no folder feeds"
        );
    }
}
