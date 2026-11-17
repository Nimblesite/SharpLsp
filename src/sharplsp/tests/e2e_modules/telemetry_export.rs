//! Request spans and metrics reach an OTLP collector when the environment
//! names one, and nowhere otherwise. [SHARPLSP-TECHNOLOGY-TELEMETRY]

use super::*;
use std::ffi::OsStr;
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

/// Every export a collector received: the path posted to and the body.
type Received = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

/// A stub OTLP/HTTP collector on a free local port.
struct Collector {
    port: u16,
    received: Received,
}

impl Collector {
    /// Accept exports until the test process ends.
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = Received::default();
        let sink = Arc::clone(&received);
        drop(std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                accept(stream, &sink);
            }
        }));
        Self { port, received }
    }

    /// Every body posted to `path`, joined.
    fn posted(&self, path: &str) -> Vec<u8> {
        let received = self.received.lock().unwrap();
        received
            .iter()
            .filter(|(to, _)| to == path)
            .flat_map(|(_, body)| body.clone())
            .collect()
    }

    /// How many exports arrived.
    fn exports(&self) -> usize {
        self.received.lock().unwrap().len()
    }
}

/// Read one `POST` with its body and acknowledge it.
fn accept(mut stream: TcpStream, sink: &Received) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).is_ok_and(|read| read == 1) {
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let path = head
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_owned();
    let length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if stream.read_exact(&mut body).is_ok() {
        sink.lock().unwrap().push((path, body));
    }
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
}

/// Whether `bytes` holds `text`: OTLP protobuf carries strings verbatim.
fn holds(bytes: &[u8], text: &str) -> bool {
    bytes
        .windows(text.len())
        .any(|window| window == text.as_bytes())
}

/// One short session: open a document and ask syntax requests about it.
fn session(environment: &[(&str, &OsStr)]) {
    let mut client = LspClient::spawn_in_with_env(Stdio::null(), None, environment);
    let _ = client.initialize();
    let uri = "file:///telemetry/Program.cs";
    client.open_document(uri, "namespace Telemetry;\n\npublic class SecretMarker123\n{\n    public int Value { get; set; }\n}\n");
    for _ in 0..3 {
        let symbols = client.request(
            "textDocument/documentSymbol",
            json!({"textDocument": {"uri": uri}}),
        );
        assert!(symbols.get("error").is_none(), "{symbols}");
    }
    let folds = client.request(
        "textDocument/foldingRange",
        json!({"textDocument": {"uri": uri}}),
    );
    assert!(folds.get("error").is_none(), "{folds}");
    // A semantic request: the class name on line 2 is asked of the compiler.
    let hovered = hover(&mut client, uri, 2, 15);
    assert_hover_ok(&hovered);
    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn spans_and_metrics_reach_an_otlp_collector_only_when_one_is_named() {
    require_dotnet();
    let collector = Collector::start();
    let endpoint = format!("http://127.0.0.1:{}", collector.port);

    // 1. With an endpoint named, the session's requests arrive as spans; the
    //    server flushes as it exits.
    session(&[
        ("OTEL_EXPORTER_OTLP_ENDPOINT", OsStr::new(&endpoint)),
        ("OTEL_BSP_SCHEDULE_DELAY", OsStr::new("200")),
        ("OTEL_METRIC_EXPORT_INTERVAL", OsStr::new("500")),
    ]);
    let traces = collector.posted("/v1/traces");
    assert!(!traces.is_empty(), "spans were exported");
    for expected in [
        "sharplsp",
        "lsp.request",
        "rpc.method",
        "textDocument/documentSymbol",
        "textDocument/foldingRange",
    ] {
        assert!(holds(&traces, expected), "spans name {expected}");
    }
    // The compiler exchange of the hover is a span of its own, by compiler.
    for expected in ["sidecar.request", "C# (Roslyn)", "textDocument/hover"] {
        assert!(holds(&traces, expected), "spans name {expected}");
    }

    // 2. So do the request metrics, by method and outcome.
    let metrics = collector.posted("/v1/metrics");
    assert!(!metrics.is_empty(), "metrics were exported");
    for expected in [
        "sharplsp.request.duration",
        "sharplsp.requests",
        "rpc.method",
        "outcome",
        "textDocument/documentSymbol",
    ] {
        assert!(holds(&metrics, expected), "metrics name {expected}");
    }

    // 3. Neither carries document text.
    for signal in [&traces, &metrics] {
        assert!(
            !holds(signal, "SecretMarker123"),
            "no source text is exported"
        );
        assert!(!holds(signal, "namespace Telemetry"));
    }

    // 4. With no endpoint named, the same session exports nothing.
    let before = collector.exports();
    assert!(before >= 2, "one export per signal at least");
    session(&[]);
    assert_eq!(
        collector.exports(),
        before,
        "nothing is exported by default"
    );
}
