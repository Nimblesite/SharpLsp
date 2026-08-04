//! Full-stack e2e for `sharplsp/nuget/unused`: load a real solution into the
//! Roslyn sidecar and prove an unused `PackageReference` is detected through
//! the live compilation. Implements [PKG-UNUSED-DETECT-CS] / [PKG-UNUSED-REQUEST].

use super::*;

/// Poll the unused query until the solution has finished loading into the
/// sidecar (success result) or the timeout elapses. `loadSolution` is async, so
/// the project resolves a few seconds after the request returns.
fn poll_unused_until_ready(client: &mut LspClient, project_path: &str, timeout: Duration) -> Value {
    std::thread::sleep(Duration::from_secs(5));
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let resp = client.request(
            "sharplsp/nuget/unused",
            json!({ "projectPath": project_path }),
        );
        if resp.get("error").is_none() {
            return resp["result"].clone();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "unused query never succeeded within {}s — sidecar did not load the solution: {resp}",
            timeout.as_secs(),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

#[test]
fn test_full_stack_unused_packages_detects_newtonsoft() {
    require_dotnet();

    let (_tmp, root_uri, sln_path, csproj_path, file_uri, source) =
        create_unused_packages_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Warm the sidecar on the open document, mirroring the other full-stack
    // tests, so the subsequent loadSolution lands on a live Roslyn workspace.
    let _ = poll_hover_until_ready(&mut client, &file_uri, 2, 18, Duration::from_secs(90));

    let load = client.request("sharplsp/loadSolution", json!({ "solutionPath": sln_path }));
    assert_eq!(load["jsonrpc"], "2.0", "loadSolution is JSON-RPC 2.0");
    assert!(
        load.get("error").is_none(),
        "loadSolution must not error: {load}"
    );

    let result = poll_unused_until_ready(&mut client, &csproj_path, Duration::from_secs(90));

    // The response echoes the analysed project path.
    assert_eq!(
        result["projectPath"].as_str(),
        Some(csproj_path.as_str()),
        "response echoes the analysed project path"
    );

    // Newtonsoft.Json is referenced but never used → it must be flagged.
    let unused = result["unused"].as_array().expect("unused array");
    assert!(
        unused
            .iter()
            .any(|p| p["id"].as_str() == Some("Newtonsoft.Json")),
        "Newtonsoft.Json is referenced but unused — it must be flagged: {unused:?}"
    );
    let newtonsoft = unused
        .iter()
        .find(|p| p["id"].as_str() == Some("Newtonsoft.Json"))
        .expect("Newtonsoft.Json present (asserted above)");
    assert_eq!(
        newtonsoft["version"].as_str(),
        Some("13.0.3"),
        "the declared version is reported back: {newtonsoft}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
