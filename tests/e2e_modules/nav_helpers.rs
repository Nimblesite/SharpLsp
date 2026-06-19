//! Navigation helper functions: hover, definition, references, assert helpers, and poll helpers.

use super::*;

// ── Nav request helpers ───────────────────────────────────────────

/// Helper: send a hover request and return the response.
pub fn hover(client: &mut LspClient, uri: &str, line: u32, character: u32) -> Value {
    client.request(
        "textDocument/hover",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )
}

/// Helper: assert a hover response has no error and is valid JSON-RPC.
pub fn assert_hover_ok(resp: &Value) {
    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(resp.get("error").is_none(), "hover must not return error");
}

/// Helper: send a definition request and return the response.
pub fn definition(client: &mut LspClient, uri: &str, line: u32, character: u32) -> Value {
    client.request(
        "textDocument/definition",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )
}

/// Helper: send a type definition request and return the response.
pub fn type_definition(client: &mut LspClient, uri: &str, line: u32, character: u32) -> Value {
    client.request(
        "textDocument/typeDefinition",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )
}

/// Helper: send a declaration request and return the response.
pub fn declaration(client: &mut LspClient, uri: &str, line: u32, character: u32) -> Value {
    client.request(
        "textDocument/declaration",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )
}

/// Helper: send an implementation request and return the response.
pub fn implementation(client: &mut LspClient, uri: &str, line: u32, character: u32) -> Value {
    client.request(
        "textDocument/implementation",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )
}

/// Assert a definition-family response is valid JSON-RPC with no error.
pub fn assert_nav_ok(resp: &Value) {
    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "navigation must not return error: {resp}"
    );
}

/// Start a no-sidecar server, open `code` at [`TEST_URI`], run the `nav` request,
/// and assert the navigation result is JSON `null` — the "no sidecar connected /
/// no resolvable symbol" outcome shared by the no-sidecar navigation tests.
pub fn assert_nav_null_no_sidecar(
    code: &str,
    nav: impl FnOnce(&mut LspClient, &str, u32, u32) -> Value,
    line: u32,
    character: u32,
    msg: &str,
) {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, code);
    let resp = nav(&mut client, TEST_URI, line, character);
    assert_nav_ok(&resp);
    assert!(resp["result"].is_null(), "{msg}");
    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Start a no-sidecar server, initialize it, and open `code` at [`TEST_URI`], returning
/// the ready client. Shared setup for the no-sidecar feature tests that issue several
/// requests in one session (and therefore can't use [`assert_no_sidecar_request`]).
pub fn open_no_sidecar(code: &str) -> LspClient {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, code);
    client
}

/// Build the `{ "item": { … } }` params shared by the call- and type-hierarchy
/// `incomingCalls`/`outgoingCalls`/`supertypes`/`subtypes` requests. `range` and
/// `selection` are `(start_line, start_character, end_line, end_character)` tuples.
pub fn hierarchy_item_params(
    name: &str,
    kind: i64,
    range: (u32, u32, u32, u32),
    selection: (u32, u32, u32, u32),
) -> Value {
    json!({
        "item": {
            "name": name,
            "kind": kind,
            "uri": TEST_URI,
            "range": {
                "start": { "line": range.0, "character": range.1 },
                "end": { "line": range.2, "character": range.3 }
            },
            "selectionRange": {
                "start": { "line": selection.0, "character": selection.1 },
                "end": { "line": selection.2, "character": selection.3 }
            }
        }
    })
}

/// The result a feature request is allowed to produce when no sidecar is connected.
pub enum NoSidecarResult {
    /// The result must be JSON `null`.
    Null,
    /// The result must be JSON `null` or an empty array.
    NullOrEmptyArray,
}

