//! [REFACTOR-NEVER-SILENT] — `codeAction/resolve` must never answer `null`.
//!
//! A sidecar failure on the resolve becomes an LSP error response that carries
//! the sidecar's reason, and a resolve with no sidecar running for the file's
//! language says which service is not running. Both are asserted against the
//! real server, the first against the real C# sidecar.

use super::*;

/// A resolve whose action id the sidecar no longer holds is a JSON-RPC error
/// carrying the sidecar's reason — never a `null` result the editor would read
/// as "the fix made no change". [REFACTOR-NEVER-SILENT]
#[test]
fn code_action_resolve_unknown_id_answers_error_with_sidecar_reason() {
    require_dotnet();
    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Readiness: the sidecar must hold the solution, or the resolve fails with
    // "No solution loaded" instead of the reason this test is about.
    let _ready = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_mins(2));

    // Interaction 1 — a healthy codeAction round-trip exists: offer the actions.
    let offered = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": file_uri },
            "range": {
                "start": { "line": 3, "character": 14 },
                "end": { "line": 3, "character": 23 }
            },
            "context": { "diagnostics": [] }
        }),
    );
    assert!(
        offered.get("error").is_none(),
        "codeAction must not error: {offered}"
    );

    // Interaction 2 — an id no sidecar ever offered fails with its reason.
    let expired = json!({
        "title": "Add using System.Text;",
        "kind": "quickfix",
        "data": { "id": 424_242, "uri": file_uri }
    });
    let resolved = client.request("codeAction/resolve", expired.clone());
    assert!(
        resolved.get("result").is_none(),
        "a failed resolve must be an error response, never a result: {resolved}"
    );
    let error = resolved["error"]
        .as_object()
        .expect("the response must carry a JSON-RPC error object");
    assert!(
        error["code"].as_i64().is_some(),
        "the error must carry a code: {resolved}"
    );
    let message = error["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("the code action is no longer available"),
        "the error message must carry the sidecar's reason, got: {message}"
    );
    assert!(
        message.contains("invoke the quick fix again"),
        "the reason must tell the user what to do next, got: {message}"
    );

    // Interaction 3 — the same expired id fails again, still never null.
    let again = client.request("codeAction/resolve", expired);
    assert!(
        again.get("result").is_none() && again["error"].is_object(),
        "a second resolve of the same id must stay an error: {again}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Without a sidecar, the resolve names the missing language service, picked by
/// the document's language — not a silent `null`. [REFACTOR-NEVER-SILENT]
#[test]
fn code_action_resolve_without_sidecar_names_the_missing_service() {
    let mut client = open_no_sidecar(SIMPLE_CLASS);

    let csharp = client.request(
        "codeAction/resolve",
        json!({
            "title": "Add using System.Text;",
            "kind": "quickfix",
            "data": { "id": 7, "uri": TEST_URI }
        }),
    );
    assert!(
        csharp.get("result").is_none(),
        "no sidecar must be an error, never a result: {csharp}"
    );
    let csharp_message = csharp["error"]["message"].as_str().unwrap_or_default();
    assert_eq!(
        csharp_message, "the C# language service is not running",
        "the .cs resolve must name the C# service"
    );

    // The same request for an F# document names the F# service: the language is
    // picked from the document, not from the sidecar that happens to exist.
    let fsharp_uri = "file:///test/Program.fs";
    client.open_document(fsharp_uri, "let x = 1");
    let fsharp = client.request(
        "codeAction/resolve",
        json!({
            "title": "Add 'open System'",
            "kind": "quickfix",
            "data": { "id": 7, "uri": fsharp_uri }
        }),
    );
    assert!(
        fsharp.get("result").is_none(),
        "no sidecar must be an error, never a result: {fsharp}"
    );
    assert_eq!(
        fsharp["error"]["message"].as_str().unwrap_or_default(),
        "the F# language service is not running",
        "the .fs resolve must name the F# service"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
