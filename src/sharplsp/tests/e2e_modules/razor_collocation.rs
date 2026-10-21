//! Full-stack collocated files over the real fixture's `Card.razor`: its
//! `Card.razor.css` classes complete as LSP values inside a `class` value and
//! define to every selector that declares them, and an `"import"` call defines
//! to the start of the `Card.razor.js` module it names, from Razor and from C#.
//! [RAZOR-COLLOCATION] [RAZOR-COLLOCATION-CSS] [RAZOR-COLLOCATION-JS]

use super::razor::complete_after;
use super::*;

/// The component with a collocated stylesheet and module.
const CARD: &[&str] = &["BlazorApp", "Components", "Shared", "Card.razor"];

/// The component's scoped stylesheet.
const STYLESHEET: &[&str] = &["BlazorApp", "Components", "Shared", "Card.razor.css"];

/// Plain C# that imports the component's module.
const INTEROP: &[&str] = &["BlazorApp", "Components", "Shared", "CardInterop.cs"];

/// LSP `CompletionItemKind.Value`.
const VALUE: u64 = 12;

#[test]
fn test_full_stack_razor_collocated_styles_and_scripts() {
    require_dotnet();
    let ws = create_razor_workspace();
    let mut client = LspClient::start_verbose();
    let init = client.initialize_with_root(json!(path_to_file_uri(ws.root())));
    assert_rpc_ok(&init, "initialize the Razor fixture");

    let card = ws.uri(CARD);
    let text = ws.text(CARD);
    client.open_document(&card, &text);

    assert_classes_define_to_their_selectors(&mut client, &ws, &card);
    assert_modules_define_to_their_start(&mut client, &ws, &card);
    assert_classes_complete_as_values(&mut client, &card, &text);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `title` in `<div class="card title">` lands on the five selectors of `.title`,
/// each ranged on the name after its `.`.
fn assert_classes_define_to_their_selectors(
    client: &mut LspClient,
    ws: &RazorWorkspace,
    card: &str,
) {
    let first = poll_definition_until_ready(client, card, 4, 19, Duration::from_mins(3));
    assert!(
        first["uri"]
            .as_str()
            .is_some_and(|uri| uri.ends_with("/Card.razor.css")),
        "a class defines in the component's stylesheet: {first}"
    );
    let all = definition(client, card, 4, 19);
    assert_nav_ok(&all);
    let locations = all["result"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        locations.len(),
        5,
        "every selector of `.title`: {locations:?}"
    );
    let stylesheet = ws.text(STYLESHEET);
    let lines: Vec<&str> = stylesheet.lines().collect();
    for location in &locations {
        assert!(
            location["uri"]
                .as_str()
                .is_some_and(|uri| uri.ends_with("/Card.razor.css")),
            "{location}"
        );
        assert_eq!(
            ranged_text(&lines, location),
            "title",
            "on the name: {location}"
        );
    }
}

/// The module literal in `@code` and in plain C# both define to the module's start.
fn assert_modules_define_to_their_start(client: &mut LspClient, ws: &RazorWorkspace, card: &str) {
    let razor = definition(client, card, 22, 20);
    assert_nav_ok(&razor);
    assert_module_start(&razor["result"], "from the component's @code block");

    let interop = ws.uri(INTEROP);
    let source = ws.text(INTEROP);
    client.open_document(&interop, &source);
    let (line, character) = source
        .lines()
        .enumerate()
        .find_map(|(line, text)| text.find("\"./Components").map(|at| (line, at + 4)))
        .expect("CardInterop.cs imports the module");
    let csharp = definition(
        client,
        &interop,
        u32::try_from(line).unwrap_or_default(),
        u32::try_from(character).unwrap_or_default(),
    );
    assert_nav_ok(&csharp);
    assert_module_start(&csharp["result"], "from plain C#");
}

/// One location, at the very start of `Card.razor.js`.
fn assert_module_start(result: &Value, label: &str) {
    let locations = result.as_array().cloned().unwrap_or_default();
    assert_eq!(locations.len(), 1, "{label}: one module: {result}");
    assert!(
        locations[0]["uri"]
            .as_str()
            .is_some_and(|uri| uri.ends_with("/Card.razor.js")),
        "{label}: the collocated module: {result}"
    );
    assert_eq!(
        locations[0]["range"],
        json!({ "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } }),
        "{label}: at its start"
    );
}

/// After `<div class="card ti`, `title` completes once as an LSP value naming the
/// stylesheet, replacing only `ti`.
fn assert_classes_complete_as_values(client: &mut LspClient, card: &str, text: &str) {
    let typed = format!("{text}\n<div class=\"card ti");
    let items = complete_after(client, card, 2, &typed);
    let titles: Vec<&Value> = items
        .iter()
        .filter(|item| item["label"] == "title")
        .collect();
    assert_eq!(titles.len(), 1, "each class once: {items:?}");
    let title = titles[0];
    assert_eq!(
        title["kind"], VALUE,
        "a stylesheet class is a value: {title}"
    );
    assert_eq!(
        title["detail"], "Card.razor.css",
        "naming its stylesheet: {title}"
    );
    let line = typed.lines().count() - 1;
    let end = typed
        .lines()
        .last()
        .map_or(0, |last| last.encode_utf16().count());
    assert_eq!(
        title["textEdit"]["range"],
        json!({
            "start": { "line": line, "character": end - 2 },
            "end": { "line": line, "character": end }
        }),
        "replacing the class name at the caret: {title}"
    );
    assert!(
        items
            .iter()
            .any(|item| item["label"] == "card--grid" && item["kind"] == VALUE),
        "a class inside nested at-rules completes too: {items:?}"
    );
    client.change_document(card, 3, text);
}

/// The text a single-line location covers in `lines`.
fn ranged_text<'a>(lines: &[&'a str], location: &Value) -> &'a str {
    let at = |key: &str, field: &str| {
        location["range"][key][field]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or_default()
    };
    lines
        .get(at("start", "line"))
        .and_then(|line| line.get(at("start", "character")..at("end", "character")))
        .unwrap_or_default()
}
