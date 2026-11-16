//! A minimal offline `NuGet` v3 + advisory source for the vulnerability e2e
//! suite. Implements [PKG-VULN-TESTS]: a controlled local advisory resource, so
//! `dotnet list package --vulnerable` (and restore's `NuGetAudit`) resolve
//! advisories from `127.0.0.1` instead of nuget.org.
//!
//! Serves exactly what `NuGet.Protocol` needs — no more:
//!
//! - `/v3/index.json` — service index advertising `RegistrationsBaseUrl`,
//!   `PackageBaseAddress/3.0.0` and `VulnerabilityInfo/6.7.0`.
//! - `/v3-vulnerabilities/index.json` — the paged advisory index.
//! - `/v3-vulnerabilities/data.json` — one page of advisory ranges, keyed by
//!   package id. Both advisory resources are gzip-encoded whatever the client
//!   accepts, exactly as nuget.org serves them (#578). Each advisory carries a URL, a severity number
//!   (0 = low … 3 = critical) and an affected range string such as
//!   "[1.0.0, 1.2.0]".
//! - `/v3-flatcontainer/{id}/index.json` — the published version list.
//! - `/v3-registrations/{id}/index.json` — a registration page (defensive:
//!   `NuGet` may consult metadata; a page without `lower`/`upper` crashes
//!   `PackageMetadataResourceV3`).

#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

/// One package the fixture feed advertises.
#[derive(Clone)]
pub struct FixturePackage {
    /// Package id, exactly as packed into the folder feed.
    pub id: String,
    /// Every published version, oldest first.
    pub versions: Vec<String>,
}

/// One advisory the fixture advisory source reports.
#[derive(Clone)]
pub struct FixtureAdvisory {
    /// Advised package id.
    pub package: String,
    /// `PackageVulnerabilitySeverity` number: 0 low, 1 moderate, 2 high, 3 critical.
    pub severity: u8,
    /// Advisory page URL; its last segment is the GHSA id the host reports.
    pub url: String,
    /// Affected range string, e.g. "[1.0.0, 1.2.0]".
    pub range: String,
}

/// The packages and advisories one server instance serves.
#[derive(Clone)]
pub struct Fixture {
    /// Every advertised package with its published versions.
    pub packages: Vec<FixturePackage>,
    /// Every advisory in the vulnerability data page.
    pub advisories: Vec<FixtureAdvisory>,
}

/// A running advisory source; stops when dropped.
pub struct AdvisoryServer {
    /// The bound port; `127.0.0.1:{port}/v3/index.json` is the source URL.
    pub port: u16,
    stopping: Arc<AtomicBool>,
}

impl AdvisoryServer {
    /// Serve the fixture until the value drops.
    pub fn start(fixture: Fixture) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stopping = Arc::new(AtomicBool::new(false));
        let state = Arc::new((listener, fixture));
        let run = {
            let (state, stopping) = (Arc::clone(&state), Arc::clone(&stopping));
            move || {
                while !stopping.load(Ordering::Relaxed) {
                    let Ok((stream, _)) = state.0.accept() else {
                        return;
                    };
                    let fixture = state.1.clone();
                    let port = state.0.local_addr().map_or(0u16, |addr| addr.port());
                    let _ = std::thread::spawn(move || answer(stream, &fixture, port));
                }
            }
        };
        let _ = std::thread::spawn(run);
        Self { port, stopping }
    }

    /// The value to put in a `<auditSources><add value="…"/>` entry.
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v3/index.json", self.port)
    }
}

impl Drop for AdvisoryServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        // Wake the accept loop so it observes the stop flag.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

/// Answer one HTTP/1.1 GET with the routed JSON body, then close.
fn answer(mut stream: TcpStream, fixture: &Fixture, port: u16) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    // Read the request head only (GET carries no body).
    while !head.ends_with(b"\r\n\r\n")
        && stream.read(&mut byte).is_ok_and(|read| read == 1)
        && head.len() < 16_384
    {
        head.push(byte[0]);
    }
    let request = String::from_utf8_lossy(&head);
    let Some(path) = request.split_whitespace().nth(1) else {
        return;
    };
    let path = path.split('?').next().unwrap_or(path).to_string();
    let base = request
        .lines()
        .find_map(|line| line.strip_prefix("Host: "))
        .map_or_else(
            || format!("http://127.0.0.1:{port}"),
            |host| format!("http://{host}"),
        );
    let Some(body) = route(&path, &base, fixture) else {
        let _ = write_response(&mut stream, 404, b"{\"error\":404}", None);
        return;
    };
    let _ = if path.starts_with("/v3-vulnerabilities/") {
        write_response(&mut stream, 200, &gzip(&body), Some("gzip"))
    } else {
        write_response(&mut stream, 200, body.as_bytes(), None)
    };
}

