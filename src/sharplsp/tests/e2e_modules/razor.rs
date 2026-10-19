//! Full-stack Razor session against the real fixture solution: the host
//! routes a `.razor` file to the C# sidecar, forwards the syntax requests it
//! cannot parse, short-circuits markup triggers elsewhere, and publishes
//! Razor diagnostics under their own source. [RAZOR-ARCHITECTURE-ROUTING]

use super::*;

/// `Board.razor`, the fixture's richest component.
const BOARD: &[&str] = &["BlazorApp", "Components", "Pages", "Board.razor"];

/// `SymbolKind.Class` and `SymbolKind.Key` on the wire.
const CLASS: u64 = 5;
const KEY: u64 = 20;

#[test]
fn test_full_stack_razor_routing_session() {
    require_dotnet();
    let ws = create_razor_workspace();
    let mut client = LspClient::start_verbose();
    let init = client.initialize_with_root(json!(path_to_file_uri(ws.root())));
    let triggers = &init["result"]["capabilities"]["completionProvider"]["triggerCharacters"];
    assert_eq!(
        triggers,
        &json!([".", "<", "@"]),
        "Razor triggers advertised"
    );

    let board = ws.uri(BOARD);
    let board_text = ws.text(BOARD);
    client.open_document(&board, &board_text);

    // ── Readiness: a C# fragment's hover arrives through the projection ──
    let hover = poll_hover_until_ready(&mut client, &board, 11, 16, Duration::from_mins(3));
    let markdown = hover["contents"]["value"].as_str().unwrap_or_default();
    assert!(
        markdown.contains("caption") && markdown.contains("string"),
        "hover on `caption` in `@bind` must show the field: {markdown}"
    );

    assert_syntax_requests_reach_the_sidecar(&mut client, &board);
    assert_html_projection(&mut client, &ws, &board, &board_text);
    assert_markup_triggers_only_complete_razor(&mut client, &ws);
    assert_diagnostics_publish_as_razor(&mut client, &board, &board_text);
}

