//! Full-stack navigation on every declaration kind, against the real
//! `tests/fixtures/definition-kinds` solution. Definition: F# functions, types,
//! union cases, record fields and active patterns, type definition of F#
//! values, the implementations of an F# abstract member, and a C# partial
//! class whose definition lists every part. References and highlights: F# union
//! cases, record fields and active patterns, a C# interface member through its
//! override chain, a partial class, an attribute's short form, reads and writes,
//! and an unsaved edit. Every answer is exact, on the name, in its source, never
//! in decompiled metadata. Implements [DEFINITION-FSHARP-CASES],
//! [DEFINITION-FSHARP-TYPE], [DEFINITION-FSHARP-IMPLEMENTATION],
//! [DEFINITION-CSHARP-CASES], [REFERENCES-FSHARP-CASES],
//! [REFERENCES-FSHARP-HIGHLIGHT], [REFERENCES-CSHARP-RESOLUTION] and
//! [REFERENCES-CSHARP-HIGHLIGHT].

use super::definition_cross_language::poll_cross_language_definition;
use super::*;

/// A name in the fixture: its file, 0-based line and column, and its length.
struct Name {
    file: &'static str,
    line: u64,
    character: u64,
    len: u64,
}

const fn name(file: &'static str, line: u64, character: u64, len: u64) -> Name {
    Name {
        file,
        line,
        character,
        len,
    }
}

const KINDS: &str = "FsKinds/Kinds.fs";
const USES: &str = "FsKinds/Uses.fs";
const SHAPES: &str = "CsPartials/Shapes.cs";
const USE_CS: &str = "CsPartials/Use.cs";
const POINT: Name = name(KINDS, 3, 5, 5);
const POINT_X: Name = name(KINDS, 3, 15, 1);
const SHAPE: Name = name(KINDS, 5, 5, 5);
const CIRCLE: Name = name(KINDS, 6, 6, 6);
const EVEN: Name = name(KINDS, 9, 6, 4);
/// The active pattern function `(|Even|Odd|)` its cases are declared by.
const EVEN_ODD: Name = name(KINDS, 9, 5, 10);
const EVEN_RESULT: Name = name(KINDS, 9, 46, 4);
const EVEN_MATCH: Name = name(KINDS, 13, 6, 4);
const PARITY: Name = name(KINDS, 11, 4, 6);
const ANIMAL: Name = name(KINDS, 17, 5, 6);
const DOG_SPEAK: Name = name(KINDS, 22, 15, 5);
const CAT_SPEAK: Name = name(KINDS, 26, 15, 5);
const DESCRIBE_PARITY: Name = name(KINDS, 28, 26, 6);
const DESCRIBE_X: Name = name(KINDS, 28, 35, 1);
const ORIGIN_X: Name = name(USES, 5, 22, 1);
const SHAPE_CIRCLE: Name = name(USES, 6, 12, 6);
const SHAPE_VALUE: Name = name(USES, 6, 4, 5);
const LABEL_PARITY: Name = name(USES, 7, 12, 6);
const LABEL_X: Name = name(USES, 7, 26, 1);
const ODD_EVEN: Name = name(USES, 11, 23, 4);
const RADIUS_CIRCLE: Name = name(USES, 12, 30, 6);
const AGAIN_PARITY: Name = name(USES, 13, 12, 6);
const WIDGET_LAYOUT: Name = name("CsPartials/Widget.Layout.cs", 3, 21, 6);
const WIDGET_BEHAVIOR: Name = name("CsPartials/Widget.Behavior.cs", 3, 21, 6);
const WIDGET_AREA: Name = name("CsPartials/Widget.Behavior.cs", 5, 15, 4);
const WIDGET_WIDTH: Name = name("CsPartials/Widget.Layout.cs", 5, 15, 5);
const MEASURE_WIDGET: Name = name(USE_CS, 4, 30, 6);
const ISHAPE_AREA: Name = name(SHAPES, 5, 11, 4);
const POLYGON_AREA: Name = name(SHAPES, 10, 27, 4);
const SQUARE_AREA: Name = name(SHAPES, 15, 27, 4);
const MARKER_USE: Name = name(SHAPES, 18, 1, 6);
const MARKER: Name = name(SHAPES, 21, 20, 15);
const SHAPE_CALL: Name = name(USE_CS, 7, 14, 4);
const POLYGON_CALL: Name = name(USE_CS, 7, 31, 4);
const SQUARE_CALL: Name = name(USE_CS, 7, 47, 4);
const TOTAL_DECLARED: Name = name(USE_CS, 11, 12, 5);
const TOTAL_ADDED: Name = name(USE_CS, 12, 8, 5);
const TOTAL_RETURNED: Name = name(USE_CS, 13, 15, 5);

