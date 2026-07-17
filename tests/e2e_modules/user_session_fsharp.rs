//! Full-stack F# user-session test on the medium mixed-language workspace.
//!
//! F# is a first-class citizen: this mirrors the C# session — VS Code-shaped
//! percent-encoded URIs, two open documents, cross-file navigation, live
//! edits, error injection, and a cross-file rename — all against the real FCS
//! sidecar loading a project that lives alongside C# projects in one solution.
//! [GitHub #110]

use super::*;

#[test]
fn test_full_stack_fsharp_user_session_medium_codebase() {
    require_dotnet();
    let ws = create_medium_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(ws.root_uri()));
    let domain_uri = path_to_vscode_uri(&ws.domain_path());
    let calculations_uri = path_to_vscode_uri(&ws.calculations_path());
    client.open_document(&domain_uri, DOMAIN_FS);
    client.open_document(&calculations_uri, CALCULATIONS_FS);

    // ── Readiness: hover on `charge` through the percent-encoded URI ──
    let (line, character) = fs_med_pos::CHARGE_FN;
    let charge_hover = poll_hover_until_ready(
        &mut client,
        &domain_uri,
        line,
        character,
        Duration::from_mins(2),
    );
    let charge_md = charge_hover["contents"]["value"].as_str().unwrap();
    assert!(
        charge_md.contains("charge") && charge_md.contains("decimal"),
        "charge hover must show the decimal signature: {charge_md}"
    );

    // ── documentSymbol: full shape of Domain.fs ──
    let symbols = document_request(&mut client, "textDocument/documentSymbol", &domain_uri);
    assert_rpc_ok(&symbols, "documentSymbol(Domain.fs)");
    let symbol_json = serde_json::to_string(&symbols["result"]).unwrap();
    for name in ["Product", "Payment", "charge"] {
        assert!(
            symbol_json.contains(name),
            "documentSymbol must include `{name}`: {symbol_json}"
        );
    }

    // ── Cross-file definition: Calculations.fs → Domain.fs ──
    let (pu_line, pu_char) = fs_med_pos::PRODUCT_USAGE;
    let product_def = definition(&mut client, &calculations_uri, pu_line, pu_char);
    assert_nav_ok(&product_def);
    let product_loc = first_location(&product_def["result"]);
    let product_uri = product_loc["uri"].as_str().unwrap();
    assert_wellformed_file_uri(product_uri, "Product definition");
    assert!(
        product_uri.ends_with("Domain.fs"),
        "Product must resolve into Domain.fs: {product_uri}"
    );
    assert_location_line(
        &product_loc,
        fs_med_pos::PRODUCT_DECL_LINE,
        "Product definition must land on the record declaration",
    );

    let (cu_line, cu_char) = fs_med_pos::CHARGE_USAGE;
    let charge_def = definition(&mut client, &calculations_uri, cu_line, cu_char);
    assert_nav_ok(&charge_def);
    let charge_loc = first_location(&charge_def["result"]);
    let charge_def_uri = charge_loc["uri"].as_str().unwrap();
    assert_wellformed_file_uri(charge_def_uri, "charge definition");
    assert!(
        charge_def_uri.ends_with("Domain.fs"),
        "charge must resolve into Domain.fs: {charge_def_uri}"
    );
    assert_location_line(
        &charge_loc,
        fs_med_pos::CHARGE_DECL_LINE,
        "charge definition must land on the let binding",
    );

    // ── References: charge is used from the sibling file ──
    // Project-wide references need FCS's whole-project check; the first
    // responses are legitimately empty while it warms, so poll like every
    // other references test ([FS-REFS-PROJECT]).
    let refs = poll_references_until_ready(
        &mut client,
        &domain_uri,
        line,
        character,
        Duration::from_mins(2),
    );
    let ref_locs = location_entries(&refs["result"]);
    assert!(
        ref_locs.len() >= 2,
        "charge must report its declaration and the settle usage: {ref_locs:?}"
    );
    for (uri, _) in &ref_locs {
        assert_wellformed_file_uri(uri, "charge reference");
    }
    assert_has_location_in(
        &ref_locs,
        "Domain.fs",
        "references must include the declaration",
    );
    assert_has_location_in(
        &ref_locs,
        "Calculations.fs",
        "references must include the cross-file usage",
    );

    // ── Workspace symbols reach the F# project ──
    let ws_symbols = client.request("workspace/symbol", json!({ "query": "basketTotal" }));
    assert_rpc_ok(&ws_symbols, "workspace/symbol(basketTotal)");
    let ws_arr = ws_symbols["result"].as_array().expect("array result");
    let basket = ws_arr
        .iter()
        .find(|s| s["name"] == "basketTotal")
        .unwrap_or_else(|| panic!("workspace/symbol must find basketTotal: {ws_symbols}"));
    let basket_uri = basket["location"]["uri"].as_str().unwrap();
    assert_wellformed_file_uri(basket_uri, "basketTotal workspace symbol");
    assert!(
        basket_uri.ends_with("Calculations.fs"),
        "basketTotal must locate in Calculations.fs: {basket_uri}"
    );

    // ── Live edit: append a probe and complete record members ──
    let probe_source =
        format!("{CALCULATIONS_FS}\nlet probePrice (product: Product) : decimal = product.Price\n");
    client.change_document(&calculations_uri, 2, &probe_source);
    let completion = position_request(
        &mut client,
        "textDocument/completion",
        &calculations_uri,
        fs_med_pos::PROBE_COMPLETION,
    );
    assert_rpc_ok(&completion, "completion(product.)");
    let items = completion["result"]["items"]
        .as_array()
        .or_else(|| completion["result"].as_array())
        .expect("completion items");
    let labels: Vec<&str> = items.iter().filter_map(|i| i["label"].as_str()).collect();
    for field in ["Sku", "Price"] {
        assert!(
            labels.contains(&field),
            "completion after `product.` must offer the record field `{field}`: {labels:?}"
        );
    }
    client.change_document(&calculations_uri, 3, CALCULATIONS_FS);

    // ── Signature help contract at the settle call site ([FS-SIGHELP]) ──
    let sig = position_request(
        &mut client,
        "textDocument/signatureHelp",
        &calculations_uri,
        fs_med_pos::CHARGE_USAGE,
    );
    assert_rpc_ok(&sig, "signatureHelp(charge)");
    assert!(
        sig["result"].is_null() || sig["result"]["signatures"].is_array(),
        "signatureHelp must return null or a SignatureHelp with signatures[]: {sig}"
    );

    // ── Live edit: inject a type error, pull diagnostics, then fix it ──
    let _ = poll_error_diagnostics_until(
        &mut client,
        &domain_uri,
        "diagnostics(clean baseline)",
        Duration::from_mins(1),
        <[Value]>::is_empty,
    );
    let broken_source = replace_line(
        DOMAIN_FS,
        fs_med_pos::CASH_ARM_LINE,
        "    | Cash -> \"oops\"",
    );
    client.change_document(&domain_uri, 2, &broken_source);
    let decimal_error_on_arm = |errors: &[Value]| {
        errors.iter().any(|d| {
            d["range"]["start"]["line"].as_u64() == u64::try_from(fs_med_pos::CASH_ARM_LINE).ok()
                && d["message"].as_str().is_some_and(|m| m.contains("decimal"))
        })
    };
    let _ = poll_error_diagnostics_until(
        &mut client,
        &domain_uri,
        "diagnostics(type error on the Cash arm)",
        Duration::from_mins(1),
        decimal_error_on_arm,
    );
    client.change_document(&domain_uri, 3, DOMAIN_FS);
    let _ = poll_error_diagnostics_until(
        &mut client,
        &domain_uri,
        "diagnostics(clean after revert)",
        Duration::from_mins(1),
        <[Value]>::is_empty,
    );

    // ── Rename charge → chargePayment across both files ──
    let prepare = position_request(
        &mut client,
        "textDocument/prepareRename",
        &domain_uri,
        fs_med_pos::CHARGE_FN,
    );
    assert_rpc_ok(&prepare, "prepareRename(charge)");
    assert!(
        !prepare["result"].is_null(),
        "prepareRename must allow renaming charge: {prepare}"
    );
    assert_eq!(
        prepare_rename_start_line(&prepare["result"]),
        Some(fs_med_pos::CHARGE_DECL_LINE),
        "prepareRename range must span the charge binding: {prepare}"
    );
    let rename = rename_request(&mut client, &domain_uri, line, character, "chargePayment");
    assert_rpc_ok(&rename, "rename(charge -> chargePayment)");
    let doc_changes = rename["result"]["documentChanges"]
        .as_array()
        .expect("rename must return documentChanges");
    let changed_files: Vec<&str> = doc_changes
        .iter()
        .filter_map(|dc| dc["textDocument"]["uri"].as_str())
        .collect();
    assert!(
        changed_files.iter().any(|u| u.ends_with("Domain.fs")),
        "rename must edit the declaring file: {changed_files:?}"
    );
    assert!(
        changed_files.iter().any(|u| u.ends_with("Calculations.fs")),
        "rename must edit the cross-file usage: {changed_files:?}"
    );
    for uri in &changed_files {
        assert_wellformed_file_uri(uri, "rename edit target");
    }
    // Apply the edits and assert the text the user ends up with — valid for
    // both granular and whole-document edit shapes (GitHub #161).
    let domain_edits = edits_for(doc_changes, "Domain.fs");
    assert!(
        !domain_edits.is_empty(),
        "rename must carry edits for Domain.fs: {doc_changes:?}"
    );
    let renamed_domain = apply_text_edits(DOMAIN_FS, &domain_edits);
    assert!(
        renamed_domain.contains("let chargePayment (price: decimal)"),
        "rename must rewrite the let binding: {renamed_domain}"
    );
    assert!(
        !renamed_domain.contains("let charge (price"),
        "the old binding name must be gone: {renamed_domain}"
    );
    let calc_edits = edits_for(doc_changes, "Calculations.fs");
    assert!(
        !calc_edits.is_empty(),
        "rename must carry edits for Calculations.fs: {doc_changes:?}"
    );
    let renamed_calc = apply_text_edits(CALCULATIONS_FS, &calc_edits);
    assert!(
        renamed_calc.contains("chargePayment remaining payment"),
        "rename must rewrite the cross-file usage in settle: {renamed_calc}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
