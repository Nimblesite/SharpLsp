use super::*;

// ── F# File Tests ───────────────────────────────────────────────

#[test]
fn test_fsharp_file_errors_gracefully() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/Module.fs";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": fs_uri,
                "languageId": "fsharp",
                "version": 1,
                "text": "module MyModule\nlet x = 42\n",
            }
        }),
    );

    // This should return an error because F# tree-sitter isn't integrated yet.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": fs_uri } }),
    );
    assert!(
        resp.get("error").is_some(),
        "F# should error (not yet integrated)"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_fsharp_fsx_extension() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fsx_uri = "file:///test/Script.fsx";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": fsx_uri,
                "languageId": "fsharp",
                "version": 1,
                "text": "printfn \"hello\"\n",
            }
        }),
    );

    // .fsx should be recognized as F# and error (grammar not integrated).
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": fsx_uri } }),
    );
    assert!(resp.get("error").is_some(), "fsx should error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_fsharp_fsi_extension() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fsi_uri = "file:///test/Signature.fsi";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": fsi_uri,
                "languageId": "fsharp",
                "version": 1,
                "text": "module MyModule\nval x : int\n",
            }
        }),
    );

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": fsi_uri } }),
    );
    assert!(resp.get("error").is_some(), "fsi should error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Full-stack F# harness ───────────────────────────────────────
//
// Every full-stack F# test loads the same `create_fsharp_test_workspace`
// fixture (`Library.fs`, symbol positions documented there), spins up the real
// `sharplsp` host + F# sidecar, and waits for the FCS background load to finish.
// `ready_fsharp_client` collapses that identical, slow setup so each feature
// test is just request + assertions. The readiness gate is a successful hover on
// the `Calculator` module (line 3, char 7) — the same signal the host needs
// before any semantic F# request can resolve.

/// Source symbol positions in the shared `Library.fs` fixture (0-based).
mod fs_pos {
    /// `Calculator` module name on `module Calculator =`.
    pub const CALCULATOR_MODULE: (u32, u32) = (3, 7);
    /// `add` binding on `let add (a: int) (b: int) : int = a + b`.
    pub const ADD_FN: (u32, u32) = (5, 8);
    /// `Shape` type name on `type Shape =`.
    pub const SHAPE_TYPE: (u32, u32) = (11, 5);
    /// `Shape` used as the annotation in `let area (shape: Shape) : float =`.
    pub const SHAPE_ANNOTATION_USE: (u32, u32) = (16, 17);
    /// `shape` value (of type `Shape`) in `let area (shape: Shape) ...`.
    pub const SHAPE_VALUE: (u32, u32) = (16, 11);
    /// Inside the `List.map (` call on the pipeline line (after the open paren).
    pub const LIST_MAP_CALL: (u32, u32) = (23, 20);
    /// Just after the `.` in `List.map` — a member-completion context.
    pub const LIST_DOT: (u32, u32) = (23, 15);
}

/// Load the F# fixture, start the host+sidecar, and block until the F# sidecar
/// has loaded the workspace. Returns `(tempdir, file_uri, ready_client)`; keep
/// the `TempDir` alive for the duration of the test.
fn ready_fsharp_client() -> (tempfile::TempDir, String, LspClient) {
    require_dotnet();

    let (tmp, root_uri, file_uri, source) = create_fsharp_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let (line, character) = fs_pos::CALCULATOR_MODULE;
    let _ = poll_hover_until_ready(
        &mut client,
        &file_uri,
        line,
        character,
        Duration::from_secs(90),
    );

    (tmp, file_uri, client)
}

/// Send `method` with position params built from the real `file_uri`.
fn position_request(client: &mut LspClient, method: &str, uri: &str, pos: (u32, u32)) -> Value {
    client.request(
        method,
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": pos.0, "character": pos.1 }
        }),
    )
}

/// Send a `{ textDocument: { uri } }`-only request (documentSymbol, codeLens, …).
fn document_request(client: &mut LspClient, method: &str, uri: &str) -> Value {
    client.request(method, json!({ "textDocument": { "uri": uri } }))
}

