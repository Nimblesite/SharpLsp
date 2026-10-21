//! Full-stack cross-language go-to-definition: C# ↔ F#.
//!
//! A C# project and an F# project reference each other across the language
//! boundary. Navigating from a use site into the other-language definition
//! lands in its source: F# compiles the C# project in memory, and C# names the
//! F# symbol it reads from the DLL by its identity, which the F# sidecar
//! places in the `.fs` file. Implements [DEFINITION-CROSSLANG] and
//! [DEFINITION-CROSSLANG-IDENTITY].

use super::*;

/// Poll go-to-definition until it resolves to a location **outside** the
/// consumer file (`exclude_suffix`).
///
/// Before the workspace finishes loading, the sidecar can only see local
/// symbols, so a definition on a not-yet-resolved cross-language reference
/// falls through to the enclosing local declaration in the same file. Polling
/// until the result leaves that file distinguishes "still loading / unresolved"
/// from a genuine cross-language resolution, and fails loudly on timeout.
fn poll_cross_language_definition(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
    exclude_suffix: &str,
    timeout: Duration,
) -> Value {
    std::thread::sleep(Duration::from_secs(5));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let resp = definition(client, uri, line, character);
        assert_nav_ok(&resp);
        let result = &resp["result"];
        if !result.is_null() {
            let loc = first_location(result);
            if loc["uri"]
                .as_str()
                .is_some_and(|u| !u.ends_with(exclude_suffix))
            {
                return loc;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "cross-language definition did not resolve outside {exclude_suffix} within {}s",
            timeout.as_secs(),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

// ── C# → F# ──────────────────────────────────────────────────────────

// FULL-STACK: go-to-definition from C# onto an F#-defined type lands on its
// declaration in the F# source, not in decompiled source or the C# consumer.
#[test]
fn test_cross_language_definition_csharp_to_fsharp() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_cross_language_cs_to_fs_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // `Shape` is defined in the F# project; the cursor sits on it in
    //     `        var s = new Shape("triangle", 3);`  (line 8)
    //      0         1         2
    //      0123456789012345678901234
    let loc = poll_cross_language_definition(
        &mut client,
        &file_uri,
        8,
        22,
        "Program.cs",
        Duration::from_mins(3),
    );

    let uri = loc["uri"].as_str().unwrap();
    assert!(
        uri.contains("Shape"),
        "C#→F# definition must land on the F#-defined `Shape` type, got: {uri}"
    );

    // Once the F# sidecar has loaded, the answer is the F# declaration: the
    // decompiled answer before it is never cached. [DEFINITION-CROSSLANG-IDENTITY]
    let source = poll_cross_language_definition(
        &mut client,
        &file_uri,
        8,
        22,
        ".cs",
        Duration::from_mins(3),
    );
    let uri = source["uri"].as_str().unwrap();
    assert!(
        uri.ends_with("/Shapes.fs"),
        "C#→F# lands in the F# source, got: {uri}"
    );
    // `type Shape(name: string, sides: int) =` (line 3)
    //  0123456789
    assert_eq!(
        source["range"]["start"],
        json!({ "line": 3, "character": 5 })
    );
    assert_eq!(
        source["range"]["end"],
        json!({ "line": 3, "character": 10 })
    );

    // With the F# sidecar loaded, a C# local has no cross-language identity, so
    // its references are C#'s alone: the declaration and its one use.
    // [REFERENCES-CROSS-LANGUAGE]
    let local = references(&mut client, &file_uri, 8, 12, true);
    let starts: Vec<(Value, Value)> = local["result"]
        .as_array()
        .map(|found| {
            found
                .iter()
                .map(|at| (at["uri"].clone(), at["range"]["start"].clone()))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        starts,
        vec![
            (json!(file_uri), json!({ "line": 8, "character": 12 })),
            (json!(file_uri), json!({ "line": 9, "character": 15 })),
        ],
        "the local's references stay in C#: {local}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# → C# ──────────────────────────────────────────────────────────

// FULL-STACK: go-to-definition from F# onto a C#-defined type resolves into
// the C# assembly (decompiled metadata-as-source), not the F# consumer file.
#[test]
fn test_cross_language_definition_fsharp_to_csharp() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_cross_language_fs_to_cs_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Readiness: hover on the purely-local `localName` binding (line 4) — this
    // depends only on the F# project loading, not on the C# reference.
    //     `let localName = "World"`
    //      0123456789012
    let _ = poll_hover_until_ready(&mut client, &file_uri, 4, 8, Duration::from_mins(3));

    // `Greeter` is defined in the C# project; the cursor sits on it in
    //     `let greeter = Greeter()`  (line 5)
    //      0         1
    //      01234567890123456789
    let loc = poll_cross_language_definition(
        &mut client,
        &file_uri,
        5,
        16,
        "Program.fs",
        Duration::from_mins(3),
    );

    let uri = loc["uri"].as_str().unwrap();
    assert!(
        uri.contains("Greeter"),
        "F#→C# definition must land on the C#-defined `Greeter` type, got: {uri}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
