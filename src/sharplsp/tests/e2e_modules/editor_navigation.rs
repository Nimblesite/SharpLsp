//! E2E for the editor-navigation requests: `sharplsp/relatedFiles`
//! ([SHARPLSP-FEATURES-NAVIGATION-RELATED]) and `sharplsp/adjacentMember`
//! ([SHARPLSP-FEATURES-NAVIGATION-MEMBERS]) against a real host, with C# answered
//! by tree-sitter alone and F# by the real F# sidecar.

use super::fixall_fsharp_tests::write_project;
use super::*;

/// The names `sharplsp/relatedFiles` answers for `file`.
fn related_names(client: &mut LspClient, file: &std::path::Path) -> Vec<String> {
    let resp = client.request(
        "sharplsp/relatedFiles",
        json!({ "textDocument": { "uri": path_to_file_uri(file) } }),
    );
    assert!(resp.get("error").is_none(), "relatedFiles failed: {resp}");
    let files = resp["result"]["files"].as_array().unwrap().clone();
    for entry in &files {
        let name = entry["name"].as_str().unwrap();
        let uri = entry["uri"].as_str().unwrap();
        assert!(uri.starts_with("file://"), "a file URI: {entry}");
        assert!(uri.ends_with(name), "the URI names the file: {entry}");
    }
    files
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn related_files_are_the_siblings_sharing_the_name_up_to_its_first_dot() {
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    for name in [
        "Form1.cs",
        "Form1.Designer.cs",
        "Form1.resx",
        "Form10.cs",
        "Other.cs",
        "Lib.fs",
        "Lib.fsi",
        "Index.razor",
        "Index.razor.cs",
        "Index.razor.css",
    ] {
        std::fs::write(root.join(name), "").unwrap();
    }
    // A directory of the same family is not a file to open.
    std::fs::create_dir(root.join("Form1.Assets")).unwrap();
    let mut client = LspClient::start_without_sidecars();
    let _ = client.initialize();

    // Interaction 1 — a form finds its designer and resources, not Form10.
    assert_eq!(
        related_names(&mut client, &root.join("Form1.cs")),
        ["Form1.Designer.cs", "Form1.resx"]
    );
    // Interaction 2 — the relation is symmetric: the designer finds the form.
    assert_eq!(
        related_names(&mut client, &root.join("Form1.Designer.cs")),
        ["Form1.cs", "Form1.resx"]
    );
    // Interaction 3 — F# signature pairs and Razor code-behind and styles.
    assert_eq!(
        related_names(&mut client, &root.join("Lib.fs")),
        ["Lib.fsi"]
    );
    assert_eq!(
        related_names(&mut client, &root.join("Lib.fsi")),
        ["Lib.fs"]
    );
    assert_eq!(
        related_names(&mut client, &root.join("Index.razor.css")),
        ["Index.razor", "Index.razor.cs"]
    );
    // Interaction 4 — a file that stands alone, or is not on disk, has none.
    let none: [String; 0] = [];
    assert_eq!(related_names(&mut client, &root.join("Other.cs")), none);
    assert_eq!(related_names(&mut client, &root.join("Form10.cs")), none);
    assert_eq!(
        related_names(&mut client, &root.join("gone").join("Missing.cs")),
        none
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `(line, character)` of the adjacent member, or `None` at either end.
fn adjacent(
    client: &mut LspClient,
    uri: &str,
    at: (u64, u64),
    direction: &str,
) -> Option<(u64, u64)> {
    let resp = client.request(
        "sharplsp/adjacentMember",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": at.0, "character": at.1 },
            "direction": direction,
        }),
    );
    assert!(resp.get("error").is_none(), "adjacentMember failed: {resp}");
    let position = &resp["result"]["position"];
    (!position.is_null()).then(|| {
        (
            position["line"].as_u64().unwrap(),
            position["character"].as_u64().unwrap(),
        )
    })
}

/// Every stop from `from` in `direction`, until the document runs out.
fn walk(client: &mut LspClient, uri: &str, from: (u64, u64), direction: &str) -> Vec<(u64, u64)> {
    let mut stops = Vec::new();
    let mut at = from;
    while let Some(next) = adjacent(client, uri, at, direction) {
        assert!(stops.len() < 100, "the walk must end: {stops:?}");
        stops.push(next);
        at = next;
    }
    stops
}

/// Where every non-namespace symbol of the outline starts, sorted: what the
/// walk must visit, read from the same tree the breadcrumbs use.
fn outline_starts(client: &mut LspClient, uri: &str) -> Vec<(u64, u64)> {
    fn collect(symbols: &Value, starts: &mut Vec<(u64, u64)>) {
        for symbol in symbols.as_array().into_iter().flatten() {
            let start = &symbol["selectionRange"]["start"];
            if symbol["kind"] != 3 {
                starts.push((
                    start["line"].as_u64().unwrap(),
                    start["character"].as_u64().unwrap(),
                ));
            }
            collect(&symbol["children"], starts);
        }
    }
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": uri } }),
    );
    let mut starts = Vec::new();
    collect(&resp["result"], &mut starts);
    starts.sort_unstable();
    starts
}

