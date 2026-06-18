use super::*;

// ── References & Document Highlight helpers ──────────────────────

/// Helper: send a references request and return the response.
fn references(
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
fn document_highlight(client: &mut LspClient, uri: &str, line: u32, character: u32) -> Value {
    client.request(
        "textDocument/documentHighlight",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character }
        }),
    )
}

/// Poll references until the sidecar returns a non-null, non-empty result.
fn poll_references_until_ready(
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

// ── References & Document Highlight capability tests ─────────────

#[test]
fn test_references_capabilities_advertised() {
    let mut client = LspClient::start();
    let resp = client.initialize();
    let caps = &resp["result"]["capabilities"];

    assert_eq!(caps["referencesProvider"], true, "references");
    assert_eq!(caps["documentHighlightProvider"], true, "documentHighlight");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_references_on_comment_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "// This is a comment\nnamespace Test { public class Foo { } }\n";
    client.open_document(TEST_URI, code);

    let resp = references(&mut client, TEST_URI, 0, 5, true);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "references on comment must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_references_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = references(&mut client, TEST_URI, 5, 18, true);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "references without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_document_highlight_on_comment_returns_null() {
    let code = "// This is a comment\nnamespace Test { public class Foo { } }\n";
    assert_nav_null_no_sidecar(
        code,
        document_highlight,
        0,
        5,
        "document highlight on comment must be null",
    );
}

#[test]
fn test_document_highlight_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = document_highlight(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "document highlight without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Full-stack references E2E tests (real sidecar + Roslyn) ──────

#[test]
fn test_full_stack_references_on_method_returns_call_sites() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar to be ready using Speak on line 5 (interface declaration).
    //     string Speak();
    //     0         1
    //     01234567890123
    let _ = poll_references_until_ready(&mut client, &file_uri, 5, 11, Duration::from_secs(90));

    // Find all references to "Speak" from the interface (line 5, col 11).
    let resp = references(&mut client, &file_uri, 5, 11, true);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        result.is_array(),
        "references must return Location[]: {result}"
    );
    let locations = result.as_array().unwrap();
    // Speak appears at: line 5 (interface), 11 (virtual), 17 (Dog override),
    // 23 (Cat override), 34 (call site dog.Speak()).
    assert!(
        locations.len() >= 3,
        "Speak must have >= 3 references, got {}",
        locations.len()
    );
    for loc in locations {
        assert_location_shape(loc);
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_references_include_declaration_true() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_references_until_ready(&mut client, &file_uri, 5, 11, Duration::from_secs(90));

    // "Dog" class on line 14, col 13.
    //     public class Dog : AnimalBase
    //     0         1
    //     0123456789012345
    let resp_with = references(&mut client, &file_uri, 14, 13, true);
    assert_nav_ok(&resp_with);
    let with_decl = resp_with["result"].as_array().unwrap();

    let resp_without = references(&mut client, &file_uri, 14, 13, false);
    assert_nav_ok(&resp_without);
    let without_decl = resp_without["result"].as_array().unwrap();

    assert!(
        with_decl.len() > without_decl.len(),
        "includeDeclaration=true ({}) must return more results than false ({})",
        with_decl.len(),
        without_decl.len()
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_references_on_class_returns_type_usages() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_references_until_ready(&mut client, &file_uri, 5, 11, Duration::from_secs(90));

    // "Dog" on line 14, col 13 — used at line 14 (decl), 28 (field type),
    // 28 (new Dog()), 33 (var dog = MyDog is typed Dog).
    let resp = references(&mut client, &file_uri, 14, 13, true);
    assert_nav_ok(&resp);
    let locations = resp["result"].as_array().unwrap();
    assert!(
        locations.len() >= 2,
        "Dog must have >= 2 references (decl + usages), got {}",
        locations.len()
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_references_response_structure() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_references_until_ready(&mut client, &file_uri, 5, 11, Duration::from_secs(90));

    // Verify LSP Location[] structure.
    let resp = references(&mut client, &file_uri, 5, 11, true);
    assert_nav_ok(&resp);
    let locations = resp["result"].as_array().unwrap();
    assert!(!locations.is_empty(), "must have at least one reference");

    for loc in locations {
        assert!(loc.get("uri").is_some(), "location must have uri: {loc}");
        let range = &loc["range"];
        assert!(range.get("start").is_some(), "must have range.start: {loc}");
        assert!(range.get("end").is_some(), "must have range.end: {loc}");
        let start = &range["start"];
        assert!(start.get("line").is_some(), "start must have line: {loc}");
        assert!(
            start.get("character").is_some(),
            "start must have character: {loc}"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Full-stack document highlight E2E tests ──────────────────────

#[test]
fn test_full_stack_document_highlight_read_write() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar readiness.
    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));

    // "message" on line 34 — written on line 34, read on line 35.
    //         var message = dog.Speak();
    //         0         1
    //         0123456789012345
    let resp = document_highlight(&mut client, &file_uri, 34, 12);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        result.is_array(),
        "document highlight must return array: {result}"
    );
    let highlights = result.as_array().unwrap();
    assert!(
        highlights.len() >= 2,
        "message must have >= 2 highlights (write + read), got {}",
        highlights.len()
    );

    // Verify highlight structure: each must have range and kind.
    for hl in highlights {
        let range = &hl["range"];
        assert!(
            range.get("start").is_some(),
            "highlight must have range.start"
        );
        assert!(range.get("end").is_some(), "highlight must have range.end");
        assert!(hl.get("kind").is_some(), "highlight must have kind: {hl}");
    }

    // Verify at least one Write (kind=3) and one Read (kind=2).
    let kinds: Vec<u64> = highlights
        .iter()
        .filter_map(|hl| hl["kind"].as_u64())
        .collect();
    assert!(
        kinds.contains(&3),
        "must have a Write highlight (kind=3): {kinds:?}"
    );
    assert!(
        kinds.contains(&2),
        "must have a Read highlight (kind=2): {kinds:?}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
