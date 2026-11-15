//! The project's configured `NuGet` sources — folder feeds and `HTTP` v3
//! sources — plus the advisory ranges their `VulnerabilityInfo` resources
//! publish. Implements [PKG-VULN-FIX]: known-good version selection needs the
//! affected ranges and the published version list, from the sources the project
//! actually restores from (mirrors included), never a hardcoded nuget.org.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::Deserialize;
use tracing::{info, warn};

use super::version_range::{parse_range, VersionRangeSpec};

/// How long fetched source data (service indexes, advisory pages, version
/// lists) stays fresh — the advisory feed's cache expiry that refreshes
/// vulnerable-package diagnostics. [PKG-VULN-DIAG]
const CACHE_TTL: Duration = Duration::from_mins(10);

/// The default source `NuGet` uses with no `NuGet.Config`: nuget.org.
const DEFAULT_SOURCE: &str = "https://api.nuget.org/v3/index.json";

/// One advisory range as published by a `VulnerabilityInfo` page. Only the
/// range matters for known-good selection: severities come from the scan.
#[derive(Debug, Clone)]
pub struct AdvisoryRange {
    /// The affected version range.
    pub range: VersionRangeSpec,
}

/// Every advisory for one package across the project's audit sources
/// (`<auditSources>`, falling back to `HTTP` package sources — `NuGetAudit`'s
/// own rule).
pub async fn advisories(project: &str, package_id: &str) -> Vec<AdvisoryRange> {
    let sources = resolve(Path::new(project));
    let audit = if sources.audit.is_empty() {
        sources.http
    } else {
        sources.audit
    };
    let mut found = Vec::new();
    for source in audit {
        match raw_advisories(&source).await {
            Ok(raw) => found.extend(raw.into_iter().filter_map(|advisory| {
                advisory
                    .id
                    .eq_ignore_ascii_case(package_id)
                    .then(|| parse_range(&advisory.range).ok())
                    .flatten()
                    .map(|range| AdvisoryRange { range })
            })),
            Err(error) => warn!(source = %source, %error, "Advisory source unavailable"),
        }
    }
    found
}

/// Every published version of `package_id` across the project's configured
/// sources: `HTTP` flat containers and folder-feed `{id}.{version}.nupkg` files.
pub async fn candidate_versions(project: &str, package_id: &str) -> Vec<String> {
    let sources = resolve(Path::new(project));
    let mut versions = Vec::new();
    for source in sources.http {
        match flat_container_versions(&source, package_id).await {
            Ok(listed) => versions.extend(listed),
            Err(error) => warn!(source = %source, %error, "Version list unavailable"),
        }
    }
    versions.extend(folder_versions(&sources.folders, package_id));
    versions
}

// ── NuGet.Config resolution ────────────────────────────────────────────

/// The sources one project resolves: `HTTP` v3 feeds and folder feeds.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Sources {
    /// `HTTP` v3 source URLs (service index URLs).
    pub http: Vec<String>,
    /// Folder feed directories.
    pub folders: Vec<PathBuf>,
    /// Audit sources (`<auditSources>`).
    pub audit: Vec<String>,
}

/// Resolve the sources from the nearest `NuGet.Config` at or above the
/// project's directory. A missing file yields the default nuget.org source.
pub fn resolve(project: &Path) -> Sources {
    let Some(config) = nearest_config(project) else {
        return Sources {
            http: vec![DEFAULT_SOURCE.to_string()],
            ..Sources::default()
        };
    };
    let text = std::fs::read_to_string(&config).unwrap_or_default();
    parse_sources(&text).unwrap_or_else(|error| {
        warn!(config = %config.display(), %error, "Unreadable NuGet.Config");
        Sources::default()
    })
}

/// The nearest `NuGet.Config` walking up from `start`'s directory.
fn nearest_config(start: &Path) -> Option<PathBuf> {
    crate::paths::directory_of(start).and_then(|dir| ancestors_config(&dir))
}

