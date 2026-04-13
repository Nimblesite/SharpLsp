use super::*;

// ── DIAGNOSTICS TESTS ────────────────────────────────────────────

// didClose sends empty publishDiagnostics unconditionally (no sidecar needed).

#[test]
fn test_diagnostics_cleared_on_close_raw_recv() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace Test { public class Foo { } }\n";
    client.open_document(TEST_URI, code);
    client.close_document(TEST_URI);

    // Without a sidecar, the clear notification is the only message.
    let msg = client.recv();
    assert_eq!(
        msg["method"].as_str().unwrap(),
        "textDocument/publishDiagnostics",
        "must receive publishDiagnostics on close",
    );
    let params = &msg["params"];
    assert_eq!(
        params["uri"].as_str().unwrap(),
        TEST_URI,
        "diagnostics URI must match closed document",
    );
    let diagnostics = params["diagnostics"].as_array().unwrap();
    assert!(
        diagnostics.is_empty(),
        "diagnostics must be empty after didClose",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// request() skips diagnostic notifications correctly.

#[test]
fn test_request_works_after_diagnostic_notification() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace Test { public class Foo { } }\n";
    client.open_document(TEST_URI, code);
    client.close_document(TEST_URI);
    client.open_document(TEST_URI, code);

    // Close sent a diagnostic notification. request() must skip it.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(
        resp.get("error").is_none(),
        "documentSymbol must succeed after diagnostic notifications",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Verify diagnosticProvider advertises workspace diagnostics.

#[test]
fn test_capabilities_advertise_workspace_diagnostics() {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let capabilities = &resp["result"]["capabilities"];
    let diag_provider = &capabilities["diagnosticProvider"];
    assert!(
        !diag_provider.is_null(),
        "diagnosticProvider must be advertised",
    );
    assert_eq!(
        diag_provider["interFileDependencies"],
        json!(true),
        "interFileDependencies must be true",
    );
    assert_eq!(
        diag_provider["workspaceDiagnostics"],
        json!(true),
        "workspaceDiagnostics must be true",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Multiple documents: closing one clears only that document's diagnostics.

#[test]
fn test_diagnostics_cleared_independently_per_document() {
    let uri_a = "file:///test/A.cs";
    let uri_b = "file:///test/B.cs";
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(uri_a, "namespace A { public class Alpha { } }");
    client.open_document(uri_b, "namespace B { public class Beta { } }");

    // Close only document A — should clear A, not B.
    client.close_document(uri_a);
    let msg = client.recv();
    assert_eq!(
        msg["method"].as_str().unwrap(),
        "textDocument/publishDiagnostics",
    );
    assert_eq!(
        msg["params"]["uri"].as_str().unwrap(),
        uri_a,
        "clear must target the closed document",
    );
    assert!(
        msg["params"]["diagnostics"].as_array().unwrap().is_empty(),
        "closed document diagnostics must be empty",
    );

    // Document B is still open — a request on it must succeed.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": uri_b } }),
    );
    assert!(
        resp.get("error").is_none(),
        "document B must still be usable after closing A",
    );
    let symbols = resp["result"].as_array().unwrap();
    assert!(!symbols.is_empty(), "document B must still return symbols",);

    // Now close B — it should also be cleared.
    client.close_document(uri_b);
    let msg_b = client.recv();
    assert_eq!(
        msg_b["params"]["uri"].as_str().unwrap(),
        uri_b,
        "clear must target B after closing B",
    );
    assert!(
        msg_b["params"]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty(),
        "B diagnostics must be empty",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Edit cycle: open → change → close produces clear notification.

#[test]
fn test_diagnostics_clear_after_edit_cycle() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code_v1 = "namespace Test { public class V1 { } }";
    let code_v2 = "namespace Test { public class V2 { public int X; } }";

    client.open_document(TEST_URI, code_v1);
    client.change_document(TEST_URI, 2, code_v2);

    // The VFS should hold the latest version. Verify via documentSymbol.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "symbol request must succeed");
    let symbols = resp["result"].as_array().unwrap();
    let children = symbols[0]["children"].as_array().unwrap();
    let class_name = children[0]["name"].as_str().unwrap();
    assert_eq!(class_name, "V2", "VFS must reflect the changed content");

    // Close and verify clear.
    client.close_document(TEST_URI);
    let msg = client.recv();
    assert_eq!(
        msg["method"].as_str().unwrap(),
        "textDocument/publishDiagnostics",
    );
    assert!(
        msg["params"]["diagnostics"].as_array().unwrap().is_empty(),
        "diagnostics must be cleared after edit+close cycle",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Rapid open/close cycles: each close must produce a clear notification.

#[test]
fn test_diagnostics_rapid_open_close_cycles() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let uris = [
        "file:///test/Rapid1.cs",
        "file:///test/Rapid2.cs",
        "file:///test/Rapid3.cs",
    ];

    // Open and immediately close all three.
    for uri in &uris {
        client.open_document(uri, "namespace Rapid { }");
        client.close_document(uri);
    }

    // Must receive exactly 3 clear notifications, one per URI.
    let mut cleared_uris: Vec<String> = Vec::new();
    for _ in 0..uris.len() {
        let msg = client.recv();
        assert_eq!(
            msg["method"].as_str().unwrap(),
            "textDocument/publishDiagnostics",
            "each close must produce a publishDiagnostics",
        );
        assert!(
            msg["params"]["diagnostics"].as_array().unwrap().is_empty(),
            "diagnostics must be empty",
        );
        cleared_uris.push(msg["params"]["uri"].as_str().unwrap().to_string());
    }

    // All three URIs must have been cleared (order may vary).
    for uri in &uris {
        assert!(
            cleared_uris.iter().any(|s| s.as_str() == *uri),
            "expected {uri} in cleared set, got {cleared_uris:?}",
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Reopen after close: diagnostics flow restarts cleanly.

#[test]
fn test_diagnostics_reopen_after_close() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace Test { public class Reopen { } }";

    // Open → close → collect clear notification.
    client.open_document(TEST_URI, code);
    client.close_document(TEST_URI);
    let clear_msg = client.recv();
    assert!(
        clear_msg["params"]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty(),
        "first close must clear",
    );

    // Reopen the same document.
    client.open_document(TEST_URI, code);

    // Verify the VFS has the content again — documentSymbol should work.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "must succeed after reopen");
    let symbols = resp["result"].as_array().unwrap();
    assert!(!symbols.is_empty(), "reopened document must have symbols");
    let children = symbols[0]["children"].as_array().unwrap();
    assert_eq!(
        children[0]["name"].as_str().unwrap(),
        "Reopen",
        "must see the reopened content",
    );

    // Close again — second clear notification.
    client.close_document(TEST_URI);
    let clear_msg2 = client.recv();
    assert_eq!(clear_msg2["params"]["uri"].as_str().unwrap(), TEST_URI,);
    assert!(
        clear_msg2["params"]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty(),
        "second close must also clear",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Full-stack: solution-wide diagnostics fire after workspace load.

#[test]
fn test_full_stack_solution_wide_diagnostics_on_load() {
    require_dotnet();

    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("DiagTest");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("DiagTest.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    // File with a deliberate type error: UndefinedType doesn't exist.
    let cs_source = r"namespace DiagTest;

public class Broken
{
    public UndefinedType Oops { get; set; }
}
";
    std::fs::write(proj_dir.join("Broken.cs"), cs_source).unwrap();

    std::fs::write(
        tmp.path().join("DiagTest.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "DiagTest", "DiagTest/DiagTest.csproj", "{00000000-0000-0000-0000-000000000001}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        .current_dir(&proj_dir)
        .status()
        .expect("dotnet restore failed");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(tmp.path()).unwrap();
    let root_uri = format!("file://{}", real_root.display());
    let broken_path = real_root.join("DiagTest").join("Broken.cs");
    let broken_uri = format!("file://{}", broken_path.display());

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));

    client.open_document(&broken_uri, cs_source);

    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut found_error = false;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(3));
        client.save_document(&broken_uri);
        std::thread::sleep(Duration::from_secs(2));

        client.close_document(&broken_uri);
        let msg = client.recv();

        if msg["method"].as_str() == Some("textDocument/publishDiagnostics") {
            let diags = msg["params"]["diagnostics"].as_array().unwrap();
            if !diags.is_empty() {
                let has_error = diags.iter().any(|d| {
                    d["message"]
                        .as_str()
                        .is_some_and(|m| m.contains("UndefinedType") || m.contains("CS0246"))
                });
                if has_error {
                    found_error = true;
                    let diag = &diags[0];
                    assert!(
                        diag["range"]["start"]["line"].as_u64().is_some(),
                        "diagnostic must have a range",
                    );
                    assert!(
                        diag["severity"].as_u64().is_some(),
                        "diagnostic must have severity",
                    );
                    assert_eq!(
                        diag["source"].as_str().unwrap(),
                        "forge-csharp",
                        "source must be forge-csharp",
                    );
                    break;
                }
            }
        }

        client.open_document(&broken_uri, cs_source);
    }

    assert!(
        found_error,
        "solution-wide diagnostics must detect UndefinedType error in Broken.cs within 90s",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
