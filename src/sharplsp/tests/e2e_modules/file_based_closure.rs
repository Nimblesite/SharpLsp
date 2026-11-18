//! A file-based app's `#:include` closure as the editor sees it: a member the
//! editor never opened reports its errors while it is included, and stops
//! reporting them the moment an edit of the root drops it.
//! Implements [SCRIPT-RELOAD-CLOSURE].

use super::*;

/// The root with its include: it prints the helper's value.
const INCLUDING: &str = "#:include Helper.cs\nSystem.Console.WriteLine(Helper.Value);\n";
/// The root without it.
const ALONE: &str = "System.Console.WriteLine(1);\n";
/// The helper: a `string` returned as an `int` (CS0029).
const HELPER: &str = "static class Helper\n{\n    public static int Value => \"text\";\n}\n";

/// The codes the server next publishes for `uri` that satisfy `accept`. The
/// app's implicit usings are a synthetic document and are never published.
fn published(client: &mut LspClient, uri: &str, accept: impl Fn(&[&str]) -> bool) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_mins(2);
    loop {
        let wait = deadline.saturating_duration_since(Instant::now());
        let message = client.wait_for_notification("textDocument/publishDiagnostics", wait);
        let codes: Vec<&str> = message["params"]["diagnostics"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["code"].as_str())
            .collect();
        let about = message["params"]["uri"].as_str().unwrap_or_default();
        assert!(
            !about.ends_with(".g.cs"),
            "nothing is published for a file the user does not have: {about}"
        );
        if about == uri && accept(&codes) {
            return codes.into_iter().map(str::to_owned).collect();
        }
    }
}

#[test]
fn a_file_leaving_the_include_closure_has_its_published_diagnostics_cleared() {
    require_dotnet();
    let dir = tempfile::tempdir().expect("a folder holding one file-based app");
    let root = std::fs::canonicalize(dir.path()).expect("canonical folder");
    let helper = root.join("Helper.cs");
    std::fs::write(&helper, HELPER).expect("write the helper");
    let app = root.join("App.cs");
    std::fs::write(&app, INCLUDING).expect("write the app");
    let (app_uri, helper_uri) = (path_to_file_uri(&app), path_to_file_uri(&helper));
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&root));
    assert_rpc_ok(&client.initialize(), "initialize without a workspace root");
    client.open_document(&app_uri, INCLUDING);
    let conversion = |codes: &[&str]| codes.contains(&"CS0029");

    // 1. Included: the helper's error is published on the helper, which the
    //    editor never opened.
    let included = published(&mut client, &helper_uri, conversion);
    assert_eq!(included, ["CS0029"], "the helper's one error");

    // 2. The root drops the include: the helper left the closure, so what
    //    was published for it is cleared, and the root has no error.
    client.change_document(&app_uri, 2, ALONE);
    let left = published(&mut client, &helper_uri, |codes| !conversion(codes));
    assert!(left.is_empty(), "cleared, not replaced: {left:?}");
    let alone = pull_error_diagnostics(&mut client, &app_uri, "the root alone");
    assert!(alone.is_empty(), "the root alone is clean: {alone:?}");

    // 3. The include returns, and so does the helper's error.
    client.change_document(&app_uri, 3, INCLUDING);
    let back = published(&mut client, &helper_uri, conversion);
    assert_eq!(back, ["CS0029"], "published again");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