const MEMBERS_CS: &str = "namespace N;\npublic class A\n{\n    public int F;\n    public void M()\n    {\n        var x = 1;\n    }\n    public int P { get; set; }\n}\npublic enum E { One, Two }\n";

#[test]
fn adjacent_member_walks_the_csharp_outline_in_both_directions() {
    let mut client = LspClient::start_without_sidecars();
    let _ = client.initialize();
    let uri = "file:///test/Members.cs";
    client.open_document(uri, MEMBERS_CS);
    let starts = outline_starts(&mut client, uri);
    assert!(
        starts.len() >= 5,
        "class, field, method, property, enum: {starts:?}"
    );
    assert!(starts.contains(&(1, 13)), "class A: {starts:?}");
    assert!(starts.contains(&(4, 16)), "method M: {starts:?}");
    assert!(
        !starts.contains(&(0, 10)),
        "the namespace is not a member: {starts:?}"
    );

    // Interaction 1 — next, from the top, visits every member once, in order.
    assert_eq!(walk(&mut client, uri, (0, 0), "next"), starts);
    // Interaction 2 — previous, from the end, visits them in reverse.
    let mut reversed = starts.clone();
    reversed.reverse();
    assert_eq!(walk(&mut client, uri, (99, 0), "previous"), reversed);
    // Interaction 3 — from inside M's body: back to M's own name, on to P.
    assert_eq!(
        adjacent(&mut client, uri, (6, 12), "previous"),
        Some((4, 16))
    );
    assert_eq!(adjacent(&mut client, uri, (6, 12), "next"), Some((8, 15)));
    // Interaction 4 — on a member's name the neighbours are the other members.
    assert_eq!(
        adjacent(&mut client, uri, (4, 16), "previous"),
        Some((3, 15))
    );
    assert_eq!(adjacent(&mut client, uri, starts[0], "previous"), None);
    assert_eq!(
        adjacent(&mut client, uri, *starts.last().unwrap(), "next"),
        None
    );

    // Interaction 5 — an unsaved edit moves the members with it.
    client.change_document(uri, 2, &format!("\n{MEMBERS_CS}"));
    assert_eq!(adjacent(&mut client, uri, (0, 0), "next"), Some((2, 13)));

    // Interaction 6 — F# has no engine here, and says so instead of answering null.
    let fs_uri = "file:///test/Members.fs";
    client.open_document(fs_uri, "module M\nlet x = 1\n");
    let refused = client.request(
        "sharplsp/adjacentMember",
        json!({
            "textDocument": { "uri": fs_uri },
            "position": { "line": 0, "character": 0 },
            "direction": "next",
        }),
    );
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not running"),
        "{refused}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

const MEMBERS_FS: &str = "module Order.Members\n\nlet value = 41\n\nlet next x = x + 1\n\ntype Point = { X: int; Y: int }\n";

/// F# first: the same walk over the F# compiler's own outline.
#[test]
fn adjacent_member_walks_the_fsharp_outline_in_both_directions() {
    require_dotnet();
    let tmp = tempfile::tempdir().unwrap();
    write_project(
        tmp.path(),
        "Order",
        &[("Members.fs", MEMBERS_FS.to_string())],
        &[],
    );
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(path_to_file_uri(&root)));
    let uri = path_to_file_uri(&root.join("Order").join("Members.fs"));
    client.open_document(&uri, MEMBERS_FS);
    let deadline = Instant::now() + Duration::from_secs(150);
    let starts = loop {
        let starts = outline_starts(&mut client, &uri);
        if !starts.is_empty() {
            break starts;
        }
        assert!(Instant::now() < deadline, "the F# outline never arrived");
        std::thread::sleep(Duration::from_secs(1));
    };
    assert!(starts.contains(&(2, 4)), "let value: {starts:?}");
    assert!(starts.contains(&(4, 4)), "let next: {starts:?}");
    assert!(starts.contains(&(6, 5)), "type Point: {starts:?}");

    // Interaction 1 — next and previous visit every member, in order. The
    // module's own name starts the file, so a caret there is already on it.
    let after_origin: Vec<(u64, u64)> = starts.iter().copied().filter(|at| *at > (0, 0)).collect();
    assert_eq!(walk(&mut client, &uri, (0, 0), "next"), after_origin);
    let mut reversed = starts.clone();
    reversed.reverse();
    assert_eq!(walk(&mut client, &uri, (99, 0), "previous"), reversed);
    // Interaction 2 — from inside `next`'s body: back to its name, on to Point.
    assert_eq!(
        adjacent(&mut client, &uri, (4, 14), "previous"),
        Some((4, 4))
    );
    assert_eq!(adjacent(&mut client, &uri, (4, 14), "next"), Some((6, 5)));
    // Interaction 3 — the ends answer nothing.
    assert_eq!(adjacent(&mut client, &uri, starts[0], "previous"), None);
    assert_eq!(
        adjacent(&mut client, &uri, *starts.last().unwrap(), "next"),
        None
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