/// Every use of the active pattern case `Even`: its declaration, the pattern's
/// own result, a match in its file and one in another.
const USES_OF_EVEN: [&Name; 4] = [&EVEN, &EVEN_RESULT, &EVEN_MATCH, &ODD_EVEN];

/// LSP `DocumentHighlightKind.Read`.
const READ: u64 = 2;
/// LSP `DocumentHighlightKind.Write`.
const WRITE: u64 = 3;

/// How long a cold solution may take before its first cross-file answer.
const LOAD: Duration = Duration::from_mins(3);

/// `range` spans exactly `name`.
fn assert_spans(range: &Value, name: &Name, what: &str) {
    let at = |end: &str| {
        (
            range[end]["line"].as_u64(),
            range[end]["character"].as_u64(),
        )
    };
    let start = (Some(name.line), Some(name.character));
    assert_eq!(at("start"), start, "{what}: starts on the name: {range}");
    let end = (Some(name.line), Some(name.character + name.len));
    assert_eq!(at("end"), end, "{what}: ends on the name: {range}");
}

/// `loc` is exactly `name`, in its own source file.
fn assert_on(loc: &Value, name: &Name, what: &str) {
    let uri = loc["uri"].as_str().unwrap_or_default();
    assert!(uri.ends_with(name.file), "{what}: in {}: {loc}", name.file);
    assert!(
        !uri.contains("sharplsp-decompiled"),
        "{what}: never decompiled: {loc}"
    );
    assert_spans(&loc["range"], name, what);
}

/// The items of an answer, in order of `key`.
fn sorted_items<K: Ord>(resp: &Value, key: impl Fn(&Value) -> K) -> Vec<Value> {
    assert_nav_ok(resp);
    let mut found = match &resp["result"] {
        Value::Array(items) => items.clone(),
        Value::Null => Vec::new(),
        single => vec![single.clone()],
    };
    found.sort_by_key(key);
    found
}

/// Where a range starts.
fn start_of(range: &Value) -> (Option<u64>, Option<u64>) {
    (
        range["start"]["line"].as_u64(),
        range["start"]["character"].as_u64(),
    )
}

/// `resp` answers exactly `names`, given in file, line and column order.
fn assert_answers(resp: &Value, names: &[&Name], what: &str) {
    let found = sorted_items(resp, |loc| {
        (loc["uri"].to_string(), start_of(&loc["range"]))
    });
    assert_eq!(
        found.len(),
        names.len(),
        "{what}: one location per name: {found:?}"
    );
    for (loc, name) in found.iter().zip(names) {
        assert_on(loc, name, what);
    }
}

/// `resp` highlights exactly `names`, in line order, each with its kind.
fn assert_highlights(resp: &Value, names: &[(&Name, u64)], what: &str) {
    let found = sorted_items(resp, |highlight| start_of(&highlight["range"]));
    assert_eq!(
        found.len(),
        names.len(),
        "{what}: one highlight per use: {found:?}"
    );
    for (highlight, (name, kind)) in found.iter().zip(names) {
        assert_spans(&highlight["range"], name, what);
        assert_eq!(
            highlight["kind"].as_u64(),
            Some(*kind),
            "{what}: kind of {highlight}"
        );
    }
}

/// A host on a restored copy of the fixture, `Uses.fs` and `Kinds.fs` open.
fn session() -> (tempfile::TempDir, PathBuf, LspClient, String, String) {
    require_dotnet();
    let ws = copied_fixture("definition-kinds", true);
    let root = std::fs::canonicalize(ws.path()).expect("canonical fixture root");
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(path_to_file_uri(&root)));
    let uses = open_fixture_file(&mut client, &root, USES);
    let kinds = open_fixture_file(&mut client, &root, KINDS);
    (ws, root, client, uses, kinds)
}

