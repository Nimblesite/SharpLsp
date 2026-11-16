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
use crate::paths::SourceLocation;

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

/// Every advisory for one package across the project's audit sources.
pub async fn advisories(project: &str, package_id: &str) -> Vec<AdvisoryRange> {
    let mut found = Vec::new();
    for source in resolve(Path::new(project)).audit_sources() {
        match raw_advisories(&source).await {
            Ok(raw) => found.extend(raw.iter().filter_map(|advisory| {
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
    for source in &sources.http {
        match flat_container_versions(source, package_id).await {
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

impl Sources {
    /// The sources audited for advisories: `<auditSources>`, falling back to
    /// the `HTTP` package sources — `NuGetAudit`'s own rule.
    pub fn audit_sources(self) -> Vec<String> {
        if self.audit.is_empty() {
            self.http
        } else {
            self.audit
        }
    }
}

/// Resolve the sources `NuGet` merges for `project` across its whole config
/// chain ([`crate::paths::nuget_config_chain`]).
pub fn resolve(project: &Path) -> Sources {
    resolve_chain(&crate::paths::nuget_config_chain(project))
}

/// Merge `chain`, lowest priority first: nearer files add to and override
/// farther ones by key, `<clear />` drops everything inherited, and
/// `<disabledPackageSources>` hides a source by key. With no
/// `<packageSources>` anywhere, `NuGet` restores from nuget.org.
fn resolve_chain(chain: &[PathBuf]) -> Sources {
    let mut merged = Merged::default();
    for config in chain {
        let text = std::fs::read_to_string(config).unwrap_or_default();
        let directory = crate::paths::directory_of(config).unwrap_or_default();
        if let Err(error) = merge_config(&text, &directory, &mut merged) {
            warn!(config = %config.display(), %error, "Unreadable NuGet.Config");
        }
    }
    merged.into_sources()
}

/// One keyed source entry.
type Entry = (String, String);

/// The merge state across a config chain.
#[derive(Default)]
struct Merged {
    /// Package sources by key; `None` until some config declares the section.
    packages: Option<Vec<(String, SourceLocation)>>,
    /// Audit sources by key.
    audit: Vec<Entry>,
    /// Keys of disabled package sources.
    disabled: Vec<String>,
}

impl Merged {
    /// The enabled sources, nuget.org when none was ever configured.
    fn into_sources(self) -> Sources {
        let packages = self.packages.unwrap_or_else(|| {
            vec![(
                "nuget.org".to_string(),
                SourceLocation::Http(DEFAULT_SOURCE.to_string()),
            )]
        });
        let mut sources = Sources {
            audit: self.audit.into_iter().map(|(_, url)| url).collect(),
            ..Sources::default()
        };
        for (key, location) in packages {
            if self
                .disabled
                .iter()
                .any(|off| off.eq_ignore_ascii_case(&key))
            {
                continue;
            }
            match location {
                SourceLocation::Http(url) => sources.http.push(url),
                SourceLocation::Folder(folder) => sources.folders.push(folder),
            }
        }
        sources
    }
}

/// Insert or replace `value` under `key`: a nearer config's entry wins.
fn upsert<T>(entries: &mut Vec<(String, T)>, key: &str, value: T) {
    entries.retain(|(existing, _)| !existing.eq_ignore_ascii_case(key));
    entries.push((key.to_string(), value));
}

/// Which keyed list the parser is inside.
#[derive(PartialEq, Clone, Copy)]
enum Section {
    /// Outside any list this resolution reads.
    None,
    /// Inside `<packageSources>`.
    Packages,
    /// Inside `<auditSources>`.
    Audit,
    /// Inside `<disabledPackageSources>`.
    Disabled,
}

impl Section {
    /// The section an element name opens, if it is one.
    fn named(name: &[u8]) -> Option<Self> {
        match name {
            b"packageSources" => Some(Self::Packages),
            b"auditSources" => Some(Self::Audit),
            b"disabledPackageSources" => Some(Self::Disabled),
            _ => None,
        }
    }
}

/// Merge one config's `<packageSources>`, `<auditSources>` and
/// `<disabledPackageSources>` into `merged`, through the XML parser.
fn merge_config(text: &str, directory: &Path, merged: &mut Merged) -> Result<()> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut section = Section::None;
    loop {
        match reader.read_event()? {
            Event::Start(element) => {
                let name = element.name();
                match Section::named(name.as_ref()) {
                    Some(opened) => section = opened,
                    None => apply_entry(&element, section, directory, merged)?,
                }
            }
            Event::Empty(element) => {
                let name = element.name();
                match Section::named(name.as_ref()) {
                    Some(Section::Packages) => {
                        let _ = merged.packages.get_or_insert_with(Vec::new);
                    }
                    Some(_) => {}
                    None => apply_entry(&element, section, directory, merged)?,
                }
            }
            Event::End(element) if Section::named(element.name().as_ref()).is_some() => {
                section = Section::None;
            }
            Event::Eof => return Ok(()),
            _ => {}
        }
    }
}

/// Apply one `<add>` / `<clear>` entry inside a keyed list. `<clear>` drops
/// everything inherited from farther configs; `<add>` entries after it in the
/// same file still apply, as `NuGet` behaves.
fn apply_entry(
    element: &quick_xml::events::BytesStart<'_>,
    section: Section,
    directory: &Path,
    merged: &mut Merged,
) -> Result<()> {
    match (element.name().as_ref(), section) {
        (_, Section::None) => {}
        (b"clear", Section::Packages) => merged.packages = Some(Vec::new()),
        (b"clear", Section::Audit) => merged.audit.clear(),
        (b"clear", Section::Disabled) => merged.disabled.clear(),
        (b"add", _) => {
            let (Some(key), Some(value)) =
                (attribute(element, "key")?, attribute(element, "value")?)
            else {
                return Ok(());
            };
            match section {
                Section::Packages => upsert(
                    merged.packages.get_or_insert_with(Vec::new),
                    &key,
                    crate::paths::source_location(directory, &value),
                ),
                Section::Audit => upsert(&mut merged.audit, &key, value),
                Section::Disabled => {
                    merged
                        .disabled
                        .retain(|off| !off.eq_ignore_ascii_case(&key));
                    if value.eq_ignore_ascii_case("true") {
                        merged.disabled.push(key);
                    }
                }
                Section::None => {}
            }
        }
        _ => {}
    }
    Ok(())
}

/// One attribute's unescaped value.
fn attribute(element: &quick_xml::events::BytesStart<'_>, name: &str) -> Result<Option<String>> {
    Ok(element
        .try_get_attribute(name)?
        .map(|attribute| String::from_utf8_lossy(&attribute.value).into_owned()))
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

/// Fetched source data with its expiry, keyed by the URL it came from.
type Ttl<V> = Mutex<HashMap<String, (Instant, Arc<V>)>>;

/// Parsed advisory lists, keyed by audit source.
static ADVISORIES: LazyLock<Ttl<Vec<RawAdvisory>>> = LazyLock::new(Ttl::default);

/// Service indexes and flat-container version lists, keyed by URL: a code
/// action on every cursor move must not refetch them. [PKG-VULN-FIX]
static DOCUMENTS: LazyLock<Ttl<serde_json::Value>> = LazyLock::new(Ttl::default);

/// `key`'s value from `cache` while fresh, else `fetch`ed and cached until
/// [`CACHE_TTL`]. A failed fetch caches nothing; caching drops every expired
/// entry, since most URLs are never fetched again to replace their own.
async fn memo<V, F>(cache: &Ttl<V>, key: &str, fetch: F) -> Result<Arc<V>>
where
    F: std::future::Future<Output = Result<V>>,
{
    let fresh = cache.lock().ok().and_then(|entries| {
        entries
            .get(key)
            .filter(|(expires, _)| *expires > Instant::now())
            .map(|(_, value)| Arc::clone(value))
    });
    if let Some(value) = fresh {
        return Ok(value);
    }
    let value = Arc::new(fetch.await?);
    if let Ok(mut entries) = cache.lock() {
        let now = Instant::now();
        entries.retain(|_, (expires, _)| *expires > now);
        let _ = entries.insert(
            key.to_string(),
            (Instant::now() + CACHE_TTL, Arc::clone(&value)),
        );
    }
    Ok(value)
}

/// Fetch `url`'s body.
async fn fetch_text(url: &str) -> Result<String> {
    info!("nuget/source: fetching {url}");
    Ok(super::cache::http_client()
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?)
}

/// Fetch `url` and parse it as `T`.
async fn fetch_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    Ok(serde_json::from_str(&fetch_text(url).await?)?)
}

/// The `.nuspec` of one package version from a source's flat container, cached
/// until [`CACHE_TTL`]; `None` when the source has no flat container.
pub(super) async fn nuspec(
    source: &str,
    package_id: &str,
    version: &str,
) -> Result<Option<String>> {
    let Some(flat) = service_resource(source, "PackageBaseAddress").await? else {
        return Ok(None);
    };
    let (id, version) = (
        package_id.to_ascii_lowercase(),
        version.to_ascii_lowercase(),
    );
    let url = format!("{flat}{id}/{version}/{id}.nuspec");
    let fetch = async { fetch_text(&url).await.map(serde_json::Value::String) };
    let document = memo(&DOCUMENTS, &url, fetch).await?;
    Ok(document.as_str().map(str::to_owned))
}

/// `url`'s JSON document, cached until [`CACHE_TTL`], parsed as `T`.
async fn cached_json<T: serde::de::DeserializeOwned>(url: &str) -> Result<T> {
    let document = memo(&DOCUMENTS, url, fetch_json::<serde_json::Value>(url)).await?;
    Ok(T::deserialize(document.as_ref())?)
}

/// The resource URL of kind `kind` from a source's service index; a bare type
/// matches its versioned form (`VulnerabilityInfo/6.7.0`).
async fn service_resource(source: &str, kind: &str) -> Result<Option<String>> {
    let index: ServiceIndex = cached_json(source).await?;
    Ok(index
        .resources
        .into_iter()
        .find(|resource| resource.kind == kind || resource.kind.split('/').next() == Some(kind))
        .map(|resource| resource.id))
}

/// Every raw advisory of one audit source, cached until [`CACHE_TTL`].
async fn raw_advisories(source: &str) -> Result<Arc<Vec<RawAdvisory>>> {
    memo(&ADVISORIES, source, fetch_advisories(source)).await
}

/// Fetch every advisory page one audit source advertises.
async fn fetch_advisories(source: &str) -> Result<Vec<RawAdvisory>> {
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
    Ok(advisories)
}

/// The flat-container version list of one `HTTP` source.
async fn flat_container_versions(source: &str, package_id: &str) -> Result<Vec<String>> {
    let Some(flat) = service_resource(source, "PackageBaseAddress").await? else {
        return Ok(Vec::new());
    };
    let index: FlatVersions = cached_json(&format!(
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
