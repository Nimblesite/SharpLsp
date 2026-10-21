//! Full-stack Razor selection ranges over the real fixture: the host routes
//! `textDocument/selectionRange` to the C# sidecar, which answers each position's
//! chain from its innermost span out to the whole document, nested as LSP parents.
//! [RAZOR-FEATURES-SELECTION]

use super::*;

/// `Board.razor`, the fixture's richest component.
const BOARD: &[&str] = &["BlazorApp", "Components", "Pages", "Board.razor"];

/// The whole file's span: the fixture's files end with a line break.
fn document() -> Value {
    json!({
        "start": {"line": 0, "character": 0},
        "end": {"line": 26, "character": 0}
    })
}

#[test]
fn test_full_stack_razor_selection_ranges() {
    require_dotnet();
    let ws = create_razor_workspace();
    let mut client = LspClient::start_verbose();
    let _init = client.initialize_with_root(json!(path_to_file_uri(ws.root())));

    let board = ws.uri(BOARD);
    client.open_document(&board, &ws.text(BOARD));

    // ── A caret on the Tally tag name: tag → element → Panel → document ──
    let chains = poll_selection_until_ready(&mut client, &board, 7, 5);
    let tally = chains
        .as_array()
        .and_then(|all| all.first())
        .expect("one chain per position");
    let levels = selection_levels(tally);
    assert!(
        levels.len() >= 3,
        "a tag name chains at least three levels: {levels:?}"
    );
    assert_eq!(
        levels[0],
        json!({"start": {"line": 7, "character": 5}, "end": {"line": 7, "character": 10}}),
        "the innermost range is the tag name: {levels:?}"
    );
    assert_eq!(
        levels[1],
        json!({"start": {"line": 7, "character": 4}, "end": {"line": 9, "character": 12}}),
        "then the element: {levels:?}"
    );
    assert_eq!(
        levels[2],
        json!({"start": {"line": 6, "character": 0}, "end": {"line": 10, "character": 8}}),
        "then the enclosing Panel: {levels:?}"
    );
    assert_eq!(
        levels.last(),
        Some(&document()),
        "the document closes the chain"
    );
    assert!(
        selection_levels(tally)
            .last()
            .and_then(|level| level.get("parent"))
            .is_none(),
        "the document has no parent: {tally}"
    );
    assert_parents_hold(tally);

    // ── A caret inside a C# identifier in markup chains through the attribute ──
    let answer = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": board },
            "positions": [
                { "line": 8, "character": 25 },
                { "line": 19, "character": 20 }
            ]
        }),
    );
    assert_rpc_ok(&answer, "selectionRange(Board.razor, two carets)");
    let chains = answer["result"].as_array().expect("one chain per position");
    assert_eq!(chains.len(), 2, "one chain per position: {answer}");

    let attribute = selection_levels(&chains[0]);
    assert_eq!(
        attribute[0],
        json!({"start": {"line": 8, "character": 22}, "end": {"line": 8, "character": 29}}),
        "the innermost range is the C# identifier in the value: {attribute:?}"
    );
    assert!(
        attribute.len() >= 5,
        "the identifier chains through the attribute and its elements: {attribute:?}"
    );
    assert_eq!(
        attribute.last(),
        Some(&document()),
        "the document closes the chain"
    );
    assert_parents_hold(&chains[0]);

    let field = selection_levels(&chains[1]);
    assert_eq!(
        field[0],
        json!({"start": {"line": 19, "character": 19}, "end": {"line": 19, "character": 26}}),
        "the innermost range is the field's identifier: {field:?}"
    );
    assert!(field.len() >= 4, "the identifier chains outward: {field:?}");
    assert_eq!(
        field.last(),
        Some(&document()),
        "the document closes the chain"
    );
    assert_parents_hold(&chains[1]);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Ask for `textDocument/selectionRange` until the sidecar has loaded the
/// workspace and answers a chain with a parent, then return the chains.
fn poll_selection_until_ready(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_mins(3);
    loop {
        let response = client.request(
            "textDocument/selectionRange",
            json!({
                "textDocument": { "uri": uri },
                "positions": [{ "line": line, "character": character }]
            }),
        );
        assert_rpc_ok(&response, "selectionRange(Board.razor)");
        let chains = response["result"].as_array().cloned().unwrap_or_default();
        if chains
            .first()
            .is_some_and(|chain| chain["parent"].is_object())
        {
            return Value::Array(chains);
        }
        assert!(
            std::time::Instant::now() < deadline,
            "selection ranges never nested within the deadline: {response}"
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// The chain as its ranges, innermost first.
fn selection_levels(chain: &Value) -> Vec<Value> {
    let mut levels = Vec::new();
    let mut at = Some(chain);
    while let Some(item) = at {
        levels.push(item["range"].clone());
        at = item.get("parent").filter(|parent| parent.is_object());
    }
    levels
}

/// A `line`/`character` object as its numbers, so positions compare.
fn point(value: &Value) -> (u64, u64) {
    (
        value["line"].as_u64().unwrap_or_default(),
        value["character"].as_u64().unwrap_or_default(),
    )
}

/// Every level holds the one before it, so an editor can grow the selection.
fn assert_parents_hold(chain: &Value) {
    let levels = selection_levels(chain);
    for (inner, outer) in levels.iter().zip(levels.iter().skip(1)) {
        let (start, end) = (point(&inner["start"]), point(&inner["end"]));
        let holds = point(&outer["start"]) <= start && point(&outer["end"]) >= end;
        assert!(holds, "each parent must hold its child: {inner} in {outer}");
    }
}