/// First `NuGet.Config` in `dir` or any ancestor.
fn ancestors_config(dir: &Path) -> Option<PathBuf> {
    let candidate = dir.join("NuGet.Config");
    if candidate.is_file() {
        return Some(candidate);
    }
    dir.parent().and_then(ancestors_config)
}

/// Which source list the parser is inside.
#[derive(PartialEq, Clone, Copy)]
enum Section {
    /// Outside any source list.
    None,
    /// Inside `<packageSources>`.
    Packages,
    /// Inside `<auditSources>`.
    Audit,
}

/// Read `<packageSources>` and `<auditSources>` through the XML parser.
fn parse_sources(text: &str) -> Result<Sources> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut sources = Sources::default();
    let mut section = Section::None;
    loop {
        match reader.read_event()? {
            Event::Start(element) | Event::Empty(element) => {
                let name = element.name();
                let name = name.as_ref();
                if let Some(next) = match name {
                    b"packageSources" => Some(Section::Packages),
                    b"auditSources" => Some(Section::Audit),
                    b"disabled" | b"activePackageSource" => Some(Section::None),
                    _ => None,
                } {
                    section = next;
                } else if section != Section::None {
                    apply_source_entry(name, &element, &mut sources, section)?;
                }
            }
            Event::End(element) => {
                if matches!(element.name().as_ref(), b"packageSources" | b"auditSources") {
                    section = Section::None;
                }
            }
            Event::Eof => return Ok(sources),
            _ => {}
        }
    }
}

/// Apply one `<add>` / `<clear>` entry inside a source list. `<clear>` drops
/// everything collected so far in the section (lower config levels' sources);
/// `<add>` entries after it in the same file still apply, as `NuGet` behaves.
fn apply_source_entry(
    name: &[u8],
    element: &quick_xml::events::BytesStart<'_>,
    sources: &mut Sources,
    section: Section,
) -> Result<()> {
    if name == b"clear" {
        match section {
            Section::Packages => {
                sources.http.clear();
                sources.folders.clear();
            }
            Section::Audit => sources.audit.clear(),
            Section::None => {}
        }
        return Ok(());
    }
    if name != b"add" {
        return Ok(());
    }
    let Some(value) = element.try_get_attribute("value")? else {
        return Ok(());
    };
    let url = String::from_utf8_lossy(&value.value).into_owned();
    match section {
        Section::Packages if url.starts_with("http") => sources.http.push(url),
        Section::Packages => sources.folders.push(PathBuf::from(url)),
        Section::Audit => sources.audit.push(url),
        Section::None => {}
    }
    Ok(())
}

// ── HTTP resources ─────────────────────────────────────────────────────

/// The parsed service index.
#[derive(Debug, Deserialize)]
struct ServiceIndex {
    /// Advertised resources.
    #[serde(default)]
    resources: Vec<ServiceResource>,
}

/// One `{"@id", "@type"}` service entry.
#[derive(Debug, Deserialize)]
struct ServiceResource {
    /// Resource URL.
    #[serde(rename = "@id")]
    id: String,
    /// Resource type, e.g. `VulnerabilityInfo/6.7.0`.
    #[serde(rename = "@type")]
    kind: String,
}

/// The advisory index: a list of pages.
#[derive(Debug, Deserialize)]
struct AdvisoryIndexEntry {
    /// Page data URL.
    #[serde(rename = "@id")]
    id: String,
}

/// One raw advisory from a data page, flattened with its package id.
#[derive(Debug, Deserialize, Clone)]
struct RawAdvisory {
    /// Advised package id (the page dictionary key).
    #[serde(default)]
    id: String,
    /// `NuGet` range string.
    #[serde(default)]
    range: String,
}

/// One advisory inside a data page (the key carries the package id).
#[derive(Debug, Deserialize, Clone)]
struct RawPageAdvisory {
    /// `NuGet` range string.
    #[serde(default, rename = "versions")]
    range: String,
}

/// The flat-container version index.
#[derive(Debug, Deserialize)]
struct FlatVersions {
    /// Published versions, oldest first.
    #[serde(default)]
    versions: Vec<String>,
}

