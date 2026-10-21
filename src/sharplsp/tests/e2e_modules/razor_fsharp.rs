//! Full-stack F# in a Razor solution over the real fixture: `Leaders.razor`
//! uses the F# `Domain` library's record, union and module functions. The C#
//! sidecar reads Domain as its built DLL; the host finds each F# symbol in the
//! F# sidecar by its identity, so definition lands in `Scores.fs`, and
//! references and rename span F#, C# and Razor, from either side.
//! [RAZOR-FSHARP] [DEFINITION-CROSSLANG-IDENTITY] [REFERENCES-CROSS-LANGUAGE]

use super::*;

/// The page that uses the F# library.
const LEADERS: &[&str] = &["BlazorApp", "Components", "Pages", "Leaders.razor"];

/// The F# library's only file.
const SCORES: &[&str] = &["Domain", "Scores.fs"];

/// The zero-based position of `token` on the first line of `text` holding
/// `anchor`. The fixture is ASCII, so bytes are UTF-16 code units.
fn locate(text: &str, anchor: &str, token: &str) -> (u32, u32) {
    let (line, content) = text
        .lines()
        .enumerate()
        .find(|(_, content)| content.contains(anchor))
        .unwrap_or_else(|| panic!("missing anchor {anchor}"));
    let character = content
        .find(token)
        .unwrap_or_else(|| panic!("missing token {token}"));
    (
        u32::try_from(line).expect("line fits"),
        u32::try_from(character).expect("character fits"),
    )
}

/// The name position of every `.name` member use in `text`.
fn member_uses(text: &str, name: &str) -> Vec<(u32, u32)> {
    let dotted = format!(".{name}");
    text.lines()
        .enumerate()
        .flat_map(|(line, content)| {
            content
                .match_indices(dotted.as_str())
                .map(move |(at, _)| (line, at + 1))
                .collect::<Vec<_>>()
        })
        .map(|(line, at)| {
            (
                u32::try_from(line).expect("line fits"),
                u32::try_from(at).expect("character fits"),
            )
        })
        .collect()
}

/// A location's file name and start.
fn placed(location: &Value) -> (String, u64, u64) {
    let uri = location["uri"].as_str().unwrap_or_default();
    let name = uri.rsplit('/').next().unwrap_or_default().to_string();
    let start = &location["range"]["start"];
    (
        name,
        start["line"].as_u64().unwrap_or(u64::MAX),
        start["character"].as_u64().unwrap_or(u64::MAX),
    )
}

/// A position in a named file, as [`placed`] reports it.
fn at(file: &str, (line, character): (u32, u32)) -> (String, u64, u64) {
    (file.to_string(), u64::from(line), u64::from(character))
}

