use super::*;

// STATEMENT STOP CLASSIFICATION — the syntactic half of brace elision.
//
// Implements [DEBUG-FEATURES-STEPPING]. `sharplsp/statementStop` answers, for
// one debugger stop position, whether the debuggee is parked on code or on
// pure block punctuation. The DAP router steps past everything this call says
// is not a statement, so a wrong answer here is either a step that visibly
// does nothing or a step that skips a line the user asked to see.

/// A C# method whose braces, block braces and statements are all addressable.
const BRACED_CSHARP: &str = r"public static class Program
{
    public static int Add(int left, int right)
    {
        var sum = left + right;
        for (var index = 0; index < 1; index++)
        {
            sum += index;
        }
        return sum;
    }
}
";

/// The F# mirror. `main` returns the ONE-CHARACTER literal `0`, which the
/// debugger reports with exactly the same one-character span as a C# `{`.
const ONE_CHARACTER_FSHARP: &str = r#"module Probe

let compute seed =
    let mutable running = seed
    running

[<EntryPoint>]
let main argv =
    let total = compute argv.Length
    printfn "%d" total
    0
"#;

/// Ask the server how it classifies one zero-based position.
fn statement_at(client: &mut LspClient, uri: &str, line: u32, character: u32) -> bool {
    let resp = client.request(
        "sharplsp/statementStop",
        json!({ "uri": uri, "line": line, "character": character }),
    );
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    resp["result"]["statement"]
        .as_bool()
        .unwrap_or_else(|| panic!("statementStop must answer with a boolean: {resp}"))
}

/// C#: every brace the compiler emits a sequence point for is NOT a statement,
/// and every line of real code is. A method's `{`, a block's `{` and `}`, and
/// the method's closing `}` are all stops the user must never be parked on.
#[test]
fn csharp_braces_are_not_statements_and_code_is() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, BRACED_CSHARP);

    assert!(
        !statement_at(&mut client, TEST_URI, 3, 4),
        "the opening brace of a method body is structure, not a statement — a step into Add \
         must not come to rest on it"
    );
    assert!(
        statement_at(&mut client, TEST_URI, 4, 8),
        "`var sum = left + right;` is the first statement of Add and must be reported as one"
    );
    assert!(
        statement_at(&mut client, TEST_URI, 5, 8),
        "a `for` header is code the user steps through"
    );
    assert!(
        !statement_at(&mut client, TEST_URI, 6, 8),
        "the opening brace of a `for` BODY is structure too — brace elision is not limited to \
         method braces"
    );
    assert!(
        !statement_at(&mut client, TEST_URI, 8, 8),
        "the closing brace of a block is structure"
    );
    assert!(
        statement_at(&mut client, TEST_URI, 9, 8),
        "`return sum;` is the last statement of Add and must be reported as one"
    );
    assert!(
        !statement_at(&mut client, TEST_URI, 10, 4),
        "the closing brace of a method is structure — stepping off the last statement must walk \
         past it into the caller"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// F#: a ONE-CHARACTER expression is a statement.
///
/// This is the case that makes a parse mandatory. [DEBUG-MISSION] requires the
/// same specified behaviour for C# and F#, and the debugger reports F#'s `0`
/// return with the identical one-character span it reports a C# `{` with — so
/// any rule based on the span alone, or on the shape of the text, would silently
/// skip the last line of every F# program.
#[test]
fn fsharp_one_character_expression_is_a_statement() {
    let mut client = LspClient::start();
    let fs_uri = "file:///test/Probe.fs";
    let _ = client.initialize();
    client.open_document(fs_uri, ONE_CHARACTER_FSHARP);

    assert!(
        statement_at(&mut client, fs_uri, 10, 4),
        "F#'s `0` return is a one-character EXPRESSION; classifying it as punctuation would make \
         a step skip the last line of the program"
    );
    assert!(
        statement_at(&mut client, fs_uri, 4, 4),
        "`running` is the return expression of `compute` and is code"
    );
    assert!(
        statement_at(&mut client, fs_uri, 3, 4),
        "`let mutable running = seed` is code"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// An unresolvable position must be reported as a STATEMENT.
///
/// The caller HIDES whatever this call says is not one, so "I do not know" must
/// never be the answer that hides a stop from the user.
#[test]
fn an_unresolvable_position_is_reported_as_a_statement() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, BRACED_CSHARP);

    assert!(
        statement_at(&mut client, TEST_URI, 9_000, 0),
        "a line past the end of the file cannot be proven to be punctuation, so the stop stands"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
