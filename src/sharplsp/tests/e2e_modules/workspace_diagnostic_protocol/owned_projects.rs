//! Compiler-owned projects outside editor roots retain live closed-file truth.
//! Implements [DIAG-TRUTH-GUARANTEES] and [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING].
use super::*;
use fixtures_medium::MediumWorkspace;

#[test]
fn empty_fsharp_slice_adopts_external_owners_and_preserves_live_compiler_truth() {
    exercise_owners(true);
}

#[test]
fn adopted_external_projects_refresh_sdk_repairs_without_editor_file_events() {
    exercise_owners(false);
}

/// Three user interactions: adopt real owners, repair both files on disk, regress both again.
fn exercise_owners(core_only: bool) {
    let primary = broken_workspace();
    let external = broken_workspace();
    let (mut client, mut traffic) = initial_graph(&primary, core_only);
    exercise_owned_inputs(&primary, &external, &mut client, &mut traffic);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

fn initial_graph(primary: &MediumWorkspace, core_only: bool) -> (LspClient, Vec<Value>) {
    let mut client = owner_client(primary, core_only);
    let mut traffic = Vec::new();
    let initial = complete_workspace_pull(&mut client, &mut traffic);
    assert_primary(
        primary,
        initial["result"]["items"]
            .as_array()
            .expect("initial scope"),
    );
    idle_restore::drain_for(&mut client, Duration::from_secs(3), &mut traffic);
    traffic.clear();
    (client, traffic)
}

fn exercise_owned_inputs(
    primary: &MediumWorkspace,
    external: &MediumWorkspace,
    client: &mut LspClient,
    traffic: &mut Vec<Value>,
) {
    open_owners(external, client, traffic);
    idle_restore::await_compiler_refresh(client, traffic);
    let mut previous = assert_owner_state(primary, external, client, traffic, true);
    for broken in [false, true] {
        previous = edit_owners(primary, external, client, traffic, &previous, broken);
    }
}

/// A C#-only initial selector leaves the real F# engine's language slice empty.
fn owner_client(primary: &MediumWorkspace, core_only: bool) -> LspClient {
    let root = if core_only {
        primary.root.join("Core")
    } else {
        primary.root.clone()
    };
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&root));
    let response = client.initialize_with_capabilities(
        json!(path_to_file_uri(&root)),
        json!({
            "textDocument":{"diagnostic":{}}, "workspace":{"diagnostics":{"refreshSupport":true}}
        }),
    );
    assert_rpc_ok(&response, "initialize selected SDK project graph");
    client
}

/// Semantic readiness applies only to initial asynchronous owner adoption, never disk repairs.
pub(super) fn open_owners(
    external: &MediumWorkspace,
    client: &mut LspClient,
    traffic: &mut Vec<Value>,
) {
    for (path, source, language, position) in clean_entries(external) {
        let uri = path_to_file_uri(&path);
        client.notify(
            "textDocument/didOpen",
            json!({"textDocument":{
                "uri":uri,"languageId":language,"version":1,"text":source
            }}),
        );
        await_owned_hover(client, &uri, position, traffic);
    }
}

/// Reuse the canonical modern request pump so negotiated refresh requests are acknowledged.
fn await_owned_hover(
    client: &mut LspClient,
    uri: &str,
    position: (u32, u32),
    traffic: &mut Vec<Value>,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let response = owned_hover(client, uri, position, traffic);
        if !response["result"].is_null() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the actual compiler must adopt the opened source"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn owned_hover(
    client: &mut LspClient,
    uri: &str,
    position: (u32, u32),
    traffic: &mut Vec<Value>,
) -> Value {
    observed_request(
        client,
        "textDocument/hover",
        json!({
            "textDocument":{"uri":uri},"position":{"line":position.0,"character":position.1}
        }),
        traffic,
    )
}

/// The primary graph survives adoption; the newly owned graph reports each real error once.
fn assert_owner_state(
    primary: &MediumWorkspace,
    external: &MediumWorkspace,
    client: &mut LspClient,
    traffic: &mut Vec<Value>,
    broken: bool,
) -> Vec<Value> {
    let response = complete_workspace_pull(client, traffic);
    let items = response["result"]["items"]
        .as_array()
        .expect("current owned compiler scope");
    assert_primary(primary, items);
    owned_errors(external)
        .into_iter()
        .map(|(path, code, source)| {
            let uri = path_to_file_uri(&path);
            let report = report_for(items, &uri);
            assert_owned_report(report, code, source, broken);
            json!({"uri":uri,"value":report["resultId"]})
        })
        .collect()
}

fn owned_errors(
    external: &MediumWorkspace,
) -> [(std::path::PathBuf, &'static str, &'static str); 2] {
    [
        (external.calculations_path(), "FS0001", "sharplsp-fsharp"),
        (
            external.root.join("Core/Broken.cs"),
            "CS0029",
            "sharplsp-csharp",
        ),
    ]
}

fn assert_primary(primary: &MediumWorkspace, items: &[Value]) {
    let uri = path_to_file_uri(&primary.root.join("Core/Broken.cs"));
    let report = report_for(items, &uri);
    assert_owned_report(report, "CS0029", "sharplsp-csharp", true);
}

/// Preserve identity, compiler severity/range and real errors through every source transition.
fn assert_owned_report(report: &Value, code: &str, source: &str, broken: bool) {
    assert_eq!(report["kind"], "full");
    assert!(report["resultId"].as_str().is_some_and(|id| !id.is_empty()));
    let diagnostics = report["items"]
        .as_array()
        .expect("actual compiler findings");
    if broken {
        assert_error(diagnostics, code, source);
    } else {
        assert!(diagnostics
            .iter()
            .all(|diagnostic| diagnostic["severity"] != 1));
    }
}

/// Real SDK builds and native file watching alone must invalidate the old diagnostic identities.
fn edit_owners(
    primary: &MediumWorkspace,
    external: &MediumWorkspace,
    client: &mut LspClient,
    traffic: &mut Vec<Value>,
    previous: &[Value],
    broken: bool,
) -> Vec<Value> {
    idle_restore::drain_for(client, Duration::from_secs(3), traffic);
    traffic.clear();
    write_owned_sources(external, broken);
    idle_restore::await_compiler_refresh(client, traffic);
    let current = assert_owner_state(primary, external, client, traffic, broken);
    for (now, old) in current.iter().zip(previous) {
        assert_eq!(now["uri"], old["uri"]);
        assert_ne!(
            now["value"], old["value"],
            "saved inputs invalidate their Salsa identities"
        );
    }
    current
}

fn write_owned_sources(external: &MediumWorkspace, broken: bool) {
    write_owned_fsharp(external, broken);
    std::fs::write(
        external.root.join("Core/Broken.cs"),
        if broken { BROKEN_CS } else { FIXED_CS },
    )
    .expect("edit owned C# disk source");
    assert_build(
        &external.root.join("FsDomain/FsDomain.fsproj"),
        broken.then_some("FS0001"),
    );
    assert_build(
        &external.root.join("Core/Core.csproj"),
        broken.then_some("CS0029"),
    );
}

fn write_owned_fsharp(external: &MediumWorkspace, broken: bool) {
    std::fs::write(
        external.calculations_path(),
        if broken {
            BROKEN_FS
        } else {
            fixtures_medium::CALCULATIONS_FS
        },
    )
    .expect("edit owned F# disk source");
}