/// Assert a response is well-formed JSON-RPC 2.0 with an id and no error.
fn assert_rpc_ok(resp: &Value, label: &str) {
    assert_eq!(resp["jsonrpc"], "2.0", "{label}: must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "{label}: must have request id");
    assert!(
        resp.get("error").is_none(),
        "{label}: must not return an error: {resp}"
    );
}

// ── F# Hover Tests (Full-Stack) ─────────────────────────────────

// 40. F# HOVER ON FUNCTION/TYPE/MODULE

#[test]
fn test_full_stack_fsharp_hover_function_type_module() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // `Calculator` module hover (the readiness gate already proved it resolves).
    let (m_line, m_char) = fs_pos::CALCULATOR_MODULE;
    let module_hover = hover(&mut client, &file_uri, m_line, m_char);
    assert_hover_ok(&module_hover);
    let md = module_hover["result"]["contents"]["value"]
        .as_str()
        .unwrap();
    assert!(!md.is_empty(), "F# module hover must not be empty: {md}");
    assert!(md.contains("```"), "must have code block: {md}");

    // Hover on `add` function.
    let (a_line, a_char) = fs_pos::ADD_FN;
    let fn_hover = hover(&mut client, &file_uri, a_line, a_char);
    assert_hover_ok(&fn_hover);
    assert!(
        !fn_hover["result"].is_null(),
        "function hover must not be null"
    );
    let fn_md = fn_hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(
        fn_md.contains("```"),
        "function hover must have code block: {fn_md}"
    );

    // Hover on `Shape` type.
    let (s_line, s_char) = fs_pos::SHAPE_TYPE;
    let type_hover = hover(&mut client, &file_uri, s_line, s_char);
    assert_hover_ok(&type_hover);
    assert!(
        !type_hover["result"].is_null(),
        "type hover must not be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 41. F# HOVER ON DU CASE

#[test]
fn test_full_stack_fsharp_hover_du_case() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // Hover on `Circle` DU case (line 12, char 6).
    let du_hover = hover(&mut client, &file_uri, 12, 6);
    assert_hover_ok(&du_hover);
    assert!(
        !du_hover["result"].is_null(),
        "DU case hover must not be null"
    );
    let md = du_hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(md.contains("```"), "DU hover must have code block: {md}");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 42. F# HOVER ON PIPELINE OPERATOR

#[test]
fn test_full_stack_fsharp_hover_pipeline() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // Hover on `List.map` in pipeline (line 23, char 14).
    let h = hover(&mut client, &file_uri, 23, 14);
    assert_hover_ok(&h);
    assert!(!h["result"].is_null(), "pipeline hover must not be null");
    let md = h["result"]["contents"]["value"].as_str().unwrap();
    assert!(
        md.contains("```"),
        "pipeline hover must have code block: {md}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 43. F# HOVER WITH XML DOCUMENTATION

#[test]
fn test_full_stack_fsharp_hover_xml_docs() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // Hover on `add` function — has doc "Adds two integers".
    let (a_line, a_char) = fs_pos::ADD_FN;
    let h = hover(&mut client, &file_uri, a_line, a_char);
    assert_hover_ok(&h);
    assert!(!h["result"].is_null(), "hover must not be null");
    let md = h["result"]["contents"]["value"].as_str().unwrap();
    assert!(md.contains("```"), "must have code block: {md}");
    assert!(
        md.to_lowercase().contains("adds") || md.to_lowercase().contains("sum"),
        "F# hover must include XML doc: {md}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 43b. F# HOVER REFLECTS LIVE EDITS (didChange overlay, not stale disk)
//
// Regression for "F# hover is broken after typing": the F# sidecar was cut out
// of document sync. `notify_did_change` was hardcoded to the C# sidecar and the
// F# sidecar registered no `textDocument/didChange`, so `getHover` always read
// the file from DISK. As soon as the editor buffer diverged from disk, F# hover
// resolved the editor's line/char against stale on-disk text and returned the
// wrong symbol (or null). C# already honored the in-memory buffer; this restores
// F# to parity. [FS-DIDCHANGE-OVERLAY]
#[test]
fn test_full_stack_fsharp_hover_reflects_live_edit() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // Replace the whole buffer (full-sync didChange) with a document whose only
    // binding, `subtractEdited`, exists ONLY in the editor — never on disk.
    let edited = "namespace TestFSharp\n\
        \n\
        /// Edited-only module that lives solely in the editor buffer.\n\
        module Edited =\n    \
        /// Subtracts two integers; present only after a didChange, never on disk.\n    \
        let subtractEdited (a: int) (b: int) : int = a - b\n";
    client.change_document(&file_uri, 2, edited);

    // `subtractEdited` is on line 5 (0-based), column 12 sits inside the
    // identifier. Poll so FCS can re-check the overlay; today this never yields
    // the edited symbol because the sidecar re-reads the on-disk file.
    let needle = "subtractEdited";
    let deadline = std::time::Instant::now() + Duration::from_mins(1);
    loop {
        let h = hover(&mut client, &file_uri, 5, 12);
        assert_hover_ok(&h);
        let md = h["result"]["contents"]["value"].as_str().unwrap_or("");
        if md.contains(needle) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "F# hover must reflect the in-memory edit (`{needle}`), not the stale \
             on-disk file — the F# sidecar must honor didChange overlays. Last hover: {h}"
        );
        std::thread::sleep(Duration::from_secs(2));
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# Diagnostics (Full-Stack) ─────────────────────────────────
// A file that compiles cleanly must not be flooded with false errors. The F#
// sidecar's persistent project options must resolve the project's restored
// NuGet package references; otherwise every external `open`/type is reported as
// an unresolved-reference error even though `dotnet build` succeeds. Regression
// guard for issue #120 (F# false errors everywhere despite compiling cleanly).
#[test]
fn test_full_stack_fsharp_nuget_reference_resolves_no_false_errors() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_fsharp_nuget_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Block until the FCS background project load completes. Hover on the local
    // `Serializer` module (line 5, char 7) resolves from in-source symbols and is
    // unaffected by a missing external reference, so it is a clean readiness
    // signal even while the (bug) reference set is incomplete.
    let ready = poll_hover_until_ready(&mut client, &file_uri, 5, 7, Duration::from_secs(90));
    assert!(
        !ready.is_null(),
        "F# sidecar must load the project before diagnostics can be trusted"
    );

    // Pull diagnostics synchronously — deterministic, no publish race.
    let resp = client.request(
        "textDocument/diagnostic",
        json!({ "textDocument": { "uri": file_uri } }),
    );
    assert!(
        resp.get("error").is_none(),
        "pull diagnostics must not return an error: {resp}"
    );
    assert!(
        resp["result"]["items"].is_array(),
        "diagnostic report must carry an items array: {resp}"
    );
    let items = resp["result"]["items"].as_array().unwrap();

    // The file `open`s the restored Newtonsoft.Json package and calls
    // `JsonConvert` — both resolve once the sidecar feeds FCS the project's
    // package references. Any Error-severity diagnostic here is a false positive
    // from an incomplete reference set (#120).
    let errors: Vec<&Value> = items
        .iter()
        .filter(|d| d["severity"].as_u64() == Some(1))
        .collect();
    assert!(
        errors.is_empty(),
        "F# file that opens a restored NuGet package must compile clean — the F# \
         sidecar's project options are missing the resolved package references, so \
         `open Newtonsoft.Json` / `JsonConvert` are falsely flagged (#120). \
         Errors: {errors:?}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# Navigation (Full-Stack) ──────────────────────────────────
// Exercises the host→F# sidecar routing for go-to-definition, type-definition,
// project-wide references, and document highlights. FSAC parity: these are the
// `textDocument/definition|typeDefinition|references|documentHighlight` methods.

#[test]
fn test_full_stack_fsharp_navigation() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // definition: from the `Shape` annotation use → the `type Shape =` decl.
    let (du_line, du_char) = fs_pos::SHAPE_ANNOTATION_USE;
    let def = definition(&mut client, &file_uri, du_line, du_char);
    assert_nav_ok(&def);
    assert!(
        !def["result"].is_null(),
        "go-to-definition of `Shape` must resolve, got null"
    );
    let loc = first_location(&def["result"]);
    let (decl_line, _) = fs_pos::SHAPE_TYPE;
    assert_location_line(
        &loc,
        u64::from(decl_line),
        "definition of `Shape` must land on its `type Shape =` declaration",
    );
    assert!(
        loc["uri"].as_str().unwrap().ends_with("Library.fs"),
        "definition must point into Library.fs: {loc}"
    );

    // typeDefinition: the `shape` value has type `Shape` → `type Shape =`
    // (line 11). Fixed with GitHub #112: the fixture is now a valid top-level
    // `module` (was an invalid `namespace` with values), so `area` type-checks and
    // FCS resolves `shape`'s type to the `Shape` entity.
    let (sv_line, sv_char) = fs_pos::SHAPE_VALUE;
    let type_def = type_definition(&mut client, &file_uri, sv_line, sv_char);
    assert_nav_ok(&type_def);
    assert!(
        !type_def["result"].is_null(),
        "typeDefinition of `shape` must resolve to `type Shape =`, got null (#112)"
    );
    let tloc = first_location(&type_def["result"]);
    assert_location_line(
        &tloc,
        u64::from(decl_line),
        "typeDefinition of `shape` must resolve to `type Shape =`",
    );

    // references: well-formed, in-project locations for `Shape`. Use-site
    // completeness (the `: Shape` annotation in `area`) is asserted in the
    // dedicated `test_full_stack_fsharp_references_type_use_sites` (#112); here we
    // keep the shape/location invariants for the whole navigation surface.
    let refs = poll_references_until_ready(
        &mut client,
        &file_uri,
        fs_pos::SHAPE_TYPE.0,
        fs_pos::SHAPE_TYPE.1,
        Duration::from_mins(1),
    );
    let ref_arr = refs["result"].as_array().unwrap();
    assert!(
        !ref_arr.is_empty(),
        "references on `Shape` must resolve to at least its declaration"
    );
    for loc in ref_arr {
        assert_location_shape(loc);
        assert!(
            loc["uri"].as_str().unwrap().ends_with("Library.fs"),
            "every `Shape` reference must point into Library.fs: {loc}"
        );
    }

    // documentHighlight: file-local occurrences of `Shape`.
    let hl = document_highlight(
        &mut client,
        &file_uri,
        fs_pos::SHAPE_TYPE.0,
        fs_pos::SHAPE_TYPE.1,
    );
    assert_nav_ok(&hl);
    assert!(
        hl["result"].is_array(),
        "documentHighlight must return an array: {hl}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# References Use-Site Completeness (Full-Stack) ────────────
// Regression for GitHub #112: `textDocument/references` on a TYPE must return
// every use-site (FSAC/Ionide parity), not just the declaration. `references`
// on the `Shape` type (declared `type Shape =` on line 11) must include the
// `: Shape` annotation use in `area` (line 16). Before the fix the F# sidecar
// returned only the declaration (1 location) for entity/type symbols even though
// rename — which shares `getProjectUsages` — returned every use for values.
#[test]
fn test_full_stack_fsharp_references_type_use_sites() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    let refs = poll_references_until_ready(
        &mut client,
        &file_uri,
        fs_pos::SHAPE_TYPE.0,
        fs_pos::SHAPE_TYPE.1,
        Duration::from_mins(1),
    );
    let ref_arr = refs["result"].as_array().unwrap();

    // Every returned location must be well-formed and land in Library.fs.
    for loc in ref_arr {
        assert_location_shape(loc);
        assert!(
            loc["uri"].as_str().unwrap().ends_with("Library.fs"),
            "every `Shape` reference must point into Library.fs: {loc}"
        );
    }

    // FSAC parity: at least the declaration (line 11) + the `: Shape` annotation
    // use in `area` (line 16) must be present.
    assert!(
        ref_arr.len() >= 2,
        "references on `Shape` must include the `: Shape` annotation use in \
         `area` (FSAC parity), got {}: {refs}",
        ref_arr.len()
    );
    let (annotation_line, _) = fs_pos::SHAPE_ANNOTATION_USE;
    assert!(
        ref_arr.iter().any(|loc| {
            loc["range"]["start"]["line"].as_u64() == Some(u64::from(annotation_line))
        }),
        "references on `Shape` must include the `: Shape` annotation on line {annotation_line} \
         (the use-site in `area`), got: {refs}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# Language Surface (Full-Stack) ────────────────────────────
// One workspace load, every routed "language feature" request: documentSymbol,
// completion, signatureHelp, codeLens, inlayHint, semanticTokens. FSAC parity.

#[test]
fn test_full_stack_fsharp_language_surface() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // documentSymbol: the four top-level declarations must all be present.
    let symbols = document_request(&mut client, "textDocument/documentSymbol", &file_uri);
    assert_rpc_ok(&symbols, "documentSymbol");
    let sym_arr = symbols["result"]
        .as_array()
        .expect("documentSymbol must return an array");
    assert!(!sym_arr.is_empty(), "documentSymbol must not be empty");
    let sym_json = serde_json::to_string(&symbols["result"]).unwrap();
    for name in ["Calculator", "Shape", "area", "sumOfSquares"] {
        assert!(
            sym_json.contains(name),
            "documentSymbol must include `{name}`: {sym_json}"
        );
    }

    // completion: member completion right after the `.` in `List.map`.
    let completion = position_request(
        &mut client,
        "textDocument/completion",
        &file_uri,
        fs_pos::LIST_DOT,
    );
    assert_rpc_ok(&completion, "completion");
    let items = completion["result"]["items"]
        .as_array()
        .or_else(|| completion["result"].as_array())
        .expect("completion must return items");
    assert!(
        !items.is_empty(),
        "member completion after `List.` must offer candidates"
    );
    assert!(
        items.iter().all(|it| it.get("label").is_some()),
        "every completion item must have a label"
    );

    // signatureHelp: inside the `List.map (` application.
    let sig = position_request(
        &mut client,
        "textDocument/signatureHelp",
        &file_uri,
        fs_pos::LIST_MAP_CALL,
    );
    assert_rpc_ok(&sig, "signatureHelp");
    assert!(
        sig["result"].is_null() || sig["result"]["signatures"].is_array(),
        "signatureHelp must return null or a SignatureHelp with signatures[]: {sig}"
    );

    // codeLens: reference-count lenses above the top-level definitions.
    let lenses = document_request(&mut client, "textDocument/codeLens", &file_uri);
    assert_rpc_ok(&lenses, "codeLens");
    let lens_arr = lenses["result"]
        .as_array()
        .expect("codeLens must return an array");
    assert!(
        !lens_arr.is_empty(),
        "codeLens must produce reference-count lenses for the definitions"
    );
    let lens_json = serde_json::to_string(&lenses["result"])
        .unwrap()
        .to_lowercase();
    assert!(
        lens_json.contains("reference"),
        "F# code lenses are reference counts: {lens_json}"
    );

    // inlayHint: over the whole document.
    let hints = client.request(
        "textDocument/inlayHint",
        json!({
            "textDocument": { "uri": file_uri },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 30, "character": 0 }
            }
        }),
    );
    assert_rpc_ok(&hints, "inlayHint");
    assert!(
        hints["result"].is_array(),
        "inlayHint must return an array: {hints}"
    );

    // semanticTokens/full: the token stream must be non-empty for real source.
    let tokens = document_request(&mut client, "textDocument/semanticTokens/full", &file_uri);
    assert_rpc_ok(&tokens, "semanticTokens");
    let data = tokens["result"]["data"]
        .as_array()
        .expect("semanticTokens/full must return a data array");
    assert!(
        !data.is_empty(),
        "semanticTokens must classify tokens in a non-trivial file"
    );
    assert!(
        data.len().is_multiple_of(5),
        "semantic token data must be a flat stream of 5-tuples, got {}",
        data.len()
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# Workspace Symbol (Full-Stack) ────────────────────────────
// The editor's "Go to Symbol in Workspace" (Ctrl-T) must reach F# symbols. The
// host has no F# tree-sitter grammar, so the standard `workspace/symbol` handler
// routes F# files to the FCS sidecar's document symbols. [FS-WORKSPACE-SYMBOL]

#[test]
fn test_full_stack_fsharp_workspace_symbol() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // Exact query: the `Calculator` module must surface, located in the F# file.
    let calc = client.request("workspace/symbol", json!({ "query": "Calculator" }));
    assert_rpc_ok(&calc, "workspace/symbol(Calculator)");
    let calc_arr = calc["result"]
        .as_array()
        .expect("workspace/symbol must return an array");
    assert!(
        calc_arr.iter().any(|s| s["name"] == "Calculator"),
        "workspace/symbol must find the Calculator module: {calc}"
    );
    let calc_sym = calc_arr
        .iter()
        .find(|s| s["name"] == "Calculator")
        .expect("Calculator symbol present");
    // SymbolKind::Module == 2; the location must point back at Library.fs.
    assert_eq!(calc_sym["kind"], 2, "Calculator must be a Module");
    assert_eq!(
        calc_sym["location"]["uri"],
        json!(file_uri),
        "the F# symbol must locate in the opened document"
    );

    // The `Shape` discriminated union surfaces as an Enum-kind symbol
    // (FCS maps DU glyphs to Enum; SymbolKind::Enum == 10).
    let shape = client.request("workspace/symbol", json!({ "query": "Shape" }));
    let shape_arr = shape["result"].as_array().expect("array");
    assert!(
        shape_arr.iter().any(|s| s["name"] == "Shape"),
        "workspace/symbol must find the Shape type: {shape}"
    );
    let shape_sym = shape_arr
        .iter()
        .find(|s| s["name"] == "Shape")
        .expect("Shape symbol present");
    assert_eq!(
        shape_sym["kind"], 10,
        "Shape (a DU) must be an Enum-kind symbol"
    );

    // Fuzzy subsequence match: `calc` matches `Calculator`.
    let fuzzy = client.request("workspace/symbol", json!({ "query": "calc" }));
    assert!(
        fuzzy["result"]
            .as_array()
            .expect("array")
            .iter()
            .any(|s| s["name"] == "Calculator"),
        "fuzzy query `calc` must match the Calculator module: {fuzzy}"
    );

    // The empty query enumerates every F# symbol (module + members) in the file.
    let all = client.request("workspace/symbol", json!({ "query": "" }));
    let all_arr = all["result"].as_array().expect("array");
    assert!(
        all_arr.len() >= 4,
        "empty query must enumerate the F# symbols (got {}): {all}",
        all_arr.len()
    );
    assert!(
        all_arr
            .iter()
            .all(|s| s["location"]["uri"] == json!(file_uri)),
        "every F# workspace symbol must locate in the opened document"
    );

    // A nonsense query matches nothing.
    let none = client.request("workspace/symbol", json!({ "query": "zzqqxx" }));
    assert!(
        none["result"].as_array().expect("array").is_empty(),
        "a non-matching query must return no F# symbols: {none}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# Hierarchies (Full-Stack) ─────────────────────────────────
// Call hierarchy and type hierarchy — features FSAC does NOT provide; SharpLsp
// implements them via FCS AST traversal. Exercises prepare + a follow-up edge.

#[test]
fn test_full_stack_fsharp_hierarchies() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // prepareCallHierarchy on `add`.
    let prep_call = position_request(
        &mut client,
        "textDocument/prepareCallHierarchy",
        &file_uri,
        fs_pos::ADD_FN,
    );
    assert_rpc_ok(&prep_call, "prepareCallHierarchy");
    let call_items = prep_call["result"]
        .as_array()
        .expect("prepareCallHierarchy must return an array");
    assert!(
        !call_items.is_empty(),
        "prepareCallHierarchy on `add` must return an item"
    );
    assert_eq!(
        call_items[0]["name"].as_str(),
        Some("add"),
        "call hierarchy item must be named `add`: {prep_call}"
    );

    // incomingCalls for that item: `add` is never called → a (possibly empty) array.
    let incoming = client.request(
        "callHierarchy/incomingCalls",
        json!({ "item": call_items[0].clone() }),
    );
    assert_rpc_ok(&incoming, "incomingCalls");
    assert!(
        incoming["result"].is_array() || incoming["result"].is_null(),
        "incomingCalls must return an array (or null): {incoming}"
    );

    // prepareTypeHierarchy on `Shape`.
    let prep_type = position_request(
        &mut client,
        "textDocument/prepareTypeHierarchy",
        &file_uri,
        fs_pos::SHAPE_TYPE,
    );
    assert_rpc_ok(&prep_type, "prepareTypeHierarchy");
    let type_items = prep_type["result"]
        .as_array()
        .expect("prepareTypeHierarchy must return an array");
    assert!(
        !type_items.is_empty(),
        "prepareTypeHierarchy on `Shape` must return an item"
    );
    assert_eq!(
        type_items[0]["name"].as_str(),
        Some("Shape"),
        "type hierarchy item must be named `Shape`: {prep_type}"
    );

    // supertypes of `Shape`: System.Object is excluded → a (possibly empty) array.
    let supertypes = client.request(
        "typeHierarchy/supertypes",
        json!({ "item": type_items[0].clone() }),
    );
    assert_rpc_ok(&supertypes, "supertypes");
    assert!(
        supertypes["result"].is_array() || supertypes["result"].is_null(),
        "supertypes must return an array (or null): {supertypes}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# Rename (Full-Stack) ──────────────────────────────────────
// Flagship refactor: prepareRename gate + project-wide rename WorkspaceEdit.
// SharpLsp renames F# project-wide (FSAC/Ionide rename is file-local), so this
// is a parity-and-beyond workflow.

#[test]
fn test_full_stack_fsharp_rename() {
    let (_tmp, file_uri, mut client) = ready_fsharp_client();

    // prepareRename on `add` must return a renameable range.
    let prep = position_request(
        &mut client,
        "textDocument/prepareRename",
        &file_uri,
        fs_pos::ADD_FN,
    );
    assert_rpc_ok(&prep, "prepareRename");
    assert!(
        !prep["result"].is_null(),
        "prepareRename on `add` must return a range, got null"
    );
    let prep_json = serde_json::to_string(&prep["result"]).unwrap();
    assert!(
        prep_json.contains("\"start\""),
        "prepareRename must carry a range with a start position: {prep_json}"
    );

    // rename `add` -> `plus`: a WorkspaceEdit whose every edit rewrites to `plus`
    // and targets Library.fs.
    let (a_line, a_char) = fs_pos::ADD_FN;
    let rename = client.request(
        "textDocument/rename",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": a_line, "character": a_char },
            "newName": "plus"
        }),
    );
    assert_rpc_ok(&rename, "rename");
    assert!(
        !rename["result"].is_null(),
        "rename must return a WorkspaceEdit, got null"
    );
    let doc_changes = rename["result"]["documentChanges"]
        .as_array()
        .expect("rename result must have documentChanges");
    assert!(
        !doc_changes.is_empty(),
        "rename must produce at least one document change"
    );
    for dc in doc_changes {
        assert!(
            dc["textDocument"]["uri"]
                .as_str()
                .is_some_and(|u| u.ends_with("Library.fs")),
            "rename edits must target Library.fs: {dc}"
        );
        let edits = dc["edits"]
            .as_array()
            .expect("documentChange must have edits");
        assert!(!edits.is_empty(), "each documentChange must carry edits");
        assert!(
            edits.iter().all(|e| e["newText"].as_str() == Some("plus")),
            "every rename edit must rewrite to `plus`: {dc}"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// NOTE: F# references use-site completeness on a TYPE (the `: Shape` annotation
// in `area`) is covered live by `test_full_stack_fsharp_references_type_use_sites`
// and resolved with GitHub #112. Root cause was the shared fixture: `area` /
// `sumOfSquares` were `let` bindings placed directly in a `namespace` (illegal F#,
// FS0201), so they never type-checked and FCS recorded no `Shape` use-sites inside
// them. Making the fixture a valid top-level `module` restores full FSAC parity for
// references and typeDefinition.
