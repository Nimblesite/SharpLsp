//! `fsharp.script_arguments` in `sharplsp.toml` reaches the F# compiler: a
//! script is checked as `dotnet fsi` started with those arguments would run
//! it, and a change of the file applies without a restart.
//! Implements [SCRIPT-FSX-ARGUMENTS].

use super::*;

/// Compiles only where `FROM_ARGUMENTS` is defined.
const SCRIPT: &str =
    "#if FROM_ARGUMENTS\nlet answer = 42\n#else\nlet answer: int = \"not a number\"\n#endif\n";

/// The codes of the error diagnostics in `items`.
fn codes(items: &[Value]) -> Vec<&str> {
    items
        .iter()
        .filter_map(|item| item["code"].as_str())
        .collect()
}

#[test]
fn a_script_is_checked_under_the_configured_arguments_and_follows_their_change() {
    require_dotnet();
    let dir = tempfile::tempdir().expect("a folder with one script");
    let root = std::fs::canonicalize(dir.path()).expect("canonical folder");
    let settings = root.join("sharplsp.toml");
    let defined = "[fsharp]\nscript_arguments = [\"--define:FROM_ARGUMENTS\"]\n";
    std::fs::write(&settings, defined).expect("write the settings");
    let script = root.join("Use.fsx");
    std::fs::write(&script, SCRIPT).expect("write the script");
    let uri = path_to_file_uri(&script);

    let mut client = LspClient::spawn_in(Stdio::null(), Some(&root));
    let pulls = json!({"textDocument": {"diagnostic": {}}});
    let initialized = client.initialize_with_capabilities(json!(path_to_file_uri(&root)), pulls);
    assert_rpc_ok(&initialized, "initialize on the folder");
    client.open_document(&uri, SCRIPT);
    let wait = Duration::from_mins(2);

    // 1. The define selects the branch that compiles: the script is clean, and
    //    hover reads the value of that branch.
    let clean =
        poll_error_diagnostics_until(&mut client, &uri, "defined", wait, <[Value]>::is_empty);
    assert!(clean.is_empty(), "checked with the define: {clean:?}");
    let hovered = poll_hover_until_ready(&mut client, &uri, 1, 5, wait);
    let text = hovered["contents"]["value"].as_str().unwrap_or_default();
    assert!(text.contains("answer") && text.contains("int"), "{text}");

    // 2. The arguments are taken away: the other branch is checked, and its
    //    type error is reported where it is.
    std::fs::write(&settings, "[fsharp]\nscript_arguments = []\n").expect("rewrite the settings");
    let broken = poll_error_diagnostics_until(&mut client, &uri, "undefined", wait, |items| {
        !items.is_empty()
    });
    assert_eq!(codes(&broken), ["FS0001"], "the other branch: {broken:?}");
    assert_eq!(broken[0]["range"]["start"]["line"], 3, "on its own line");

    // 3. They return, and the script is clean again.
    std::fs::write(&settings, defined).expect("restore the settings");
    let again = poll_error_diagnostics_until(
        &mut client,
        &uri,
        "defined again",
        wait,
        <[Value]>::is_empty,
    );
    assert!(again.is_empty(), "clean again: {again:?}");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
