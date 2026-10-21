//! Full-stack Razor Pages and MVC views over the real fixture's `PagesApp`:
//! `@model`, `@inject` and `@functions` answer through the projection, tag
//! helper elements and attributes answer from their descriptors and complete
//! in scope, and a view resolves what its `_ViewImports.cshtml` imports.
//! [RAZOR-MVC] [RAZOR-MVC-DIRECTIVES] [RAZOR-MVC-TAGHELPERS] [RAZOR-MVC-IMPORTS]

use super::razor::complete_after;
use super::*;

/// The Razor Page with a model, an injection, tag helpers and `@functions`.
const EDIT: &[&str] = &["PagesApp", "Pages", "Edit.cshtml"];

/// The MVC view whose `@model` only `Views/_ViewImports.cshtml` resolves.
const INDEX: &[&str] = &["PagesApp", "Views", "Home", "Index.cshtml"];

#[test]
fn test_full_stack_razor_pages_and_mvc_views() {
    require_dotnet();
    let ws = create_razor_workspace();
    let mut client = LspClient::start_verbose();
    let init = client.initialize_with_root(json!(path_to_file_uri(ws.root())));
    assert_rpc_ok(&init, "initialize the Razor fixture");

    let edit = ws.uri(EDIT);
    let text = ws.text(EDIT);
    client.open_document(&edit, &text);

    assert_directives_answer_through_the_projection(&mut client, &edit);
    assert_tag_helpers_answer_from_their_descriptors(&mut client, &edit, &text);
    assert_view_imports_reach_the_view(&mut client, &ws);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `@model`'s type, `@inject`'s property and a `@functions` method are C#.
fn assert_directives_answer_through_the_projection(client: &mut LspClient, edit: &str) {
    let model = poll_hover_until_ready(client, edit, 1, 8, Duration::from_mins(3));
    let markdown = model["contents"]["value"].as_str().unwrap_or_default();
    assert!(
        markdown.contains("Edits one item."),
        "`@model EditModel` hovers the page model's summary: {markdown}"
    );
    assert_eq!(
        model["range"],
        json!({ "start": { "line": 1, "character": 7 }, "end": { "line": 1, "character": 16 } }),
        "ranged on the type name"
    );

    let log = hover(client, edit, 2, 28);
    assert_hover_ok(&log);
    let markdown = log["result"]["contents"]["value"]
        .as_str()
        .unwrap_or_default();
    assert!(
        markdown.contains("ILogger<"),
        "`@inject` declares a property of its type: {markdown}"
    );

    let shout = definition(client, edit, 10, 5);
    assert_nav_ok(&shout);
    let target = first_location(&shout["result"]);
    assert_eq!(
        target["uri"],
        json!(edit),
        "the method is the page's: {shout}"
    );
    assert_location_line(&target, 13, "`@Shout` goes to its `@functions` declaration");
}

/// An element a tag helper binds, and the attribute it sets, hover from their
/// descriptors; tag helper elements and attributes complete in scope.
fn assert_tag_helpers_answer_from_their_descriptors(
    client: &mut LspClient,
    edit: &str,
    text: &str,
) {
    let input = hover(client, edit, 6, 6);
    assert_hover_ok(&input);
    let markdown = input["result"]["contents"]["value"]
        .as_str()
        .unwrap_or_default();
    assert!(
        markdown.contains("InputTagHelper"),
        "`<input>` hovers its tag helper: {markdown}"
    );

    let title = definition(client, edit, 6, 20);
    assert_nav_ok(&title);
    let entries = location_entries(&title["result"]);
    assert_has_location_in(
        &entries,
        "Edit.cshtml.cs",
        "`asp-for=\"Title\"` names the model's property",
    );

    let elements = complete_after(client, edit, 2, &format!("{text}\n<"));
    let labels: Vec<&str> = elements
        .iter()
        .filter_map(|item| item["label"].as_str())
        .collect();
    for expected in ["partial", "environment"] {
        assert!(
            labels.contains(&expected),
            "`{expected}` completes after `<`: {labels:?}"
        );
    }
    assert_eq!(
        labels.iter().filter(|label| **label == "a").count(),
        1,
        "an element HTML also names completes once: {labels:?}"
    );

    let attributes = complete_after(client, edit, 3, &format!("{text}\n<a asp-"));
    let page = attributes
        .iter()
        .find(|item| item["label"] == "asp-page")
        .expect("`asp-page` completes in an anchor's start tag");
    assert_eq!(
        page["kind"], 10,
        "a tag helper attribute is a property: {page}"
    );
    assert!(
        attributes.iter().any(|item| item["label"] == "asp-route-"),
        "the anchor's prefixed route attributes complete: {attributes:?}"
    );
    client.change_document(edit, 4, text);
}

/// `Views/_ViewImports.cshtml` brings `PagesApp.Models` into the view, so its
/// `@model Item` binds, and the view reports no error.
fn assert_view_imports_reach_the_view(client: &mut LspClient, ws: &RazorWorkspace) {
    let index = ws.uri(INDEX);
    client.open_document(&index, &ws.text(INDEX));
    let item = poll_hover_until_ready(client, &index, 0, 8, Duration::from_mins(1));
    let markdown = item["contents"]["value"].as_str().unwrap_or_default();
    assert!(
        markdown.contains("An item the home page shows."),
        "`@model Item` resolves through the imports: {markdown}"
    );
    let errors = pull_error_diagnostics(client, &index, "Index.cshtml");
    assert_eq!(errors, Vec::<Value>::new(), "the view compiles: {errors:?}");
}
