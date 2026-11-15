//! E2E for Fix All at document / project / solution scope ([FIXALL], GitHub
//! #577). "Use implicit type" (IDE0007) across a real two-project `.sln`: the
//! offered action list must carry one `Fix all: <title>` action per supported
//! scope, each resolving — through the `FixAllRequest` in its `data` — to one
//! `WorkspaceEdit` touching exactly the files of that scope.

use super::*;

// Shared fix-all helpers live in `fixtures_fixall`.

fn assert_all_edits_replace_with_var(resp: &Value, label: &str) {
    let edits: Vec<&Value> = resp["result"]["edit"]["changes"]
        .as_object()
        .unwrap_or_else(|| panic!("{label} must have changes: {resp}"))
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .collect();
    assert!(!edits.is_empty(), "{label} must have edits: {resp}");
    for edit in edits {
        assert_eq!(
            edit["newText"].as_str(),
            Some("var"),
            "{label}: every fix replaces the explicit type with 'var': {edit}"
        );
    }
}

// ── Tests ─────────────────────────────────────────────────────────

/// The end-to-end path for "Use implicit type" (IDE0007) at every scope
/// ([FIXALL-SCOPES], [FIXALL-LSP], [FIXALL-TESTS]; GitHub #577).
#[test]
fn fix_all_use_implicit_type_document_project_solution_scope() {
    require_dotnet();
    let ws = create_fixall_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(ws.root_uri()));
    let inventory_uri = path_to_file_uri(&ws.inventory_path());
    client.open_document(&inventory_uri, FIXALL_INVENTORY_CS);

    // Readiness: hover answering means the sidecar holds the solution.
    let _ready =
        poll_hover_until_ready(&mut client, &inventory_uri, 2, 20, Duration::from_secs(150));

    // Interaction 1 — the offered list carries the single-site fix plus one
    // `Fix all: <title>` action per scope.
    let (line, start, end) = inventory_pos::FIRST_EXPLICIT_TYPE;
    let actions = poll_fix_all_actions(&mut client, &inventory_uri, (line, start, end));
    // The diagnostic-promoted fix carries the lowercase title "use 'var'
    // instead of explicit type" — Roslyn's fix provider, not its refactoring.
    let base = actions
        .iter()
        .find(|action| title_of(action).contains("var' instead of explicit type"))
        .unwrap_or_else(|| {
            panic!("no 'use var instead of explicit type' action offered: {actions:?}")
        });
    let base_title = title_of(base).to_string();
    assert_eq!(
        base["kind"], "refactor.rewrite",
        "IDE0007's fix is offered as a rewrite: {base}"
    );
    assert_eq!(base["data"]["uri"], json!(inventory_uri));

    for scope in ["document", "project", "solution"] {
        let fix_all = fix_all_for(&actions, scope, &base_title);
        assert_eq!(
            fix_all["kind"], "refactor.rewrite",
            "the fix-all action keeps the fix's kind: {fix_all}"
        );
        assert_ne!(
            fix_all["data"].get("id"),
            Some(&json!(base["data"]["id"])),
            "a fix-all action is not the single-site action"
        );
        assert_eq!(fix_all["data"]["uri"], json!(inventory_uri));
        let request = &fix_all["data"]["fixAll"];
        assert_eq!(
            request["scope"],
            json!(scope),
            "the data carries the FixAllRequest's scope: {fix_all}"
        );
        assert_eq!(
            request["enforce"], false,
            "the offered fix-all does not enforce rules yet: {fix_all}"
        );
        assert!(
            request["fixKey"]
                .as_str()
                .is_some_and(|key| !key.is_empty()),
            "the data carries a non-empty fix key (the EquivalenceKey): {fix_all}"
        );
    }

    // Interaction 2 — document scope: only the anchor file, its three sites.
    let document = fix_all_for(&actions, "document", &base_title).clone();
    let doc_resp = client.request("codeAction/resolve", document.clone());
    assert!(
        doc_resp.get("error").is_none(),
        "document resolve must not error: {doc_resp}"
    );
    let doc_files = edit_files(&doc_resp, "document");
    assert_eq!(doc_files.len(), 1, "document scope touches one file");
    assert!(
        doc_files[0].0.ends_with("Inventory.cs"),
        "document scope touches the anchor file: {doc_files:?}"
    );
    assert_eq!(edits_in(&doc_files, "Inventory.cs"), 3);
    assert_all_edits_replace_with_var(&doc_resp, "document");

    // Interaction 3 — project scope: both Core files, never Billing.
    let project = fix_all_for(&actions, "project", &base_title).clone();
    let proj_resp = client.request("codeAction/resolve", project);
    assert!(
        proj_resp.get("error").is_none(),
        "project resolve must not error: {proj_resp}"
    );
    let proj_files = edit_files(&proj_resp, "project");
    assert_eq!(proj_files.len(), 2, "project scope touches two files");
    assert_eq!(edits_in(&proj_files, "Inventory.cs"), 3);
    assert_eq!(edits_in(&proj_files, "Warehouse.cs"), 2);
    assert_eq!(
        edits_in(&proj_files, "Invoice.cs"),
        0,
        "project scope never leaves the owning project"
    );
    assert_all_edits_replace_with_var(&proj_resp, "project");

    // Interaction 4 — solution scope: every file with a site, across projects;
    // the clean file stays untouched.
    let solution = fix_all_for(&actions, "solution", &base_title).clone();
    let sol_resp = client.request("codeAction/resolve", solution);
    assert!(
        sol_resp.get("error").is_none(),
        "solution resolve must not error: {sol_resp}"
    );
    let sol_files = edit_files(&sol_resp, "solution");
    assert_eq!(sol_files.len(), 3, "solution scope touches three files");
    assert_eq!(edits_in(&sol_files, "Inventory.cs"), 3);
    assert_eq!(edits_in(&sol_files, "Warehouse.cs"), 2);
    assert_eq!(edits_in(&sol_files, "Invoice.cs"), 4);
    assert_eq!(
        edits_in(&sol_files, "Settings.cs"),
        0,
        "a file without a site is never touched"
    );
    assert_all_edits_replace_with_var(&sol_resp, "solution");

    // The scopes nest: document < project < solution.
    let totals = |files: &[(String, usize)]| files.iter().map(|(_, count)| *count).sum::<usize>();
    assert!(doc_files.len() < proj_files.len());
    assert!(proj_files.len() < sol_files.len());
    assert!(totals(&doc_files) < totals(&proj_files));
    assert!(totals(&proj_files) < totals(&sol_files));

    // Interaction 5 — resolving the same fix-all action again recomputes; a
    // fix-all is not consumed by its first resolve.
    let again_resp = client.request("codeAction/resolve", document);
    assert!(
        again_resp.get("error").is_none(),
        "a repeated fix-all resolve must not error: {again_resp}"
    );
    assert_eq!(
        edit_files(&again_resp, "repeat"),
        doc_files,
        "a repeated fix-all resolve returns the same edit"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// A fix-all resolve that cannot run answers an LSP error in plain words —
/// never a `null` result the editor would read as "no change".
/// [REFACTOR-NEVER-SILENT] [FIXALL-LSP]
#[test]
fn fix_all_resolve_failures_are_never_silent() {
    require_dotnet();

    // Without a sidecar: the reason names the missing service.
    let mut client = LspClient::start_without_sidecars();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);
    let no_sidecar = client.request(
        "codeAction/resolve",
        json!({
            "title": "Fix all in document: Use implicit type",
            "kind": "refactor.rewrite",
            "data": {
                "fixAll": { "fixKey": "UseImplicitType", "scope": "document", "enforce": false },
                "uri": TEST_URI
            }
        }),
    );
    assert!(
        no_sidecar.get("result").is_none(),
        "must answer an error, not a result: {no_sidecar}"
    );
    assert_eq!(
        no_sidecar["error"]["message"].as_str().unwrap_or_default(),
        "the C# language service is not running",
        "the reason names the missing service: {no_sidecar}"
    );
    client.shutdown_and_exit();
    client.wait_with_timeout();

    // With the sidecar: an unknown fix key answers the sidecar's reason.
    let ws = create_fixall_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(ws.root_uri()));
    let inventory_uri = path_to_file_uri(&ws.inventory_path());
    client.open_document(&inventory_uri, FIXALL_INVENTORY_CS);
    let _ready =
        poll_hover_until_ready(&mut client, &inventory_uri, 2, 20, Duration::from_secs(150));
    let unknown_key = client.request(
        "codeAction/resolve",
        json!({
            "title": "Fix all in document: No such fix",
            "kind": "refactor.rewrite",
            "data": {
                "fixAll": { "fixKey": "NoSuchFixExists", "scope": "document", "enforce": false },
                "uri": inventory_uri
            }
        }),
    );
    assert!(
        unknown_key.get("result").is_none(),
        "an unknown fix key must answer an error: {unknown_key}"
    );
    let reason = unknown_key["error"]["message"].as_str().unwrap_or_default();
    assert!(
        !reason.is_empty(),
        "the refusal carries a reason in plain words: {unknown_key}"
    );

    // An unsupported scope is refused too, never silently narrowed.
    let bad_scope = client.request(
        "codeAction/resolve",
        json!({
            "title": "Fix all in galaxy: Use implicit type",
            "kind": "refactor.rewrite",
            "data": {
                "fixAll": { "fixKey": "UseImplicitType", "scope": "galaxy", "enforce": false },
                "uri": inventory_uri
            }
        }),
    );
    assert!(
        bad_scope.get("result").is_none(),
        "an unsupported scope must answer an error: {bad_scope}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
