use super::*;

// ── Standalone .csproj (no .sln) — Hover & Definition ───────────

// create_standalone_csproj_workspace lives in `fixtures` (re-exported via super::*).

/// Hover must return content for a standalone `.csproj` workspace (no `.sln`).
/// This is the layout used by `code serve-web` for screenshots.
#[test]
fn test_full_stack_hover_standalone_csproj_no_sln() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_standalone_csproj_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Hover on "Calculator" class name (line 2, char 14).
    let result = poll_hover_until_ready(&mut client, &file_uri, 2, 14, Duration::from_secs(90));

    let contents = &result["contents"];
    assert_eq!(contents["kind"], "markdown", "contents must be markdown");
    let value = contents["value"].as_str().unwrap();
    assert!(
        value.contains("Calculator"),
        "hover on class must mention Calculator, got: {value}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Go to definition must return a location for a standalone `.csproj`
/// workspace (no `.sln`).
#[test]
fn test_full_stack_definition_standalone_csproj_no_sln() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_standalone_csproj_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar to load before requesting definition.
    let _ = poll_hover_until_ready(&mut client, &file_uri, 2, 14, Duration::from_secs(90));

    // Definition on "Add" method name (line 4, char 16).
    let resp = definition(&mut client, &file_uri, 4, 16);
    assert_nav_ok(&resp);
    let result = &resp["result"];
    assert!(
        !result.is_null() && !result.as_array().is_some_and(Vec::is_empty),
        "definition on method must return a location for standalone .csproj, got: {result}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
