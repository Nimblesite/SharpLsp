//! Full-stack Razor inlay hints, code lenses, and call and type hierarchy over the real
//! fixture. Each runs on the Razor file's C# projection and answers in the file itself:
//! positions, items and call sites are Razor ranges, a component class is its own file.
//! [RAZOR-FEATURES-INLAY-HINTS] [RAZOR-FEATURES-HIERARCHY] [RAZOR-ARCHITECTURE-PROJECTION]

use super::*;

/// `Ticker.razor`: a component that inherits another, calls a plain C# method, and renders
/// markup that clicks its own handler.
const TICKER: &[&str] = &["BlazorApp", "Components", "Shared", "Ticker.razor"];

/// `Panel.razor`, the component `Ticker` inherits.
const PANEL: &[&str] = &["Widgets", "Panel.razor"];

#[test]
fn test_full_stack_razor_hierarchy_and_hints() {
    require_dotnet();
    let ws = create_razor_workspace();
    let mut client = LspClient::start_verbose();
    let init = client.initialize_with_root(json!(path_to_file_uri(ws.root())));
    assert_rpc_ok(&init, "initialize the Razor fixture");

    let ticker = ws.uri(TICKER);
    client.open_document(&ticker, &ws.text(TICKER));

    // ── Readiness: a hover inside the file's C# arrives through the projection ──
    let hover = poll_hover_until_ready(&mut client, &ticker, 2, 24, Duration::from_mins(3));
    let markdown = hover["contents"]["value"].as_str().unwrap_or_default();
    assert!(
        markdown.contains("Describe"),
        "hover on `Describe` must show the method: {markdown}"
    );

    assert_call_hierarchy(&mut client, &ticker);
    assert_type_hierarchy(&mut client, &ws, &ticker);
    assert_inlay_hints(&mut client, &ticker);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `prepareCallHierarchy` and `incomingCalls` from a Razor position: the item is the Razor
/// declaration, and the markup that clicks it is a caller in the same file.
fn assert_call_hierarchy(client: &mut LspClient, ticker: &str) {
    let hit = prepared(client, "textDocument/prepareCallHierarchy", ticker, 8, 17);
    assert_eq!(hit["name"], "Hit", "{hit}");
    assert_eq!(hit["kind"], 6, "a method: {hit}");
    assert_eq!(hit["uri"], json!(ticker), "{hit}");
    assert_eq!(
        hit["range"],
        json!({
            "start": { "line": 8, "character": 17 },
            "end": { "line": 8, "character": 20 },
        }),
        "{hit}"
    );

    let incoming = client.request("callHierarchy/incomingCalls", json!({ "item": hit }));
    assert_rpc_ok(&incoming, "incomingCalls(Hit)");
    let calls = incoming["result"].as_array().expect("incoming calls");
    assert_eq!(calls.len(), 1, "{incoming}");
    let call = &calls[0];
    assert_eq!(
        call["from"]["name"], "Ticker.razor",
        "the component's own markup calls it: {call}"
    );
    assert_eq!(call["from"]["kind"], 5, "the component is a class: {call}");
    assert_eq!(call["from"]["uri"], json!(ticker), "{call}");
    assert_eq!(
        call["from"]["selectionRange"]["start"],
        json!({ "line": 0, "character": 0 }),
        "a component is its file: {call}"
    );
    assert_eq!(
        call["fromRanges"],
        json!([{
            "start": { "line": 3, "character": 18 },
            "end": { "line": 3, "character": 21 },
        }]),
        "the click the markup writes: {call}"
    );
}

/// `prepareTypeHierarchy` from `@inherits`, and its subtypes: the base component is its own
/// file, and the subtype is this one's.
fn assert_type_hierarchy(client: &mut LspClient, ws: &RazorWorkspace, ticker: &str) {
    let panel = prepared(client, "textDocument/prepareTypeHierarchy", ticker, 0, 10);
    assert_eq!(panel["name"], "Panel", "{panel}");
    assert_eq!(panel["kind"], 5, "a component is a class: {panel}");
    assert_eq!(panel["uri"], json!(ws.uri(PANEL)), "{panel}");
    assert_eq!(
        panel["selectionRange"],
        json!({
            "start": { "line": 0, "character": 0 },
            "end": { "line": 0, "character": 0 },
        }),
        "a component class is the start of its file: {panel}"
    );

    let subtypes = client.request("typeHierarchy/subtypes", json!({ "item": panel }));
    assert_rpc_ok(&subtypes, "subtypes(Panel)");
    let items = subtypes["result"].as_array().expect("subtypes");
    assert_eq!(items.len(), 1, "{subtypes}");
    assert_eq!(items[0]["name"], "Ticker", "{subtypes}");
    assert_eq!(items[0]["uri"], json!(ticker), "{subtypes}");
}

/// `textDocument/inlayHint` over the file: the hints of its C# fragments sit at their Razor
/// positions, the generated builder's own arguments are dropped, and a range outside every
/// fragment answers none.
fn assert_inlay_hints(client: &mut LspClient, ticker: &str) {
    let hints = inlay_hints(client, ticker, (0, 0), (18, 0));
    assert!(
        hints.iter().any(
            |hint| hint["position"] == json!({ "line": 10, "character": 11 })
                && hint["label"] == ": int"
                && hint["kind"] == 1
        ),
        "the type of a `var` in `@code`: {hints:?}"
    );
    assert!(
        hints.iter().any(
            |hint| hint["position"] == json!({ "line": 10, "character": 33 })
                && hint["label"] == "by:"
                && hint["kind"] == 2
        ),
        "the name of the argument `Bump` takes: {hints:?}"
    );
    assert!(
        hints.iter().all(|hint| hint["position"]["line"]
            .as_u64()
            .is_some_and(|line| line <= 18)),
        "every hint is in the file, not in its projection: {hints:?}"
    );

    assert_eq!(
        inlay_hints(client, ticker, (4, 0), (4, 0)),
        Vec::<Value>::new(),
        "a blank line outside every C# fragment has no hints"
    );
}

/// The hints the server answers over `range`, asserted well-formed.
fn inlay_hints(
    client: &mut LspClient,
    uri: &str,
    start: (u64, u64),
    end: (u64, u64),
) -> Vec<Value> {
    let response = client.request(
        "textDocument/inlayHint",
        json!({
            "textDocument": { "uri": uri },
            "range": {
                "start": { "line": start.0, "character": start.1 },
                "end": { "line": end.0, "character": end.1 },
            },
        }),
    );
    assert_rpc_ok(&response, "inlayHint");
    let hints = response["result"]
        .as_array()
        .expect("an array of hints")
        .clone();
    for hint in &hints {
        assert!(hint["position"].is_object(), "a position: {hint}");
        assert!(
            hint["label"]
                .as_str()
                .is_some_and(|label| !label.is_empty()),
            "a label: {hint}"
        );
    }
    hints
}

/// The single item `method` prepares at a position.
fn prepared(client: &mut LspClient, method: &str, uri: &str, line: u64, character: u64) -> Value {
    let response = client.request(
        method,
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
        }),
    );
    assert_rpc_ok(&response, method);
    let none = Vec::new();
    let items = response["result"].as_array().unwrap_or(&none);
    assert_eq!(items.len(), 1, "{method} prepares one item: {response}");
    items[0].clone()
}