/// Start a no-sidecar server, open `code` at [`TEST_URI`], send a single `method`
/// request with `params`, and assert the response is well-formed JSON-RPC with no error
/// and a result matching `expect`. Collapses the identical no-sidecar feature-request
/// scaffold shared across the LSP feature tests.
pub fn assert_no_sidecar_request(
    code: &str,
    method: &str,
    params: Value,
    expect: NoSidecarResult,
    label: &str,
) {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, code);

    let resp = client.request(method, params);
    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "{label} without sidecar must not error: {resp}"
    );

    let result = &resp["result"];
    match expect {
        NoSidecarResult::Null => assert!(
            result.is_null(),
            "{label} without sidecar must return null, got: {result}"
        ),
        NoSidecarResult::NullOrEmptyArray => assert!(
            result.is_null() || result.as_array().is_some_and(Vec::is_empty),
            "{label} without sidecar must return null or empty array, got: {result}"
        ),
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Start a server, initialize, and assert that `capabilities[key]` is advertised
/// (non-null). Collapses the identical capability-advertisement scaffold shared across
/// the LSP feature tests.
pub fn assert_capability_advertised(key: &str, label: &str) {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let capability = &resp["result"]["capabilities"][key];
    assert!(
        !capability.is_null(),
        "{label} must be advertised in capabilities, got: {capability}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Assert a Location result has uri and range fields.
pub fn assert_location_shape(loc: &Value) {
    assert!(loc.get("uri").is_some(), "location must have uri: {loc}");
    let range = &loc["range"];
    assert!(
        range.get("start").is_some(),
        "location must have range.start: {loc}"
    );
    assert!(
        range.get("end").is_some(),
        "location must have range.end: {loc}"
    );
}

/// Assert a Location points to a specific line.
pub fn assert_location_line(loc: &Value, expected_line: u64, msg: &str) {
    assert_location_shape(loc);
    let actual = loc["range"]["start"]["line"].as_u64().unwrap();
    assert_eq!(actual, expected_line, "{msg}");
}

/// Extract the first location from a definition result.
/// Definition returns Location[] (array) for partial class support.
pub fn first_location(result: &Value) -> Value {
    if result.is_array() {
        result
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        result.clone()
    }
}

// ── Poll helpers ──────────────────────────────────────────────────

/// Wait for the sidecar to finish starting and loading the workspace.
pub fn poll_hover_until_ready(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
    timeout: Duration,
) -> Value {
    std::thread::sleep(Duration::from_secs(5));

    let deadline = std::time::Instant::now() + timeout;
    loop {
        let resp = hover(client, uri, line, character);
        assert_hover_ok(&resp);

        if !resp["result"].is_null() {
            return resp["result"].clone();
        }

        assert!(
            std::time::Instant::now() < deadline,
            "hover did not return content within {}s — sidecar failed to start or load workspace",
            timeout.as_secs(),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Poll definition until the sidecar returns a non-null result.
pub fn poll_definition_until_ready(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
    timeout: Duration,
) -> Value {
    std::thread::sleep(Duration::from_secs(5));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let resp = definition(client, uri, line, character);
        assert_nav_ok(&resp);
        let result = &resp["result"];
        if !result.is_null() {
            return first_location(result);
        }
        assert!(
            std::time::Instant::now() < deadline,
            "definition did not resolve within {}s — sidecar not ready",
            timeout.as_secs(),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Poll implementation until the sidecar returns a non-null array result.
pub fn poll_implementation_until_ready(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
    timeout: Duration,
) -> Value {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let resp = implementation(client, uri, line, character);
        assert_nav_ok(&resp);
        let result = &resp["result"];
        if result.is_array() {
            return resp;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "implementation did not resolve within {}s",
            timeout.as_secs(),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Poll references until the sidecar returns a non-null, non-empty result.
pub fn poll_references_until_ready(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
    timeout: Duration,
) -> Value {
    std::thread::sleep(Duration::from_secs(5));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let resp = references(client, uri, line, character, true);
        assert_nav_ok(&resp);
        let result = &resp["result"];
        if result.is_array() && !result.as_array().unwrap().is_empty() {
            return resp;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "references did not resolve within {}s — sidecar not ready",
            timeout.as_secs(),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

// ── References and highlight helpers ─────────────────────────────

/// Helper: send a references request and return the response.
pub fn references(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
    include_declaration: bool,
) -> Value {
    client.request(
        "textDocument/references",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
            "context": { "includeDeclaration": include_declaration }
        }),
    )
}

/// Helper: send a document highlight request and return the response.
pub fn document_highlight(client: &mut LspClient, uri: &str, line: u32, character: u32) -> Value {
    client.request(
        "textDocument/documentHighlight",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )
}

// ── Sort members helpers ──────────────────────────────────────────

/// Create a sort members test file in a temp dir.
pub fn create_sort_members_file(content: &str) -> (tempfile::TempDir, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let real_path = std::fs::canonicalize(tmp.path()).unwrap();
    let file_path = real_path.join("SortTest.cs");
    std::fs::write(&file_path, content).unwrap();
    let file_uri = format!("file://{}", file_path.display());
    (tmp, file_path.to_string_lossy().to_string(), file_uri)
}

/// Default sort config for sort members tests.
pub fn default_sort_config() -> Value {
    json!({
        "hierarchy": ["accessibility", "category", "alphabetical"],
        "accessibilityOrder": [
            "public", "protected internal", "internal",
            "protected", "private protected", "private"
        ],
        "categoryOrder": [
            "constant", "field", "constructor", "finalizer", "delegate",
            "event", "enum", "interface", "property", "indexer",
            "operator", "method", "struct", "class", "record"
        ]
    })
}