fn end(mut client: LspClient) {
    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// F# definition from `Uses.fs` onto each kind declared in `Kinds.fs`.
fn fsharp_definitions(client: &mut LspClient, uses: &str) {
    let first = poll_cross_language_definition(client, uses, 5, 12, "Uses.fs", LOAD);
    assert_on(&first, &POINT, "type annotation → record type");
    let cases: [(u32, u32, &Name, &str); 7] = [
        (5, 22, &POINT_X, "record expression field → field"),
        (6, 12, &CIRCLE, "union case construction → case"),
        (7, 12, &PARITY, "function call → let binding"),
        (7, 26, &POINT_X, "field access → field"),
        (9, 9, &ANIMAL, "abstract class annotation → type"),
        (11, 23, &EVEN_ODD, "active pattern case → pattern function"),
        (8, 11, &SHAPE_VALUE, "value → its let binding"),
    ];
    for (line, character, declared, what) in cases {
        assert_answers(
            &definition(client, uses, line, character),
            &[declared],
            what,
        );
    }
}

/// F# type definition of values, and the implementations of an abstract member.
fn fsharp_types_and_implementations(client: &mut LspClient, uses: &str, kinds: &str) {
    let shape = type_definition(client, uses, 8, 11);
    assert_answers(&shape, &[&SHAPE], "union value → union type");
    let origin = type_definition(client, uses, 7, 19);
    assert_answers(&origin, &[&POINT], "record value → record type");
    let overrides = [&DOG_SPEAK, &CAT_SPEAK];
    let from_call = implementation(client, uses, 10, 15);
    assert_answers(&from_call, &overrides, "abstract call → every override");
    let from_slot = implementation(client, kinds, 18, 13);
    assert_answers(&from_slot, &overrides, "abstract slot → every override");
}

/// C# definition of a partial class lists every part; its members land in theirs.
fn csharp_partials(client: &mut LspClient, use_cs: &str) {
    let first = poll_cross_language_definition(client, use_cs, 4, 30, "Use.cs", LOAD);
    let uri = first["uri"].as_str().unwrap_or_default();
    assert!(uri.contains("Widget."), "the class, in a part: {first}");
    let parts = definition(client, use_cs, 4, 30);
    let both = [&WIDGET_BEHAVIOR, &WIDGET_LAYOUT];
    assert_answers(&parts, &both, "partial class → every part");
    let area = definition(client, use_cs, 4, 55);
    assert_answers(&area, &[&WIDGET_AREA], "method → the part declaring it");
    let width = definition(client, use_cs, 4, 71);
    assert_answers(&width, &[&WIDGET_WIDTH], "property → the part declaring it");
}

#[test]
fn every_declaration_kind_navigates_to_its_source_name_in_fsharp_and_csharp() {
    let (_ws, root, mut client, uses, kinds) = session();
    fsharp_definitions(&mut client, &uses);
    fsharp_types_and_implementations(&mut client, &uses, &kinds);
    let use_cs = open_fixture_file(&mut client, &root, USE_CS);
    csharp_partials(&mut client, &use_cs);
    end(client);
}

/// F# references to a function, a union case, a record field and an active pattern case.
fn fsharp_references(client: &mut LspClient, uses: &str) {
    let _ = poll_cross_language_definition(client, uses, 7, 12, "Uses.fs", LOAD);
    let parity = [&PARITY, &DESCRIBE_PARITY, &LABEL_PARITY];
    let all = references(client, uses, 7, 12, true);
    assert_answers(&all, &parity, "function → declaration and every call");
    let calls = references(client, uses, 7, 12, false);
    assert_answers(
        &calls,
        &parity[1..],
        "function → every call, no declaration",
    );
    let circle = references(client, uses, 6, 12, true);
    let uses_of_circle = [&CIRCLE, &SHAPE_CIRCLE, &RADIUS_CIRCLE];
    assert_answers(
        &circle,
        &uses_of_circle,
        "union case → construction and match",
    );
    let field = references(client, uses, 7, 26, true);
    let uses_of_x = [&POINT_X, &DESCRIBE_X, &ORIGIN_X, &LABEL_X];
    assert_answers(
        &field,
        &uses_of_x,
        "record field → record expression and access",
    );
    let even = references(client, uses, 11, 23, true);
    assert_answers(&even, &USES_OF_EVEN, "active pattern case → every use");
}

/// F# highlights: definitions and pattern uses write, other uses read.
fn fsharp_highlights(client: &mut LspClient, kinds: &str) {
    let parity = document_highlight(client, kinds, 11, 4);
    let expected = [(&PARITY, WRITE), (&DESCRIBE_PARITY, READ)];
    assert_highlights(
        &parity,
        &expected,
        "function: declaration writes, call reads",
    );
    // From the case's own name in `(|Even|Odd|)`: the case, not the pattern function.
    let declared = references(client, kinds, 9, 6, true);
    assert_answers(
        &declared,
        &USES_OF_EVEN,
        "active pattern case, from its own name",
    );
    let even = document_highlight(client, kinds, 9, 6);
    // FCS counts the case the pattern's own body returns as part of its definition.
    let expected = [(&EVEN, WRITE), (&EVEN_RESULT, WRITE), (&EVEN_MATCH, WRITE)];
    assert_highlights(
        &even,
        &expected,
        "active pattern case: definition and match write",
    );
}

/// An unsaved call to `parity` is a reference before it is saved.
fn fsharp_references_after_edit(client: &mut LspClient, root: &Path, uses: &str) {
    let saved = std::fs::read_to_string(root.join(USES)).expect("read Uses.fs");
    client.change_document(uses, 2, &format!("{saved}let again = parity 4\n"));
    let calls = [&DESCRIBE_PARITY, &LABEL_PARITY, &AGAIN_PARITY];
    let found = references(client, uses, 7, 12, false);
    assert_answers(&found, &calls, "the unsaved call is a reference");
}

/// C# references through an override chain, a partial class and an attribute.
fn csharp_references(client: &mut LspClient, use_cs: &str, shapes: &str) {
    let _ = poll_cross_language_definition(client, use_cs, 4, 30, "Use.cs", LOAD);
    let widget = references(client, use_cs, 4, 30, true);
    let parts = [&MEASURE_WIDGET, &WIDGET_BEHAVIOR, &WIDGET_LAYOUT];
    assert_answers(&widget, &parts, "partial class → every part and use");
    let chain = [&ISHAPE_AREA, &POLYGON_AREA, &SQUARE_AREA];
    let calls = [&SHAPE_CALL, &POLYGON_CALL, &SQUARE_CALL];
    let everything: Vec<&Name> = chain.iter().chain(&calls).copied().collect();
    let from_interface = references(client, use_cs, 7, 14, true);
    assert_answers(
        &from_interface,
        &everything,
        "interface member → chain and calls",
    );
    let from_override = references(client, shapes, 15, 27, true);
    assert_answers(&from_override, &everything, "override → chain and calls");
    let only_calls = references(client, use_cs, 7, 14, false);
    assert_answers(
        &only_calls,
        &calls,
        "interface member → calls, no declarations",
    );
    let marker = references(client, shapes, 21, 20, true);
    let forms = [&MARKER_USE, &MARKER];
    assert_answers(
        &marker,
        &forms,
        "attribute class → its short form `[Marker]`",
    );
}

/// C# highlights tell a variable's writes from its reads.
fn csharp_highlights(client: &mut LspClient, use_cs: &str) {
    let total = document_highlight(client, use_cs, 11, 12);
    let expected = [
        (&TOTAL_DECLARED, WRITE),
        (&TOTAL_ADDED, WRITE),
        (&TOTAL_RETURNED, READ),
    ];
    assert_highlights(&total, &expected, "variable: declaration and `+=` write");
}

#[test]
fn references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp() {
    let (_ws, root, mut client, uses, kinds) = session();
    fsharp_references(&mut client, &uses);
    fsharp_highlights(&mut client, &kinds);
    fsharp_references_after_edit(&mut client, &root, &uses);
    let use_cs = open_fixture_file(&mut client, &root, USE_CS);
    let shapes = open_fixture_file(&mut client, &root, SHAPES);
    csharp_references(&mut client, &use_cs, &shapes);
    csharp_highlights(&mut client, &use_cs);
    end(client);
}
