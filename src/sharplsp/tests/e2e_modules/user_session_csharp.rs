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
        Duration::from_mins(2),
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
    let (is_vip_line, is_vip_char) = cs_med_pos::IS_VIP_USAGE;
    let is_vip_hover = hover(&mut client, &processor_uri, is_vip_line, is_vip_char);
    assert_hover_ok(&is_vip_hover);
    let is_vip_md = is_vip_hover["result"]["contents"]["value"]
        .as_str()
        .unwrap();
    assert!(
        is_vip_md.contains("IsVip") && is_vip_md.contains("bool"),
        "IsVip hover must show the bool signature: {is_vip_md}"
    );

    // ── References: interface used across all three files ──
    let (repo_line, repo_char) = cs_med_pos::ICUSTOMER_REPOSITORY_DECL;
    let refs = references(&mut client, &entities_uri, repo_line, repo_char, true);
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
    // C# signature help is not implemented sidecar-side yet — the host routes
    // the request and must answer null rather than erroring ([FS-SIGHELP];
    // C# parity tracked in GitHub #174). Once it lands, the shape assertions
    // below take over.
    let sig = position_request(
        &mut client,
        "textDocument/signatureHelp",
        &processor_uri,
        cs_med_pos::APPLY_DISCOUNT_ARGS,
    );
    assert_rpc_ok(&sig, "signatureHelp(ApplyDiscount)");
    if !sig["result"].is_null() {
        let signatures = sig["result"]["signatures"]
            .as_array()
            .expect("signatures array");
        assert!(
            !signatures.is_empty(),
            "non-null signatureHelp must carry a signature: {sig}"
        );
        let sig_label = signatures[0]["label"].as_str().unwrap();
        assert!(
            sig_label.contains("ApplyDiscount"),
            "signature label must name the method: {sig_label}"
        );
    }

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
            labels.contains(&member),
            "completion after `customer.` must offer `{member}`: {labels:?}"
        );
    }

    // ── Live edit: inject CS0029, pull diagnostics, then fix it ──
    client.change_document(&processor_uri, 3, ORDER_PROCESSOR_CS);
    let _ = poll_error_diagnostics_until(
        &mut client,
        &processor_uri,
        "diagnostics(clean baseline)",
        Duration::from_mins(1),
        <[Value]>::is_empty,
    );
    let broken_source = replace_line(
        ORDER_PROCESSOR_CS,
        cs_med_pos::BALANCE_ASSIGN_LINE,
        "        customer.Balance = \"oops\";",
    );
    client.change_document(&processor_uri, 4, &broken_source);
    let cs0029_on_assign_line = |errors: &[Value]| {
        errors.iter().any(|d| {
            d["code"] == "CS0029"
                && d["range"]["start"]["line"].as_u64()
                    == u64::try_from(cs_med_pos::BALANCE_ASSIGN_LINE).ok()
        })
    };
    let _ = poll_error_diagnostics_until(
        &mut client,
        &processor_uri,
        "diagnostics(CS0029 on the Balance assignment)",
        Duration::from_mins(1),
        cs0029_on_assign_line,
    );
    client.change_document(&processor_uri, 5, ORDER_PROCESSOR_CS);
    let _ = poll_error_diagnostics_until(
        &mut client,
        &processor_uri,
        "diagnostics(clean after fix)",
        Duration::from_mins(1),
        <[Value]>::is_empty,
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
    assert!(
        !prepare["result"].is_null(),
        "prepareRename must allow renaming Customer: {prepare}"
    );
    assert_eq!(
        prepare_rename_start_line(&prepare["result"]),
        Some(u64::from(rc_line)),
        "prepareRename range must span the Customer identifier: {prepare}"
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
    // Apply the edits and assert the text the user ends up with — valid for
    // both granular and whole-document edit shapes (GitHub #161).
    let entities_edits = edits_for(doc_changes, "Entities.cs");
    assert!(
        !entities_edits.is_empty(),
        "rename must carry edits for Entities.cs: {doc_changes:?}"
    );
    let renamed_entities = apply_text_edits(ENTITIES_CS, &entities_edits);
    assert!(
        renamed_entities.contains("public class Client"),
        "rename must rewrite the class declaration: {renamed_entities}"
    );
    assert!(
        !renamed_entities.contains("public class Customer"),
        "the old class name must be gone: {renamed_entities}"
    );
    assert!(
        renamed_entities.contains("Client? FindById(int id);"),
        "rename must rewrite the interface return type: {renamed_entities}"
    );
    assert!(
        renamed_entities.contains("void Save(Client customer);"),
        "rename must rewrite the parameter type: {renamed_entities}"
    );
    assert!(
        renamed_entities.contains("Client Buyer"),
        "rename must rewrite the record component type: {renamed_entities}"
    );
    let service_edits = edits_for(doc_changes, "CustomerService.cs");
    assert!(
        !service_edits.is_empty(),
        "rename must carry edits for CustomerService.cs: {doc_changes:?}"
    );
    let renamed_service = apply_text_edits(CUSTOMER_SERVICE_CS, &service_edits);
    assert!(
        renamed_service.contains("Dictionary<int, Client>"),
        "rename must rewrite the cross-project field type: {renamed_service}"
    );
    assert!(
        renamed_service.contains("public Client? FindById(int id)"),
        "rename must rewrite the implementation return type: {renamed_service}"
    );
    assert!(
        renamed_service.contains("class CustomerService"),
        "renaming the Customer type must not touch the CustomerService class \
         name: {renamed_service}"
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
