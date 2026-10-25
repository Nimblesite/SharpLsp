//! Real compiler oracles and observable protocol traffic. [DIAG-LSP-PULL]
use super::*;
use fixtures_medium::{create_medium_workspace, MediumWorkspace, CALCULATIONS_FS};

/// The same real clean compiler inputs and load-bearing coordinates serve every mixed session.
pub type CleanEntry = (std::path::PathBuf, &'static str, &'static str, (u32, u32));

pub fn clean_entries(workspace: &MediumWorkspace) -> [CleanEntry; 2] {
    [
        (
            workspace.domain_path(),
            fixtures_medium::DOMAIN_FS,
            "fsharp",
            fixtures_medium::fs_med_pos::PRODUCT_TYPE,
        ),
        (
            workspace.entities_path(),
            fixtures_medium::ENTITIES_CS,
            "csharp",
            fixtures_medium::cs_med_pos::CUSTOMER_CLASS,
        ),
    ]
}

/// Complete F# source with one compiler-confirmed type error.
pub const BROKEN_FS: &str = "module Medium.FsDomain.Calculations\n\nlet value: int = \"oops\"\n";
/// Complete C# source with one compiler-confirmed type error.
pub const BROKEN_CS: &str = "namespace Medium.Core;\npublic static class Broken {\n public static int Value => \"oops\";\n}\n";
/// The same C# declaration with a valid return value.
pub const FIXED_CS: &str =
    "namespace Medium.Core;\npublic static class Broken {\n public static int Value => 42;\n}\n";

/// Restore real projects and verify their closed-file errors independently.
pub fn broken_workspace() -> MediumWorkspace {
    require_dotnet();
    let workspace = create_medium_workspace();
    std::fs::write(workspace.calculations_path(), BROKEN_FS).expect("write closed F# error");
    std::fs::write(workspace.root.join("Core/Broken.cs"), BROKEN_CS)
        .expect("write closed C# error");
    assert_build(
        &workspace.root.join("FsDomain/FsDomain.fsproj"),
        Some("FS0001"),
    );
    assert_build(&workspace.root.join("Core/Core.csproj"), Some("CS0029"));
    workspace
}

/// Enough genuine SDK source documents to observe and interrupt streamed analysis.
pub fn loaded_workspace() -> MediumWorkspace {
    let workspace = broken_workspace();
    for index in 0..128 {
        std::fs::write(
            workspace
                .root
                .join("Core")
                .join(format!("ScanLoad{index:03}.cs")),
            "file static class ScanLoad { public static int Value => 42; }\n",
        )
        .expect("write real SDK source file");
    }
    assert_build(&workspace.root.join("Core/Core.csproj"), Some("CS0029"));
    workspace
}

/// Check the actual SDK compiler's status and expected diagnostic code.
pub fn assert_build(project: &std::path::Path, error: Option<&str>) {
    let output = Command::new("dotnet")
        .args(["build", "--no-restore", "--nologo", "-v:minimal"])
        .current_dir(project.parent().expect("project directory"))
        .arg(project.file_name().expect("project name"))
        .output()
        .expect("run independent compiler oracle");
    let text = String::from_utf8_lossy(&output.stdout);
    assert_eq!(
        output.status.success(),
        error.is_none(),
        "compiler status: {text}"
    );
    if let Some(code) = error {
        assert!(text.contains(code), "compiler must confirm {code}: {text}");
        assert!(
            !text.contains("MSB3248"),
            "oracle must fail on source, not environment"
        );
    }
}

/// Repair both closed files, prove clean builds, and notify the live server.
pub fn repair_workspace(workspace: &MediumWorkspace, client: &mut LspClient) {
    std::fs::write(workspace.calculations_path(), CALCULATIONS_FS).expect("repair F# disk source");
    let broken = workspace.root.join("Core/Broken.cs");
    std::fs::write(&broken, FIXED_CS).expect("repair C# disk source");
    assert_build(&workspace.root.join("FsDomain/FsDomain.fsproj"), None);
    assert_build(&workspace.root.join("Core/Core.csproj"), None);
    client.notify(
        "workspace/didChangeWatchedFiles",
        json!({"changes":[
            {"uri":path_to_file_uri(&workspace.calculations_path()),"type":2},
            {"uri":path_to_file_uri(&broken),"type":2}
        ]}),
    );
}