/// TTL cache entry for one source's advisory list.
struct Cached {
    /// When the value expires.
    expires: Instant,
    /// The fetched advisories.
    value: Arc<Vec<RawAdvisory>>,
}

/// TTL cache for fetched advisory lists, keyed by source URL.
static CACHE: LazyLock<Mutex<HashMap<String, Cached>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Fetch `url` and parse it as `T`.
async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    info!("nuget/source: fetching {url}");
    let body = super::cache::http_client()
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok(serde_json::from_str(&body)?)
}

/// The resource URL of kind `kind` from a source's service index; a bare type
/// matches its versioned form (`VulnerabilityInfo/6.7.0`).
async fn service_resource(source: &str, kind: &str) -> Result<Option<String>> {
    let index: ServiceIndex = fetch_json(source).await?;
    Ok(index
        .resources
        .into_iter()
        .find(|resource| resource.kind == kind || resource.kind.split('/').next() == Some(kind))
        .map(|resource| resource.id))
}

/// Every raw advisory of one audit source, cached until [`CACHE_TTL`].
async fn raw_advisories(source: &str) -> Result<Vec<RawAdvisory>> {
    if let Some(cached) = cached_advisories(source) {
        return Ok((*cached).clone());
    }
    let Some(advisory_url) = service_resource(source, "VulnerabilityInfo").await? else {
        return Ok(Vec::new());
    };
    let pages: Vec<AdvisoryIndexEntry> = fetch_json(&advisory_url).await?;
    let mut advisories = Vec::new();
    for page in pages {
        let data: HashMap<String, Vec<RawPageAdvisory>> = fetch_json(&page.id).await?;
        advisories.extend(data.into_iter().flat_map(|(id, entries)| {
            entries.into_iter().map(move |entry| RawAdvisory {
                id: id.clone(),
                range: entry.range,
            })
        }));
    }
    store_advisories(source, &advisories);
    Ok(advisories)
}

/// A still-fresh cached advisory list for `source`.
fn cached_advisories(source: &str) -> Option<Arc<Vec<RawAdvisory>>> {
    let cache = CACHE.lock().ok()?;
    let cached = cache.get(source)?;
    (cached.expires > Instant::now()).then(|| Arc::clone(&cached.value))
}

/// Cache one source's advisory list.
fn store_advisories(source: &str, advisories: &[RawAdvisory]) {
    if let Ok(mut cache) = CACHE.lock() {
        let _ = cache.insert(
            source.to_string(),
            Cached {
                expires: Instant::now() + CACHE_TTL,
                value: Arc::new(advisories.to_vec()),
            },
        );
    }
}

/// The flat-container version list of one `HTTP` source.
async fn flat_container_versions(source: &str, package_id: &str) -> Result<Vec<String>> {
    let Some(flat) = service_resource(source, "PackageBaseAddress").await? else {
        return Ok(Vec::new());
    };
    let index: FlatVersions = fetch_json(&format!(
        "{flat}{}/index.json",
        package_id.to_ascii_lowercase()
    ))
    .await?;
    Ok(index.versions)
}

/// Versions packed as `{id}.{version}.nupkg` in the folder feeds.
fn folder_versions(folders: &[PathBuf], package_id: &str) -> Vec<String> {
    folders
        .iter()
        .filter_map(|folder| read_dir_versions(folder, package_id))
        .flatten()
        .collect()
}

/// `{id}.{version}.nupkg` files in one folder feed; the version is the file
/// name between the id prefix and the `.nupkg` suffix.
fn read_dir_versions(folder: &Path, package_id: &str) -> Option<Vec<String>> {
    let prefix = format!("{}.", package_id.to_ascii_lowercase());
    let mut versions: Vec<String> = std::fs::read_dir(folder)
        .ok()?
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            let version = name
                .to_ascii_lowercase()
                .strip_prefix(&prefix)?
                .strip_suffix(".nupkg")?
                .to_string();
            version.contains('.').then_some(version)
        })
        .collect();
    versions.sort();
    Some(versions)
}

#[cfg(test)]
#[path = "sources_tests.rs"]
mod tests;
