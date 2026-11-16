//! The tree-sitter pre-validation budget of [DEFINITION-PERFORMANCE],
//! [REFERENCES-PERFORMANCE] and [HOVER-PERFORMANCE]: a position in a comment or
//! string literal is rejected in under a millisecond, with no sidecar asked,
//! on a file large enough to make a linear scan visible.
#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use lsp_server::RequestId;
use lsp_types::request::{GotoDefinition, Request as _};
use serde_json::json;

use super::*;

/// One generated member: a line comment, then a method holding a string.
const MEMBER_LINES: u32 = 5;
/// Members in the file: 4,000 members is 20,000 lines of C#.
const MEMBERS: u32 = 4_000;

/// A large, valid C# file with a comment and a string literal in every member.
fn large_source() -> String {
    let mut source = String::from("namespace Bench;\npublic static class Large\n{\n");
    for index in 0..MEMBERS {
        let _ = write!(
            source,
            "    // member {index} documents itself\n    public static string Member{index}()\n    {{\n        return \"value {index}\";\n    }}\n"
        );
    }
    source.push_str("}\n");
    source
}

/// A definition request at `line`/`character` of the benchmark document.
fn request_at(uri: &Uri, line: u32, character: u32) -> Request {
    Request::new(
        RequestId::from(1),
        GotoDefinition::METHOD.to_string(),
        json!({
            "textDocument": { "uri": uri.as_str() },
            "position": { "line": line, "character": character },
        }),
    )
}

/// The median of `samples` calls of `probe`, with every call's answer checked.
fn median_latency(samples: usize, expected: bool, probe: impl Fn() -> bool) -> Duration {
    let mut timings: Vec<Duration> = (0..samples)
        .map(|_| {
            let started = Instant::now();
            let answer = probe();
            let elapsed = started.elapsed();
            assert_eq!(answer, expected, "the pre-validation answer is stable");
            elapsed
        })
        .collect();
    timings.sort_unstable();
    timings.get(samples >> 1).copied().unwrap()
}

#[test]
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
fn non_symbol_positions_are_rejected_in_under_a_millisecond_on_a_large_file() {
    let source = large_source();
    assert!(source.lines().count() > 20_000, "a file worth measuring");
    let uri: Uri = "file:///bench/Large.cs".parse().unwrap();
    let tree = TsParsers::new()
        .parse(LangId::CSharp, &source, None)
        .unwrap();
    assert!(
        !tree.root_node().has_error(),
        "the benchmark file parses clean"
    );
    let trees = HashMap::from([(uri.clone(), tree)]);

    // The last member, the worst case for anything that walks from the top.
    let member = 3 + (MEMBERS - 1) * MEMBER_LINES;
    let budget = Duration::from_millis(1);
    for (label, line, character, expected) in [
        ("comment", member, 10, true),
        ("string literal", member + 3, 20, true),
        ("method name", member + 1, 30, false),
        ("return keyword", member + 3, 10, false),
        ("first comment", 3, 10, true),
    ] {
        let request = request_at(&uri, line, character);
        let median = median_latency(201, expected, || is_non_symbol_position(&request, &trees));
        assert!(
            median < budget,
            "{label}: pre-validation took {median:?}, over the {budget:?} budget"
        );
    }

    // A document the host has no tree for is never rejected here: the sidecar decides.
    let unknown: Uri = "file:///bench/Unknown.cs".parse().unwrap();
    assert!(!is_non_symbol_position(
        &request_at(&unknown, 3, 10),
        &trees
    ));
}

/// Every literal and comment shape of both languages, one per line, with the
/// column to probe and whether a symbol can sit there.
const CSHARP_SHAPES: &[(&str, u32, bool)] = &[
    ("class Shapes {", 8, false),
    ("    string a = \"plain text\";", 20, true),
    ("    string b = \"tab\\there\";", 20, true),
    ("    string c = @\"verbatim text\";", 22, true),
    ("    string d = \"\"\"raw text\"\"\";", 22, true),
    ("    char e = 'x';", 14, true),
    ("    string f = $\"text {a} more\";", 18, true),
    ("    string g = $\"text {a} more\";", 23, false),
    ("    /* block */ int h = 1;", 8, true),
    ("    int i = 1; // trailing", 18, true),
    ("    int j = i;", 12, false),
    ("}", 0, false),
];

/// The same for F#, whose grammar names its comments and strings differently.
const FSHARP_SHAPES: &[(&str, u32, bool)] = &[
    ("module Shapes", 9, false),
    ("let a = \"plain text\"", 12, true),
    ("let b = @\"verbatim text\"", 14, true),
    ("let c = \"\"\"triple text\"\"\"", 15, true),
    ("let d = 'x'", 9, true),
    ("let e = $\"text {a} more\"", 12, true),
    ("let f = $\"text {a} more\"", 17, false),
    ("// line comment", 6, true),
    ("(* block comment *)", 6, true),
    ("let g = a", 8, false),
];

/// F# first: comments and every string shape are rejected in both grammars,
/// while a name — in code, or in an interpolation hole — is never rejected.
#[test]
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
fn comments_and_every_string_shape_are_rejected_and_names_never_are() {
    for (language, name, shapes) in [
        (LangId::FSharp, "Shapes.fs", FSHARP_SHAPES),
        (LangId::CSharp, "Shapes.cs", CSHARP_SHAPES),
    ] {
        let source: String = shapes.iter().fold(String::new(), |mut text, (line, _, _)| {
            let _ = writeln!(text, "{line}");
            text
        });
        let uri: Uri = format!("file:///shapes/{name}").parse().unwrap();
        let tree = TsParsers::new().parse(language, &source, None).unwrap();
        assert!(
            !tree.root_node().has_error(),
            "{name} parses clean:\n{source}"
        );
        let trees = HashMap::from([(uri.clone(), tree)]);
        for (line, (text, character, rejected)) in (0_u32..).zip(shapes) {
            assert_eq!(
                is_non_symbol_position(&request_at(&uri, line, *character), &trees),
                *rejected,
                "{name} line {line} column {character}: {text}"
            );
        }
    }
}