/// Reuse the canonical request pump while retaining refreshes and publications.
pub fn observed_request(
    client: &mut LspClient,
    method: &str,
    params: Value,
    traffic: &mut Vec<Value>,
) -> Value {
    let response = observed_response(client, method, params, traffic);
    assert_rpc_ok(&response, method);
    response
}

/// Record server traffic before classifying the current request's terminal response.
fn observed_response(
    client: &mut LspClient,
    method: &str,
    params: Value,
    traffic: &mut Vec<Value>,
) -> Value {
    let (response, messages) = target_framework::request_answering(client, method, params);
    for message in &messages {
        if message.get("id").is_some() && message.get("method").is_some() {
            assert_eq!(
                message["method"], "workspace/diagnostic/refresh",
                "unexpected server request"
            );
        }
    }
    traffic.extend(messages);
    response
}

/// Retry only standard superseded snapshots; return the first successful compiler truth.
pub fn completed_pull(
    client: &mut LspClient,
    method: &str,
    params: Value,
    traffic: &mut Vec<Value>,
) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_mins(1);
    completed_pull_before(client, method, params, traffic, deadline)
}

/// A caller's convergence deadline includes every correctly superseded attempt.
pub fn completed_pull_before(
    client: &mut LspClient,
    method: &str,
    params: Value,
    traffic: &mut Vec<Value>,
    deadline: Instant,
) -> Value {
    loop {
        let response = observed_response(client, method, params.clone(), traffic);
        if response.get("error").is_none() {
            assert_rpc_ok(&response, method);
            return response;
        }
        assert_superseded(&response);
        assert!(
            std::time::Instant::now() < deadline,
            "compiler analysis did not complete: {response}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Superseded truth is explicitly retryable and cannot masquerade as clean output.
pub fn assert_superseded(response: &Value) {
    assert_eq!(
        response["error"]["code"], -32802,
        "superseded scan: {response}"
    );
    assert_eq!(response["error"]["data"]["retriggerRequest"], true);
    assert!(response.get("result").is_none());
}

/// Require one report per document, rejecting both missing and duplicate reports.
pub fn report_for<'a>(items: &'a [Value], uri: &str) -> &'a Value {
    let matching: Vec<_> = items.iter().filter(|item| item["uri"] == uri).collect();
    assert_eq!(matching.len(), 1, "exactly one report for {uri}: {items:?}");
    matching[0]
}

/// Borrow the complete workspace report array without changing any compiler report.
pub fn workspace_reports(response: &Value) -> &[Value] {
    response["result"]["items"]
        .as_array()
        .expect("workspace diagnostic reports")
}

/// Check the exact compiler error count, origin, severity, and source range.
pub fn assert_error(items: &[Value], code: &str, source: &str) {
    let errors: Vec<_> = items.iter().filter(|item| item["severity"] == 1).collect();
    assert_eq!(errors.len(), 1, "one compiler error: {items:?}");
    let error = errors[0];
    assert_eq!(error["code"], code);
    assert_eq!(error["source"], source);
    assert_eq!(error["range"]["start"]["line"], 2);
    assert_eq!(error["range"]["end"]["line"], 2);
    assert!(
        error["range"]["end"]["character"].as_u64() > error["range"]["start"]["character"].as_u64()
    );
    assert!(error["message"]
        .as_str()
        .is_some_and(|message| !message.is_empty()));
}

/// Pull clients must receive diagnostics through only their negotiated model.
pub fn assert_no_push(traffic: &[Value]) {
    assert!(
        !traffic
            .iter()
            .any(|message| message["method"] == "textDocument/publishDiagnostics"),
        "negotiated pull must not duplicate diagnostics with pushes: {traffic:?}"
    );
}
