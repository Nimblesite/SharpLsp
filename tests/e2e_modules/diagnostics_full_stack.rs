use super::*;

// ── FULL-STACK DIAGNOSTICS TESTS ─────────────────────────────────

// Full-stack: single-file diagnostics on didOpen detect type errors.

#[test]
fn test_full_stack_diagnostics_on_open_detects_errors() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("ErrTest");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("ErrTest.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    let good_source = r"namespace ErrTest;
public class Good { public int Value { get; set; } }
";
    std::fs::write(proj_dir.join("Good.cs"), good_source).unwrap();

    let bad_source = r"namespace ErrTest;
public class Bad
{
    public MissingType Broken { get; set; }
}
";
    std::fs::write(proj_dir.join("Bad.cs"), bad_source).unwrap();

    std::fs::write(
        tmp.path().join("ErrTest.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "ErrTest", "ErrTest/ErrTest.csproj", "{00000000-0000-0000-0000-000000000001}"
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
    let bad_path = real_root.join("ErrTest").join("Bad.cs");
    let bad_uri = format!("file://{}", bad_path.display());

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));

    // Open the bad file to trigger per-file diagnostics.
    client.open_document(&bad_uri, bad_source);

    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut found = false;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(3));
        client.save_document(&bad_uri);
        std::thread::sleep(Duration::from_secs(2));

        client.close_document(&bad_uri);
        let msg = client.recv();

        if msg["method"].as_str() == Some("textDocument/publishDiagnostics") {
            let diags = msg["params"]["diagnostics"].as_array().unwrap();
            if !diags.is_empty() {
                for diag in diags {
                    let msg_text = diag["message"].as_str().unwrap_or("");
                    if msg_text.contains("MissingType") || msg_text.contains("CS0246") {
                        found = true;
                        assert_eq!(diag["source"].as_str().unwrap(), "forge-csharp",);
                        assert!(
                            diag["severity"].as_u64().unwrap() <= 2,
                            "type error must be Error(1) or Warning(2)",
                        );
                        assert!(
                            diag["code"].is_object()
                                || diag["code"].is_string()
                                || diag["code"].is_number(),
                            "diagnostic must have a code",
                        );
                        break;
                    }
                }
                if found {
                    break;
                }
            }
        }

        client.open_document(&bad_uri, bad_source);
    }

    assert!(
        found,
        "didOpen on a file with MissingType must produce CS0246 diagnostics within 90s",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Full-stack: clean file produces no error diagnostics.

#[test]
fn test_full_stack_diagnostics_clean_file_no_errors() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("CleanTest");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("CleanTest.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    let clean_source = r#"namespace CleanTest;
public class AllGood
{
    public int Value { get; set; }
    public string Name { get; set; } = "";
}
"#;
    std::fs::write(proj_dir.join("AllGood.cs"), clean_source).unwrap();

    std::fs::write(
        tmp.path().join("CleanTest.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "CleanTest", "CleanTest/CleanTest.csproj", "{00000000-0000-0000-0000-000000000001}"
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
    let file_path = real_root.join("CleanTest").join("AllGood.cs");
    let file_uri = format!("file://{}", file_path.display());

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, clean_source);

    let hover_result =
        poll_hover_until_ready(&mut client, &file_uri, 2, 14, Duration::from_secs(90));
    assert!(
        !hover_result.is_null(),
        "hover must work once sidecar is ready",
    );

    client.save_document(&file_uri);
    std::thread::sleep(Duration::from_secs(5));
    client.close_document(&file_uri);

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut found_our_file = false;
    while std::time::Instant::now() < deadline {
        let msg = client.recv();
        if msg["method"].as_str() != Some("textDocument/publishDiagnostics") {
            continue;
        }
        let msg_uri = msg["params"]["uri"].as_str().unwrap_or("");
        if msg_uri != file_uri {
            continue;
        }
        let diags = msg["params"]["diagnostics"].as_array().unwrap();
        let has_errors = diags
            .iter()
            .any(|d| d["severity"].as_u64().is_some_and(|s| s == 1));
        assert!(
            !has_errors,
            "clean file must not produce Error-severity diagnostics, got: {diags:?}",
        );
        found_our_file = true;
        break;
    }

    assert!(
        found_our_file,
        "must receive publishDiagnostics for our file",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Full-stack: after didChange fixes an error, the LAST
// publishDiagnostics for that file must have zero Error diagnostics.
//
// The Rust host fires notify_did_change and trigger_diagnostics as
// independent fire-and-forget async spawns. If trigger_diagnostics
// grabs the sidecar transport lock before notify_did_change, it
// fetches stale compilation state and publishes stale errors. No
// correction ever follows — the stale errors persist in the Problems
// panel.
//
// The fix: notify_did_change must complete before trigger_diagnostics
// runs, OR a verification pass must correct stale results.
//
// This test is deterministic because didOpen does NOT call
// notify_did_change — it only calls trigger_diagnostics. So after
// closing and reopening with fixed text, the sidecar still has the
// OLD source in its _solution. Pull diagnostics (which use
// GetDiagnosticsAsync on the sidecar's _solution) will return stale
// errors every time.

#[test]
fn test_full_stack_diagnostics_cleared_after_error_fixed() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("VerifyTest");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("VerifyTest.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    // Start with a real compilation error.
    let broken_source = r"namespace VerifyTest;
public class Item
{
    public BogusType Value { get; set; }
}
";
    std::fs::write(proj_dir.join("Item.cs"), broken_source).unwrap();

    std::fs::write(
        tmp.path().join("VerifyTest.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "VerifyTest", "VerifyTest/VerifyTest.csproj", "{00000000-0000-0000-0000-000000000001}"
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
    let file_path = real_root.join("VerifyTest").join("Item.cs");
    let item_uri = format!("file://{}", file_path.display());

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));

    // Step 1: Open the broken file and wait for sidecar to detect it.
    client.open_document(&item_uri, broken_source);

    let scan_deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut found_error = false;
    while std::time::Instant::now() < scan_deadline {
        std::thread::sleep(Duration::from_secs(3));
        client.save_document(&item_uri);
        std::thread::sleep(Duration::from_secs(2));
        let resp = client.request(
            "textDocument/diagnostic",
            json!({ "textDocument": { "uri": item_uri } }),
        );
        if let Some(items) = resp["result"]["items"].as_array() {
            if items.iter().any(|d| {
                d["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("BogusType") || m.contains("CS0246"))
            }) {
                found_error = true;
                break;
            }
        }
    }
    assert!(found_error, "sidecar must detect BogusType error");

    // Step 2: Fix the file on disk. Then close and reopen with fixed
    // text. didOpen does NOT call notify_did_change, so the sidecar's
    // internal _solution still has the broken source. This is
    // deterministic — the sidecar ALWAYS has stale text after this.
    let fixed_source = r"namespace VerifyTest;
public class Item
{
    public int Value { get; set; }
}
";
    std::fs::write(&file_path, fixed_source).unwrap();
    client.close_document(&item_uri);
    // Consume the close clear notification.
    let _ = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": "file:///dev/null" } }),
    );
    client.open_document(&item_uri, fixed_source);

    // Step 3: Pull diagnostics. The sidecar's _solution still has
    // BogusType because didOpen doesn't update sidecar text. The
    // host must ensure the sidecar text is synced on didOpen.
    std::thread::sleep(Duration::from_secs(3));
    let resp = client.request(
        "textDocument/diagnostic",
        json!({ "textDocument": { "uri": item_uri } }),
    );
    let items = resp["result"]["items"].as_array().unwrap();
    let errors: Vec<String> = items
        .iter()
        .filter(|d| d["severity"].as_u64() == Some(1))
        .map(|d| {
            format!(
                "{}: {}",
                d["code"].as_str().unwrap_or("?"),
                d["message"].as_str().unwrap_or("?")
            )
        })
        .collect();

    assert!(
        errors.is_empty(),
        "After closing and reopening with fixed source, pull diagnostics \
         must return zero errors. The sidecar must sync document text on \
         didOpen — not just on didChange. Stale errors: {errors:?}. \
         Forge does not lie.",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Full-stack: diagnostics refreshed on didChange — edit introduces error.

#[test]
fn test_full_stack_diagnostics_refreshed_on_did_change() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_path, file_uri, clean_source) = create_change_test_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, clean_source);

    // Wait for sidecar readiness via hover polling.
    let hover_result =
        poll_hover_until_ready(&mut client, &file_uri, 2, 14, Duration::from_secs(90));
    assert!(
        !hover_result.is_null(),
        "hover must work once sidecar is ready",
    );

    // Now edit the file to introduce a type error.
    let broken_source = r"namespace ChangeTest;
public class Widget
{
    public NonExistentType Count { get; set; }
}
";
    client.change_document(&file_uri, 2, broken_source);
    // Also update the file on disk for the sidecar to pick up.
    std::fs::write(&file_path, broken_source).unwrap();

    // Poll for error diagnostics after the change.
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut found_error = false;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(3));
        client.save_document(&file_uri);
        std::thread::sleep(Duration::from_secs(2));

        client.close_document(&file_uri);
        let msg = client.recv();

        if msg["method"].as_str() == Some("textDocument/publishDiagnostics") {
            let diags = msg["params"]["diagnostics"].as_array().unwrap();
            if !diags.is_empty() {
                let has_error = diags.iter().any(|d| {
                    d["message"]
                        .as_str()
                        .is_some_and(|m| m.contains("NonExistentType") || m.contains("CS0246"))
                });
                if has_error {
                    found_error = true;
                    // Verify diagnostic structure.
                    let diag = diags
                        .iter()
                        .find(|d| {
                            d["message"].as_str().is_some_and(|m| {
                                m.contains("NonExistentType") || m.contains("CS0246")
                            })
                        })
                        .unwrap();
                    assert_eq!(
                        diag["source"].as_str().unwrap(),
                        "forge-csharp",
                        "source must be forge-csharp",
                    );
                    assert_eq!(
                        diag["severity"].as_u64().unwrap(),
                        1,
                        "type error must be Error severity (1)",
                    );
                    assert!(
                        diag["range"]["start"]["line"].as_u64().is_some(),
                        "diagnostic must have a valid range start line",
                    );
                    assert!(
                        diag["code"].is_string()
                            || diag["code"].is_number()
                            || diag["code"].is_object(),
                        "diagnostic must have a code",
                    );
                    break;
                }
            }
        }

        client.open_document(&file_uri, broken_source);
    }

    assert!(
        found_error,
        "didChange introducing NonExistentType must produce diagnostics within 90s",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Full-stack: diagnostics on file with syntax error (not just type error).

#[test]
fn test_full_stack_diagnostics_syntax_error() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("SyntaxErr");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("SyntaxErr.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    // File with a deliberate syntax error: missing closing brace.
    let syntax_error_source = r"namespace SyntaxErr;
public class Oops
{
    public void Broken(
";
    std::fs::write(proj_dir.join("Oops.cs"), syntax_error_source).unwrap();

    std::fs::write(
        tmp.path().join("SyntaxErr.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "SyntaxErr", "SyntaxErr/SyntaxErr.csproj", "{00000000-0000-0000-0000-000000000001}"
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
    let file_path = real_root.join("SyntaxErr").join("Oops.cs");
    let file_uri = format!("file://{}", file_path.display());

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, syntax_error_source);

    // Poll for syntax error diagnostics (CS1002, CS1513, CS1514 etc).
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut found_syntax_error = false;

    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(3));
        client.save_document(&file_uri);
        std::thread::sleep(Duration::from_secs(2));

        client.close_document(&file_uri);
        let msg = client.recv();

        if msg["method"].as_str() == Some("textDocument/publishDiagnostics") {
            let diags = msg["params"]["diagnostics"].as_array().unwrap();
            if !diags.is_empty() {
                // Look for any error-severity diagnostic.
                let has_error = diags
                    .iter()
                    .any(|d| d["severity"].as_u64().is_some_and(|s| s == 1));
                if has_error {
                    found_syntax_error = true;
                    // Verify the diagnostics have proper structure.
                    for diag in diags.iter().filter(|d| d["severity"].as_u64() == Some(1)) {
                        assert_eq!(
                            diag["source"].as_str().unwrap(),
                            "forge-csharp",
                            "source must be forge-csharp",
                        );
                        assert!(
                            diag["message"].as_str().is_some_and(|m| !m.is_empty()),
                            "diagnostic must have a non-empty message",
                        );
                        assert!(
                            diag["range"]["start"]["line"].as_u64().is_some(),
                            "diagnostic must have range start",
                        );
                        assert!(
                            diag["range"]["end"]["line"].as_u64().is_some(),
                            "diagnostic must have range end",
                        );
                    }
                    break;
                }
            }
        }

        client.open_document(&file_uri, syntax_error_source);
    }

    assert!(
        found_syntax_error,
        "file with syntax error must produce Error-severity diagnostics within 90s",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