/// Poll definition at `position` until it lands in `Scores.fs`: until the F#
/// sidecar has loaded Domain, the C# sidecar's decompiled answer stands.
fn poll_fsharp_definition(
    client: &mut LspClient,
    uri: &str,
    (line, character): (u32, u32),
) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_mins(3);
    loop {
        let response = definition(client, uri, line, character);
        assert_nav_ok(&response);
        let location = first_location(&response["result"]);
        if location["uri"]
            .as_str()
            .is_some_and(|found| found.ends_with("Scores.fs"))
        {
            return location;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "definition at {line}:{character} never reached Scores.fs: {response}"
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

#[test]
fn test_full_stack_fsharp_in_razor_session() {
    require_dotnet();
    let ws = create_razor_workspace_with_fsharp_built();
    let mut client = LspClient::start_verbose();
    let init = client.initialize_with_root(json!(path_to_file_uri(ws.root())));
    assert_rpc_ok(&init, "initialize Razor fixture");
    let leaders = ws.uri(LEADERS);
    let page = ws.text(LEADERS);
    let scores = ws.text(SCORES);
    client.open_document(&leaders, &page);

    // ── Hover: the F# record, with its F# documentation, from Domain's DLL ──
    let (line, character) = locate(&page, "private readonly Player[]", "Player");
    let hover = poll_hover_until_ready(
        &mut client,
        &leaders,
        line,
        character,
        Duration::from_mins(3),
    );
    let markdown = hover["contents"]["value"].as_str().unwrap_or_default();
    assert!(
        markdown.contains("A player on the leader board."),
        "Player hover: {markdown}"
    );
    assert_eq!(
        hover["range"]["start"],
        json!({ "line": line, "character": character })
    );

    assert_definition_lands_in_fsharp_source(&mut client, &leaders, &page, &scores);
    assert_references_span_fsharp_and_razor(&mut client, &leaders, &page, &scores);
    assert_rename_from_razor_renames_fsharp(&mut client, &leaders, &page, &scores);
    assert_rename_from_fsharp_renames_razor(&mut client, &ws, &page, &scores);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Definition, type definition and declaration from Razor onto F# symbols land
/// on their F# declarations, never decompiled source. [DEFINITION-CROSSLANG-IDENTITY]
fn assert_definition_lands_in_fsharp_source(
    client: &mut LspClient,
    leaders: &str,
    page: &str,
    scores: &str,
) {
    let player = poll_fsharp_definition(
        client,
        leaders,
        locate(page, "private readonly Player[]", "Player"),
    );
    assert_eq!(
        placed(&player),
        at("Scores.fs", locate(scores, "type Player", "Player"))
    );
    assert_eq!(
        player["range"]["end"]["character"].as_u64(),
        Some(u64::from(locate(scores, "type Player", "Player").1) + 6),
        "the range is the type's name"
    );
    let score = poll_fsharp_definition(client, leaders, locate(page, "@player.Score", "Score"));
    assert_eq!(
        placed(&score),
        at("Scores.fs", locate(scores, "Score: int", "Score"))
    );
    let total = poll_fsharp_definition(client, leaders, locate(page, "@Scoring.total", "total"));
    assert_eq!(
        placed(&total),
        at("Scores.fs", locate(scores, "let total", "total"))
    );
    let constructed =
        poll_fsharp_definition(client, leaders, locate(page, "[new Player(", "Player"));
    assert_eq!(
        placed(&constructed),
        placed(&player),
        "a record's constructor is its type"
    );

    let (line, character) = locate(page, "var player in players", "player");
    let type_definition = type_definition(client, leaders, line, character);
    assert_nav_ok(&type_definition);
    assert_eq!(
        placed(&first_location(&type_definition["result"])),
        placed(&player)
    );
}

/// References from Razor on an F# record field hold its F# declaration and
/// every F# and Razor use; without the declaration, only the uses.
/// [REFERENCES-CROSS-LANGUAGE] [RAZOR-FSHARP-REFERENCES]
fn assert_references_span_fsharp_and_razor(
    client: &mut LspClient,
    leaders: &str,
    page: &str,
    scores: &str,
) {
    let (line, character) = locate(page, "@player.Score", "Score");
    let mut expected: Vec<(String, u64, u64)> = member_uses(scores, "Score")
        .into_iter()
        .map(|position| at("Scores.fs", position))
        .chain([at("Leaders.razor", (line, character))])
        .collect();
    expected.sort();
    assert_eq!(expected.len(), 5, "four F# uses and one Razor use");

    let uses = references(client, leaders, line, character, false);
    assert_rpc_ok(&uses, "references(Score) without declaration");
    let mut found: Vec<_> = uses["result"]
        .as_array()
        .expect("locations")
        .iter()
        .map(placed)
        .collect();
    found.sort();
    assert_eq!(found, expected);

    let all = references(client, leaders, line, character, true);
    assert_rpc_ok(&all, "references(Score) with declaration");
    let mut with_declaration: Vec<_> = all["result"]
        .as_array()
        .expect("locations")
        .iter()
        .map(placed)
        .collect();
    with_declaration.sort();
    expected.push(at("Scores.fs", locate(scores, "Score: int", "Score")));
    expected.sort();
    assert_eq!(with_declaration, expected);
    assert!(
        all["result"]
            .as_array()
            .expect("locations")
            .iter()
            .all(|location| {
                location["uri"]
                    .as_str()
                    .is_some_and(|uri| !uri.ends_with(".g.cs"))
            }),
        "no generated file: {all}"
    );
}

/// Renaming an F# record field from Razor renames its F# declaration and uses
/// and its Razor use, in one edit. [RAZOR-FSHARP-RENAME]
fn assert_rename_from_razor_renames_fsharp(
    client: &mut LspClient,
    leaders: &str,
    page: &str,
    scores: &str,
) {
    let (line, character) = locate(page, "@player.Score", "Score");
    let prepared = client.request(
        "textDocument/prepareRename",
        json!({ "textDocument": { "uri": leaders }, "position": { "line": line, "character": character } }),
    );
    assert_rpc_ok(&prepared, "prepareRename(Score) in Razor");
    assert_eq!(prepared["result"]["placeholder"], "Score");
    assert_eq!(
        prepared["result"]["range"]["start"],
        json!({ "line": line, "character": character })
    );

    let renamed = rename_request(client, leaders, line, character, "Points");
    assert_rpc_ok(&renamed, "rename(Score) from Razor");
    let changes = renamed["result"]["documentChanges"]
        .as_array()
        .expect("documentChanges")
        .clone();
    let razor = edits_for(&changes, "Leaders.razor");
    assert_eq!(razor.len(), 1, "the Razor use: {renamed}");
    assert_eq!(
        razor[0]["range"]["start"],
        json!({ "line": line, "character": character })
    );
    let fsharp = edits_for(&changes, "Scores.fs");
    assert_eq!(
        fsharp.len(),
        5,
        "the F# declaration and four uses: {renamed}"
    );
    let applied = apply_text_edits(scores, &fsharp);
    assert!(
        applied.contains("Points: int }"),
        "the field is renamed: {applied}"
    );
    assert!(
        !applied.contains(".Score"),
        "every F# use is renamed: {applied}"
    );
    assert!(
        edits_for(&changes, ".g.cs").is_empty(),
        "no generated file: {renamed}"
    );
    assert!(
        fsharp
            .iter()
            .chain(razor.iter())
            .all(|edit| edit["newText"] == "Points"),
        "every edit renames to Points"
    );
}

/// Renaming the F# field from its F# declaration renames the Razor use too.
/// [RAZOR-FSHARP-RENAME] [RENAME-CROSSLANGUAGE]
fn assert_rename_from_fsharp_renames_razor(
    client: &mut LspClient,
    ws: &RazorWorkspace,
    page: &str,
    scores: &str,
) {
    let uri = ws.uri(SCORES);
    client.open_document(&uri, scores);
    let (line, character) = locate(scores, "Score: int", "Score");
    let deadline = std::time::Instant::now() + Duration::from_mins(3);
    let changes = loop {
        let renamed = rename_request(client, &uri, line, character, "Points");
        assert_rpc_ok(&renamed, "rename(Score) from F#");
        let changes = renamed["result"]["documentChanges"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !edits_for(&changes, "Leaders.razor").is_empty() {
            break changes;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "F# rename never reached Razor: {renamed}"
        );
        std::thread::sleep(Duration::from_secs(2));
    };
    assert_eq!(edits_for(&changes, "Scores.fs").len(), 5);
    let razor = edits_for(&changes, "Leaders.razor");
    assert_eq!(razor.len(), 1);
    let (use_line, use_character) = locate(page, "@player.Score", "Score");
    assert_eq!(
        razor[0]["range"]["start"],
        json!({ "line": use_line, "character": use_character })
    );
    assert_eq!(
        edits_for(&changes, ".g.cs"),
        Vec::<Value>::new(),
        "no edit touches a generated file"
    );
}
