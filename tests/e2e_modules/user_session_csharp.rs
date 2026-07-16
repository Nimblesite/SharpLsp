//! Full-stack C# user-session test on the medium mixed-language workspace.
//!
//! Simulates a realistic editing session the way VS Code drives the server on
//! Windows — percent-encoded document URIs (`file:///c%3A/...`), several open
//! documents, cross-project navigation, live edits, error injection, and a
//! workspace-wide rename — asserting real content at every step. [GitHub #110]

use super::*;

/// Open the three C# documents the session touches, VS Code-style.
fn open_csharp_session_docs(
    client: &mut LspClient,
    ws: &MediumWorkspace,
) -> (String, String, String) {
    let entities_uri = path_to_vscode_uri(&ws.entities_path());
    let service_uri = path_to_vscode_uri(&ws.customer_service_path());
    let processor_uri = path_to_vscode_uri(&ws.order_processor_path());
    client.open_document(&entities_uri, ENTITIES_CS);
    client.open_document(&service_uri, CUSTOMER_SERVICE_CS);
    client.open_document(&processor_uri, ORDER_PROCESSOR_CS);
    (entities_uri, service_uri, processor_uri)
}

#[test]
fn test_full_stack_csharp_user_session_medium_codebase() {
    require_dotnet();
    let ws = create_medium_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(ws.root_uri()));
    let (entities_uri, service_uri, processor_uri) = open_csharp_session_docs(&mut client, &ws);

    // ── Readiness: hover on `Customer` through the percent-encoded URI ──
    let (line, character) = cs_med_pos::CUSTOMER_CLASS;
    let class_hover = poll_hover_until_ready(
        &mut client,
        &entities_uri,
        line,
        character,
        Duration::from_secs(120),
    );
    let class_md = class_hover["contents"]["value"].as_str().unwrap();
    assert!(
        class_md.contains("Customer") && class_md.contains("class"),
        "Customer hover must show the class signature: {class_md}"
    );
    assert!(
        class_md.contains("customer of the system"),
        "Customer hover must surface the XML doc summary: {class_md}"
    );

    // ── documentSymbol: full shape of Entities.cs ──
    let symbols = document_request(&mut client, "textDocument/documentSymbol", &entities_uri);
    assert_rpc_ok(&symbols, "documentSymbol(Entities.cs)");
    let symbol_json = serde_json::to_string(&symbols["result"]).unwrap();
    for name in [
        "Customer",
        "ICustomerRepository",
        "OrderStatus",
        "Order",
        "IsVip",
        "Balance",
        "FindById",
    ] {
        assert!(
            symbol_json.contains(name),
            "documentSymbol must include `{name}`: {symbol_json}"
        );
    }
    let customer_sym =
        find_symbol(&symbols["result"], "Customer").expect("Customer symbol present");
    assert_eq!(customer_sym["kind"], 5, "Customer must be Class-kind (5)");
    let repo_sym = find_symbol(&symbols["result"], "ICustomerRepository")
        .expect("ICustomerRepository symbol present");
    assert_eq!(
        repo_sym["kind"], 11,
        "ICustomerRepository must be Interface-kind (11)"
    );
    let status_sym =
        find_symbol(&symbols["result"], "OrderStatus").expect("OrderStatus symbol present");
    assert_eq!(status_sym["kind"], 10, "OrderStatus must be Enum-kind (10)");
    let is_vip_sym = find_symbol(&symbols["result"], "IsVip").expect("IsVip symbol present");
    assert_eq!(is_vip_sym["kind"], 6, "IsVip must be Method-kind (6)");

    // ── Cross-project definition: Services → Core ──
    let (fb_line, fb_char) = cs_med_pos::FIND_BY_ID_USAGE;
    let find_by_id_def = definition(&mut client, &processor_uri, fb_line, fb_char);
    assert_nav_ok(&find_by_id_def);
    let find_by_id_loc = first_location(&find_by_id_def["result"]);
    let def_uri = find_by_id_loc["uri"].as_str().unwrap();
    assert_wellformed_file_uri(def_uri, "FindById definition");
    assert!(
        def_uri.ends_with("Entities.cs"),
        "FindById must resolve into Core's Entities.cs: {def_uri}"
    );
    assert_location_line(
        &find_by_id_loc,
        cs_med_pos::FIND_BY_ID_DECL_LINE,
        "FindById definition must land on the interface member",
    );

    let (pe_line, pe_char) = cs_med_pos::PRICING_ENGINE_USAGE;
    let pricing_def = definition(&mut client, &processor_uri, pe_line, pe_char);
    assert_nav_ok(&pricing_def);
    let pricing_loc = first_location(&pricing_def["result"]);
    let pricing_uri = pricing_loc["uri"].as_str().unwrap();
    assert_wellformed_file_uri(pricing_uri, "PricingEngine definition");
    assert!(
        pricing_uri.ends_with("Pricing.cs"),
        "PricingEngine must resolve into Core's Pricing.cs: {pricing_uri}"
    );
    assert_location_line(
        &pricing_loc,
        cs_med_pos::PRICING_ENGINE_DECL_LINE,
        "PricingEngine definition must land on the class declaration",
    );

    // ── Hover on a cross-project member call ──
    let (iv_line, iv_char) = cs_med_pos::IS_VIP_USAGE;
    let is_vip_hover = hover(&mut client, &processor_uri, iv_line, iv_char);
    assert_hover_ok(&is_vip_hover);
    let is_vip_md = is_vip_hover["result"]["contents"]["value"]
        .as_str()
        .unwrap();
    assert!(
        is_vip_md.contains("IsVip") && is_vip_md.contains("bool"),
        "IsVip hover must show the bool signature: {is_vip_md}"
    );

    // ── References: interface used across all three files ──
    let (ir_line, ir_char) = cs_med_pos::ICUSTOMER_REPOSITORY_DECL;
    let refs = references(&mut client, &entities_uri, ir_line, ir_char, true);
    assert_nav_ok(&refs);
    let ref_locs = location_entries(&refs["result"]);
    assert!(
        ref_locs.len() >= 4,
        "ICustomerRepository must have >=4 references (decl, impl, field, ctor param): {ref_locs:?}"
    );
    for (uri, _) in &ref_locs {
        assert_wellformed_file_uri(uri, "ICustomerRepository reference");
    }
    assert_has_location_in(
        &ref_locs,
        "Entities.cs",
        "references must include the declaration",
    );
    assert_has_location_in(
        &ref_locs,
        "CustomerService.cs",
        "references must include the implementation",
    );
    assert_has_location_in(
        &ref_locs,
        "OrderProcessor.cs",
        "references must include the consuming field",
    );

    // ── Workspace symbols across projects ──
    let ws_symbols = client.request("workspace/symbol", json!({ "query": "Customer" }));
    assert_rpc_ok(&ws_symbols, "workspace/symbol(Customer)");
    let ws_arr = ws_symbols["result"].as_array().expect("array result");
    assert!(
        ws_arr.iter().any(|s| s["name"] == "Customer"),
        "workspace/symbol must find Customer in Core: {ws_symbols}"
    );
    assert!(
        ws_arr.iter().any(|s| s["name"] == "CustomerService"),
        "workspace/symbol must find CustomerService in Services: {ws_symbols}"
    );

    // ── Signature help inside ApplyDiscount(...) ──
    let sig = position_request(
        &mut client,
        "textDocument/signatureHelp",
        &processor_uri,
        cs_med_pos::APPLY_DISCOUNT_ARGS,
    );
    assert_rpc_ok(&sig, "signatureHelp(ApplyDiscount)");
    let signatures = sig["result"]["signatures"]
        .as_array()
        .expect("signatures array");
    assert!(
        !signatures.is_empty(),
        "ApplyDiscount must offer a signature"
    );
    let sig_label = signatures[0]["label"].as_str().unwrap();
    assert!(
        sig_label.contains("ApplyDiscount"),
        "signature label must name the method: {sig_label}"
    );
    assert!(
        signatures[0]["parameters"]
            .as_array()
            .is_some_and(|p| p.len() == 2),
        "ApplyDiscount must show two parameters: {sig}"
    );

    // ── Document highlight on the `customer` local ──
    let (cv_line, cv_char) = cs_med_pos::CUSTOMER_VAR;
    let highlights = document_highlight(&mut client, &processor_uri, cv_line, cv_char);
    assert_rpc_ok(&highlights, "documentHighlight(customer)");
    let highlight_arr = highlights["result"].as_array().expect("highlight array");
    assert!(
        highlight_arr.len() >= 5,
        "`customer` is used six times in Charge — highlights: {highlights}"
    );

    // ── Folding ranges on Entities.cs (syntax route stays healthy mid-session) ──
    let folding = document_request(&mut client, "textDocument/foldingRange", &entities_uri);
    assert_rpc_ok(&folding, "foldingRange(Entities.cs)");
    assert!(
        folding["result"].as_array().is_some_and(|f| f.len() >= 3),
        "Entities.cs must fold its class/interface/enum bodies: {folding}"
    );

    // ── Live edit: type `customer.` and complete members ──
    let probe_source = insert_line(
        ORDER_PROCESSOR_CS,
        cs_med_pos::PROBE_INSERT_LINE,
        "        var probe = customer.Balance;",
    );
    client.change_document(&processor_uri, 2, &probe_source);
    let completion = position_request(
        &mut client,
        "textDocument/completion",
        &processor_uri,
        cs_med_pos::PROBE_COMPLETION,
    );
    assert_rpc_ok(&completion, "completion(customer.)");
    let items = completion["result"]["items"]
        .as_array()
        .or_else(|| completion["result"].as_array())
        .expect("completion items");
    let labels: Vec<&str> = items.iter().filter_map(|i| i["label"].as_str()).collect();
    for member in ["Balance", "Id", "Name", "IsVip"] {
        assert!(
            labels.iter().any(|l| *l == member),
            "completion after `customer.` must offer `{member}`: {labels:?}"
        );
    }

    // ── Live edit: inject CS0029, pull diagnostics, then fix it ──
    client.change_document(&processor_uri, 3, ORDER_PROCESSOR_CS);
    assert!(
        pull_error_diagnostics(&mut client, &processor_uri, "diagnostics(clean baseline)")
            .is_empty(),
        "reverted OrderProcessor.cs must have no error diagnostics"
    );
    let broken_source = replace_line(
        ORDER_PROCESSOR_CS,
        cs_med_pos::BALANCE_ASSIGN_LINE,
        "        customer.Balance = \"oops\";",
    );
    client.change_document(&processor_uri, 4, &broken_source);
    let errors = pull_error_diagnostics(&mut client, &processor_uri, "diagnostics(CS0029)");
    assert!(
        errors.iter().any(|d| {
            d["code"] == "CS0029"
                && d["range"]["start"]["line"].as_u64()
                    == Some(cs_med_pos::BALANCE_ASSIGN_LINE as u64)
        }),
        "assigning a string to decimal must raise CS0029 on line {}: {errors:?}",
        cs_med_pos::BALANCE_ASSIGN_LINE
    );
    client.change_document(&processor_uri, 5, ORDER_PROCESSOR_CS);
    assert!(
        pull_error_diagnostics(&mut client, &processor_uri, "diagnostics(fixed)").is_empty(),
        "fixing the assignment must clear all error diagnostics"
    );

    // ── Rename Customer → Client across the whole workspace ──
    let (rc_line, rc_char) = cs_med_pos::CUSTOMER_CLASS;
    let prepare = position_request(
        &mut client,
        "textDocument/prepareRename",
        &entities_uri,
        (rc_line, rc_char),
    );
    assert_rpc_ok(&prepare, "prepareRename(Customer)");
    assert_eq!(
        prepare["result"]["placeholder"], "Customer",
        "prepareRename must offer the current name as placeholder: {prepare}"
    );
    let rename = rename_request(&mut client, &entities_uri, rc_line, rc_char, "Client");
    assert_rpc_ok(&rename, "rename(Customer -> Client)");
    let doc_changes = rename["result"]["documentChanges"]
        .as_array()
        .expect("rename must return documentChanges");
    let changed_files: Vec<&str> = doc_changes
        .iter()
        .filter_map(|dc| dc["textDocument"]["uri"].as_str())
        .collect();
    assert!(
        changed_files.iter().any(|u| u.ends_with("Entities.cs")),
        "rename must edit the declaring file: {changed_files:?}"
    );
    assert!(
        changed_files
            .iter()
            .any(|u| u.ends_with("CustomerService.cs")),
        "rename must edit the cross-project consumer: {changed_files:?}"
    );
    for uri in &changed_files {
        assert_wellformed_file_uri(uri, "rename edit target");
    }
    let all_edits: Vec<&Value> = doc_changes
        .iter()
        .flat_map(|dc| dc["edits"].as_array().unwrap().iter())
        .collect();
    assert!(
        all_edits.len() >= 6,
        "Customer appears 7 times across Core+Services — rename edits: {}",
        all_edits.len()
    );
    assert!(
        all_edits.iter().all(|e| e["newText"] == "Client"),
        "every rename edit must insert the new name: {doc_changes:?}"
    );

    // ── The untouched buffer stayed consistent through the whole session ──
    let service_symbols =
        document_request(&mut client, "textDocument/documentSymbol", &service_uri);
    assert_rpc_ok(&service_symbols, "documentSymbol(CustomerService.cs)");
    let service_json = serde_json::to_string(&service_symbols["result"]).unwrap();
    assert!(
        service_json.contains("CustomerService") && service_json.contains("FindById"),
        "CustomerService.cs symbols must survive the session: {service_json}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