/// documentSymbol, foldingRange and linkedEditingRange come from the sidecar's
/// Razor compiler; selectionRange answers empty. [RAZOR-FEATURES-STRUCTURE]
fn assert_syntax_requests_reach_the_sidecar(client: &mut LspClient, board: &str) {
    let symbols = document_request(client, "textDocument/documentSymbol", board);
    assert_rpc_ok(&symbols, "documentSymbol(Board.razor)");
    let names: Vec<&str> = symbols["result"]
        .as_array()
        .expect("nested symbols")
        .iter()
        .filter_map(|symbol| symbol["name"].as_str())
        .collect();
    assert_eq!(
        names,
        [
            "@page",
            "@implements",
            "@inject",
            "PageTitle",
            "Panel",
            "input",
            "button",
            "@code"
        ]
    );
    let panel = find_symbol(&symbols["result"], "Panel").expect("Panel symbol");
    assert_eq!(panel["kind"], CLASS);
    assert_eq!(
        panel["selectionRange"]["start"],
        json!({ "line": 6, "character": 1 })
    );
    assert_eq!(
        find_symbol(&symbols["result"], "@code").expect("@code")["kind"],
        KEY
    );
    assert!(
        find_symbol(&panel["children"], "Badge").is_some(),
        "Badge nests in Tally"
    );
    assert_eq!(
        find_symbol(&symbols["result"], "Add").expect("Add")["kind"],
        6
    );

    let folds = document_request(client, "textDocument/foldingRange", board);
    assert_rpc_ok(&folds, "foldingRange(Board.razor)");
    let lines: Vec<(u64, u64)> = folds["result"]
        .as_array()
        .expect("folding ranges")
        .iter()
        .map(|fold| {
            (
                fold["startLine"].as_u64().unwrap(),
                fold["endLine"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(lines, [(6, 9), (7, 8), (14, 24)]);

    let linked = position_request(client, "textDocument/linkedEditingRange", board, (6, 3));
    assert_rpc_ok(&linked, "linkedEditingRange(<Panel)");
    assert_eq!(
        linked["result"]["ranges"],
        json!([
            { "start": { "line": 6, "character": 1 }, "end": { "line": 6, "character": 6 } },
            { "start": { "line": 10, "character": 2 }, "end": { "line": 10, "character": 7 } }
        ])
    );
    let none = position_request(client, "textDocument/linkedEditingRange", board, (8, 10));
    assert_eq!(
        none["result"],
        Value::Null,
        "a self-closing tag links nothing"
    );

    let selection = client.request(
        "textDocument/selectionRange",
        json!({ "textDocument": { "uri": board }, "positions": [{ "line": 6, "character": 3 }] }),
    );
    assert_rpc_ok(&selection, "selectionRange(Board.razor)");
    assert_eq!(selection["result"], json!([]));
}

/// The HTML projection keeps markup at its own positions and blanks Razor; a
/// C# file has none. [RAZOR-ARCHITECTURE-HTML]
fn assert_html_projection(client: &mut LspClient, ws: &RazorWorkspace, board: &str, text: &str) {
    let answer = document_request(client, "sharplsp/razor/htmlProjection", board);
    assert_rpc_ok(&answer, "htmlProjection(Board.razor)");
    let html = answer["result"]["text"].as_str().expect("projection text");
    let widths = |source: &str| source.lines().map(str::len).collect::<Vec<_>>();
    assert_eq!(widths(html), widths(text), "every line keeps its width");
    let lines: Vec<&str> = html.lines().collect();
    assert_eq!(
        lines[4], "<PageTitle>Board    </PageTitle>",
        "`@Id` is blanked"
    );
    assert!(lines[6].starts_with("<Panel"), "markup stays: {}", lines[6]);
    assert_eq!(lines[10], "</Panel>");
    assert!(
        lines[0].trim().is_empty() && lines[14].trim().is_empty(),
        "`@page` and `@code {{` are blanked"
    );

    let program = ws.uri(&["BlazorApp", "Program.cs"]);
    let none = document_request(client, "sharplsp/razor/htmlProjection", &program);
    assert_rpc_ok(&none, "htmlProjection(Program.cs)");
    assert_eq!(none["result"], Value::Null, "a C# file has no projection");
}

/// `<` and `@` complete in Razor but answer `null` at once in C#.
fn assert_markup_triggers_only_complete_razor(client: &mut LspClient, ws: &RazorWorkspace) {
    let program = ws.uri(&["BlazorApp", "Program.cs"]);
    client.open_document(&program, &ws.text(&["BlazorApp", "Program.cs"]));
    for trigger in ["<", "@"] {
        let completion = client.request(
            "textDocument/completion",
            json!({
                "textDocument": { "uri": program },
                "position": { "line": 0, "character": 0 },
                "context": { "triggerKind": 2, "triggerCharacter": trigger }
            }),
        );
        assert_rpc_ok(&completion, "completion(Program.cs, markup trigger)");
        assert_eq!(
            completion["result"],
            Value::Null,
            "`{trigger}` in C# answers null"
        );
    }
    let counter = ws.uri(&["BlazorApp", "Components", "Pages", "Counter.razor"]);
    client.open_document(
        &counter,
        &ws.text(&["BlazorApp", "Components", "Pages", "Counter.razor"]),
    );
    let at = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": counter },
            "position": { "line": 0, "character": 1 },
            "context": { "triggerKind": 2, "triggerCharacter": "@" }
        }),
    );
    assert_rpc_ok(&at, "completion(Counter.razor, @)");
}

/// A C# error in a Razor file publishes under `sharplsp-razor`, and clears.
fn assert_diagnostics_publish_as_razor(client: &mut LspClient, board: &str, text: &str) {
    let broken = text.replace("score + Id)", "score + Idd)");
    client.change_document(board, 2, &broken);
    let errors = poll_error_diagnostics_until(
        client,
        board,
        "diagnostics(Board.razor)",
        Duration::from_mins(2),
        |errors| errors.iter().any(|d| d["code"] == "CS0103"),
    );
    let unknown = errors
        .iter()
        .find(|d| d["code"] == "CS0103")
        .expect("CS0103");
    assert_eq!(unknown["source"], "sharplsp-razor");
    assert_eq!(unknown["range"]["start"]["line"], 22);
    assert!(unknown["message"]
        .as_str()
        .unwrap_or_default()
        .contains("Idd"));

    client.change_document(board, 3, text);
    let _ = poll_error_diagnostics_until(
        client,
        board,
        "diagnostics(Board.razor) after the fix",
        Duration::from_mins(2),
        <[Value]>::is_empty,
    );
}
