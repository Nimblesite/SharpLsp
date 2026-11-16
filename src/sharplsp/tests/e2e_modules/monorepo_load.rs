//! Standalone projects in nested monorepo folders load with no solution at
//! all, and beside a solution that does not list them (#575). The workspace
//! walk ignores `bin`/`obj`/`node_modules`; its projects load eagerly, so closed
//! files answer without waiting for owning-project adoption on open.
//! Implements [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY].
use super::*;
use workspace_diagnostic_support::*;

/// Start a pull-diagnostics client on `workspace`, VS Code-shaped.
fn monorepo_client(workspace: &MonorepoWorkspace) -> LspClient {
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    let initialized = client.initialize_with_capabilities(
        json!(workspace.root_uri()),
        json!({
            "textDocument":{"diagnostic":{"dynamicRegistration":false}},
            "workspace":{"diagnostics":{"refreshSupport":true}}
        }),
    );
    assert_rpc_ok(&initialized, "initialize monorepo session");
    client
}

/// Poll `workspace/diagnostic` until the closed file `uri` reports `code`,
/// proving the project that compiles it loaded without any of its files being
/// opened (#575). Returns the full report set for further assertions.
fn poll_closed_error(
    client: &mut LspClient,
    uri: &str,
    code: &str,
    source: &str,
    traffic: &mut Vec<Value>,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let response = completed_pull(
            client,
            "workspace/diagnostic",
            json!({"previousResultIds":[]}),
            traffic,
        );
        let items = workspace_reports(&response);
        let reported = items.iter().any(|item| {
            item["uri"] == uri
                && item["items"]
                    .as_array()
                    .is_some_and(|diagnostics| diagnostics.iter().any(|d| d["code"] == code))
        });
        if reported {
            let report = report_for(items, uri);
            assert_eq!(report["kind"], "full", "closed report is full: {report}");
            assert_error(
                report["items"].as_array().expect("report diagnostics"),
                code,
                source,
            );
            return response;
        }
        assert!(
            Instant::now() < deadline,
            "the project outside the solution must load and report {code} for {uri} (#575); \
             reports: {items:?}",
        );
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// Send `method` answering any server refresh requests on the way, and return
/// the response — `LspClient::request` would mistake a server request for it.
fn answered_request(client: &mut LspClient, method: &str, params: Value) -> Value {
    target_framework::request_answering(client, method, params).0
}

/// Poll hover until it returns content, answering server requests meanwhile.
fn poll_hover(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
    timeout: Duration,
) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let (response, _) = target_framework::request_answering(
            client,
            "textDocument/hover",
            json!({"textDocument": {"uri": uri},
                   "position": {"line": line, "character": character}}),
        );
        assert_hover_ok(&response);
        if !response["result"].is_null() {
            return response["result"].clone();
        }
        assert!(
            Instant::now() < deadline,
            "hover did not return content within {}s — sidecar failed to start or load workspace",
            timeout.as_secs(),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Pull one document's diagnostics past supersession, answering any refresh
/// the server asks for, and return the report's items.
fn document_diagnostics(client: &mut LspClient, uri: &str, label: &str) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(60);
    let response = settled(deadline, || {
        let (response, arrived) = target_framework::request_answering(
            client,
            "textDocument/diagnostic",
            json!({"textDocument": {"uri": uri}}),
        );
        assert!(
            arrived.iter().all(
                |message| message["method"] == "workspace/diagnostic/refresh"
                    || message["method"] == "workspace/projectInitializationComplete"
            ),
            "unexpected server request: {arrived:?}"
        );
        response
    });
    assert_rpc_ok(&response, label);
    response["result"]["items"]
        .as_array()
        .unwrap_or_else(|| panic!("{label}: diagnostic report must carry items: {response}"))
        .clone()
}

/// F# first: a nested `.fsproj` with no `.sln`/`.slnx` anywhere answers hover,
/// definition and diagnostics from its own project (#575).
#[test]
fn fsharp_project_in_solutionless_monorepo_answers_hover_definition_and_diagnostics() {
    require_dotnet();
    let workspace = create_monorepo_without_solution();
    let mut client = monorepo_client(&workspace);

    let uri = path_to_file_uri(&workspace.reports_path());
    client.notify(
        "textDocument/didOpen",
        json!({"textDocument": {"uri": uri, "languageId": "fsharp", "version": 1,
               "text": MONOREPO_REPORTS_FS}}),
    );

    let hover = poll_hover(&mut client, &uri, 3, 6, Duration::from_secs(120));
    let contents = serde_json::to_string(&hover["contents"]).unwrap();
    assert!(
        contents.contains("ReportLine"),
        "hover on the record must name it: {contents}"
    );

    let def = answered_request(
        &mut client,
        "textDocument/definition",
        json!({"textDocument": {"uri": uri},
               "position": {"line": 6, "character": 18}}),
    );
    assert_nav_ok(&def);
    assert!(!def["result"].is_null(), "definition must resolve: {def}");
    let location = first_location(&def["result"]);
    assert_wellformed_file_uri(location["uri"].as_str().unwrap(), "ReportLine definition");
    assert_location_line(&location, 3, "ReportLine definition lands on the record");

    let items = document_diagnostics(&mut client, &uri, "Reports.fs pull");
    assert!(
        items.iter().all(|item| item["severity"] != 1),
        "restored clean project reports no compiler errors: {items:?}"
    );

    client.shutdown_and_exit();
}

/// A nested `.csproj` with no `.sln`/`.slnx` anywhere answers hover, definition
/// and diagnostics from its own project (#575).
#[test]
fn csharp_project_in_solutionless_monorepo_answers_hover_definition_and_diagnostics() {
    require_dotnet();
    let workspace = create_monorepo_without_solution();
    let mut client = monorepo_client(&workspace);

    let uri = path_to_file_uri(&workspace.cms_program_path());
    client.open_document(&uri, MONOREPO_PROGRAM_CS);

    let hover = poll_hover(&mut client, &uri, 3, 13, Duration::from_secs(120));
    assert_eq!(hover["contents"]["kind"], "markdown", "hover is markdown");
    let value = hover["contents"]["value"].as_str().unwrap();
    assert!(
        value.contains("CmsCalculator"),
        "hover on the class must name it: {value}"
    );
    assert!(
        value.contains("class"),
        "hover on the class shows its kind: {value}"
    );

    let def = answered_request(
        &mut client,
        "textDocument/definition",
        json!({"textDocument": {"uri": uri},
               "position": {"line": 7, "character": 31}}),
    );
    assert_nav_ok(&def);
    assert!(!def["result"].is_null(), "definition must resolve: {def}");
    let location = first_location(&def["result"]);
    assert_wellformed_file_uri(location["uri"].as_str().unwrap(), "Add definition");
    assert_location_line(&location, 5, "Add definition lands on its declaration");

    let items = document_diagnostics(&mut client, &uri, "Program.cs pull");
    assert!(
        items.iter().all(|item| item["severity"] != 1),
        "restored clean project reports no compiler errors: {items:?}"
    );

    client.shutdown_and_exit();
}

/// An F# project the solution does not list still loads: its closed file's
/// compiler-confirmed error reaches workspace diagnostics (#575).
#[test]
fn solution_still_loads_fsharp_project_it_does_not_list() {
    require_dotnet();
    let workspace = create_monorepo_with_excluding_solution();
    let mut client = monorepo_client(&workspace);
    let mut traffic = Vec::new();

    let stats_uri = path_to_file_uri(&workspace.stats_path());
    let reports = poll_closed_error(
        &mut client,
        &stats_uri,
        "FS0001",
        "sharplsp-fsharp",
        &mut traffic,
    );
    assert!(
        !workspace_reports(&reports).is_empty(),
        "workspace diagnostics report closed F# sources"
    );

    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// A C# project the solution does not list still loads: its closed file's
/// compiler-confirmed error reaches workspace diagnostics, while the listed
/// project keeps answering (#575).
#[test]
fn solution_still_loads_csharp_project_it_does_not_list() {
    require_dotnet();
    let workspace = create_monorepo_with_excluding_solution();
    let mut client = monorepo_client(&workspace);
    let mut traffic = Vec::new();

    // The listed project itself keeps answering: hover its anchor type.
    let lib_uri = path_to_file_uri(&workspace.entities_path());
    client.open_document(&lib_uri, EXCLUDED_LIB_CS);
    let hover = poll_hover(&mut client, &lib_uri, 3, 13, Duration::from_secs(120));
    let contents = serde_json::to_string(&hover["contents"]).unwrap();
    assert!(
        contents.contains("LibraryAnchor"),
        "listed project still answers hover: {contents}"
    );

    let tool_uri = path_to_file_uri(&workspace.tool_path());
    let reports = poll_closed_error(
        &mut client,
        &tool_uri,
        "CS0029",
        "sharplsp-csharp",
        &mut traffic,
    );
    assert!(
        !workspace_reports(&reports).is_empty(),
        "workspace diagnostics report the excluded project's closed sources"
    );

    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// [DIAG-CONFIG-OWNED-SOURCES] F# first: workspace diagnostics report the
/// developer's files only. Build output the project compiles and projects under
/// a gitignored folder have no report at all, while either still answers its
/// own diagnostics once opened.
#[test]
fn workspace_pull_reports_neither_build_output_nor_gitignored_projects() {
    require_dotnet();
    let workspace = create_repository_with_unowned_sources();
    let mut client = monorepo_client(&workspace);
    let mut traffic = Vec::new();
    let stats = workspace.root.join("apps/stats");
    let stats_uri = path_to_file_uri(&stats.join("Stats.fs"));

    // Interaction 1 — the developer's closed file is reported: the workspace loaded.
    let response = poll_closed_error(
        &mut client,
        &stats_uri,
        "FS0001",
        "sharplsp-fsharp",
        &mut traffic,
    );
    let uris: Vec<&str> = workspace_reports(&response)
        .iter()
        .filter_map(|report| report["uri"].as_str())
        .collect();

    // Interaction 2 — nothing under `obj/` or the gitignored `vendor/` has a report.
    assert!(
        uris.iter().all(|uri| !uri.contains("/obj/")),
        "build output is never reported: {uris:?}"
    );
    assert!(
        uris.iter().all(|uri| !uri.contains("/vendor/")),
        "gitignored projects are never reported: {uris:?}"
    );
    assert_eq!(uris, [stats_uri.as_str()], "the one owned source file");

    // Interaction 3 — opened on purpose, the generated file answers for itself.
    let generated_uri = path_to_file_uri(&stats.join("obj/Generated.fs"));
    client.notify(
        "textDocument/didOpen",
        json!({"textDocument": {"uri": generated_uri, "languageId": "fsharp", "version": 1,
               "text": GENERATED_FS}}),
    );
    let generated = document_diagnostics(&mut client, &generated_uri, "obj/Generated.fs pull");
    assert!(
        generated.iter().any(|item| item["code"] == "FS0001"),
        "an opened generated file still gets its diagnostics: {generated:?}"
    );

    client.shutdown_and_exit();
}
