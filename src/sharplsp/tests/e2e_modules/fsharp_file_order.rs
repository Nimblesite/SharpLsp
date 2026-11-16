//! E2E for the F# compile-order quick fix ([REFACTOR-FSHARP-FILE-ORDER]) through
//! the host: FS0039 on a name a later file declares offers moving that file
//! above, as a command-only action; the command moves the `Compile` item through
//! the `MSBuild` DOM ([SE-REORDER-FILE-REQUEST]) and the error clears on reload.

use super::fixall_fsharp_tests::write_project;
use super::*;

/// Compiled first, but needs `Defs`.
const USES: &str = "module Order.Uses\n\nlet total = Defs.value + 1\n";
/// Compiled second, declares what `Uses` needs.
const DEFS: &str = "module Order.Defs\n\nlet value = 41\n";
/// The move's exact title.
const MOVE: &str =
    "Move Defs.fs above Uses.fs in Order.fsproj — Defs.fs declares 'Defs' but compiles after Uses.fs";

/// The code actions on `Defs` in `let total = Defs.value + 1`.
fn actions_on_defs(client: &mut LspClient, uri: &str) -> Vec<Value> {
    let resp = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": uri },
            "range": {
                "start": { "line": 2, "character": 12 },
                "end": { "line": 2, "character": 16 }
            },
            "context": { "diagnostics": [] }
        }),
    );
    assert!(resp.get("error").is_none(), "codeAction failed: {resp}");
    resp["result"].as_array().cloned().unwrap_or_default()
}

/// Poll until the move is offered: the project loads asynchronously.
fn poll_move(client: &mut LspClient, uri: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(150);
    loop {
        let actions = actions_on_defs(client, uri);
        if let Some(action) = actions.iter().find(|action| action["title"] == MOVE) {
            return action.clone();
        }
        assert!(
            Instant::now() < deadline,
            "the move was never offered; actions: {actions:?}"
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Run the action's own command, as a client does after applying its edit.
fn run_command(client: &mut LspClient, action: &Value) -> Value {
    client.request(
        "workspace/executeCommand",
        json!({
            "command": action["command"]["command"],
            "arguments": action["command"]["arguments"],
        }),
    )
}

#[test]
fn fsharp_forward_dependency_offers_a_move_that_fixes_the_compile_order() {
    require_dotnet();
    let tmp = tempfile::tempdir().unwrap();
    write_project(
        tmp.path(),
        "Order",
        &[("Uses.fs", USES.to_string()), ("Defs.fs", DEFS.to_string())],
        &[],
    );
    restore_project(&tmp.path().join("Order"));
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let fsproj = root.join("Order").join("Order.fsproj");
    let before = std::fs::read_to_string(&fsproj).unwrap();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(path_to_file_uri(&root)));
    let uri = path_to_file_uri(&root.join("Order").join("Uses.fs"));
    client.open_document(&uri, USES);

    // Interaction 1 — the forward dependency is an error, and its fix is the move.
    let errors = poll_error_diagnostics_until(
        &mut client,
        &uri,
        "forward dependency",
        Duration::from_secs(150),
        |errors| !errors.is_empty(),
    );
    assert_eq!(errors[0]["range"]["start"]["line"], 2, "{errors:?}");
    let action = poll_move(&mut client, &uri);
    assert_eq!(action["kind"], "quickfix", "{action}");
    assert_eq!(action["edit"], json!({}), "a present, empty edit: {action}");
    assert!(action.get("data").is_none(), "nothing to resolve: {action}");
    assert_eq!(
        action["command"]["command"],
        "sharplsp.addReferenceAndImport"
    );
    let reference = &action["command"]["arguments"][0]["reference"];
    assert_eq!(reference["kind"], "compileOrder", "{action}");
    assert_eq!(reference["projectPath"], json!(fsproj.to_string_lossy()));
    assert_eq!(reference["reference"], "Defs.fs", "{action}");
    assert_eq!(reference["version"], "Uses.fs", "{action}");

    // Interaction 2 — the command moves exactly that item through the DOM.
    let moved = run_command(&mut client, &action);
    assert!(moved.get("error").is_none(), "the move failed: {moved}");
    assert_eq!(moved["result"]["message"], "Moved Defs.fs", "{moved}");
    let expected = before.replace(
        "    <Compile Include=\"Uses.fs\" />\n    <Compile Include=\"Defs.fs\" />\n",
        "    <Compile Include=\"Defs.fs\" />\n    <Compile Include=\"Uses.fs\" />\n",
    );
    assert_ne!(expected, before, "the fixture lists Uses.fs first");
    assert_eq!(std::fs::read_to_string(&fsproj).unwrap(), expected);

    // Interaction 3 — the project reloads: no error, and no move left to offer.
    let settled = poll_error_diagnostics_until(
        &mut client,
        &uri,
        "after the move",
        Duration::from_secs(150),
        <[Value]>::is_empty,
    );
    assert!(settled.is_empty(), "{settled:?}");
    let remaining = actions_on_defs(&mut client, &uri);
    assert!(
        remaining.iter().all(|action| action["title"] != MOVE),
        "{remaining:?}"
    );

    // Interaction 4 — the same command again changes nothing and says so.
    let again = run_command(&mut client, &action);
    assert_eq!(
        again["result"]["message"], "Defs.fs is already in place",
        "{again}"
    );
    assert_eq!(std::fs::read_to_string(&fsproj).unwrap(), expected);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