/// `body` gzip-compressed, as nuget.org stores its advisory blobs.
fn gzip(body: &str) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(body.as_bytes()).unwrap();
    encoder.finish().unwrap()
}

/// The JSON body for one request path.
fn route(path: &str, base: &str, fixture: &Fixture) -> Option<String> {
    match path {
        "/v3/index.json" => Some(service_index(base)),
        "/v3-vulnerabilities/index.json" => Some(
            json!([{ "@name": "fixture", "@id": format!("{base}/v3-vulnerabilities/data.json"),
                     "@updated": "2025-01-01T00:00:00.000Z" }])
            .to_string(),
        ),
        "/v3-vulnerabilities/data.json" => Some(vulnerability_page(fixture).to_string()),
        _ => package_route(path, base, fixture),
    }
}

/// The flat-container version index and registration page for one package.
fn package_route(path: &str, base: &str, fixture: &Fixture) -> Option<String> {
    let id = path
        .strip_prefix("/v3-flatcontainer/")
        .or_else(|| path.strip_prefix("/v3-registrations/"))?
        .strip_suffix("/index.json")?;
    let package = fixture
        .packages
        .iter()
        .find(|package| package.id.to_ascii_lowercase() == id)?;
    Some(
        if path.starts_with("/v3-flatcontainer/") {
            json!({ "versions": package.versions })
        } else {
            registration(base, &package.id, &package.versions)
        }
        .to_string(),
    )
}

/// The service index advertising every resource the fixture serves.
fn service_index(base: &str) -> String {
    json!({
        "version": "3.0.0",
        "resources": [
            { "@id": format!("{base}/v3-registrations/"), "@type": "RegistrationsBaseUrl" },
            { "@id": format!("{base}/v3-flatcontainer/"), "@type": "PackageBaseAddress/3.0.0" },
            { "@id": format!("{base}/v3-vulnerabilities/index.json"), "@type": "VulnerabilityInfo/6.7.0" },
        ]
    })
    .to_string()
}

/// One page of advisory ranges keyed by package id, exactly as
/// `VulnerabilityInfoResourceV3` expects: a package with several advisories or
/// ranges lists one entry per range, as nuget.org does.
fn vulnerability_page(fixture: &Fixture) -> Value {
    let mut page = serde_json::Map::new();
    for advisory in &fixture.advisories {
        let entries = page
            .entry(advisory.package.clone())
            .or_insert_with(|| json!([]));
        if let Value::Array(entries) = entries {
            entries.push(json!({
                "url": advisory.url,
                "severity": advisory.severity,
                "versions": advisory.range,
            }));
        }
    }
    Value::Object(page)
}

/// One inline registration page; `lower`/`upper` are required by
/// `PackageMetadataResourceV3`.
fn registration(base: &str, id: &str, versions: &[String]) -> Value {
    let lower = id.to_ascii_lowercase();
    let leaves: Vec<Value> = versions
        .iter()
        .map(|version| {
            json!({
                "@id": format!("{base}/v3-registrations/{lower}/{version}.json"),
                "@type": "Package",
                "catalogEntry": {
                    "@id": format!("{base}/v3-registrations/{lower}/{version}.json"),
                    "id": id,
                    "version": version,
                    "listed": true,
                },
            })
        })
        .collect();
    json!({
        "count": 1,
        "items": [{
            "@id": format!("{base}/v3-registrations/{lower}/index.json#page"),
            "@type": "catalog:CatalogPage",
            "count": leaves.len(),
            "lower": versions.first(),
            "upper": versions.last(),
            "items": leaves,
        }]
    })
}

/// Write a minimal HTTP/1.1 response and half-close.
fn write_response(
    stream: &mut TcpStream,
    status: u16,
    body: &[u8],
    encoding: Option<&str>,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n",
        if status == 200 { "OK" } else { "Not Found" },
        encoding.map_or_else(String::new, |encoding| format!("Content-Encoding: {encoding}\r\n")),
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
