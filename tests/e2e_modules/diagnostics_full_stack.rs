use super::*;

// ── FULL-STACK DIAGNOSTICS TESTS ─────────────────────────────────

// Full-stack: single-file diagnostics on didOpen detect type errors.

#[test]
fn test_full_stack_diagnostics_on_open_detects_errors() {
    require_dotnet();

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
    require_dotnet();

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

// Full-stack: close/reopen with fixed source must clear stale errors.
// didOpen must sync text to sidecar so diagnostics reflect reality.

#[test]
fn test_full_stack_diagnostics_cleared_after_error_fixed() {
    require_dotnet();

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

    // ── Initialize ──────────────────────────────────────────────
    let mut client = LspClient::start_verbose();
    let init_resp = client.initialize_with_root(json!(root_uri));
    assert!(
        init_resp.get("error").is_none(),
        "initialize must succeed: {init_resp}",
    );
    let caps = &init_resp["result"]["capabilities"];
    assert!(
        !caps["diagnosticProvider"].is_null(),
        "server must advertise diagnosticProvider",
    );
    assert_eq!(
        caps["diagnosticProvider"]["workspaceDiagnostics"],
        json!(true),
        "server must advertise workspaceDiagnostics",
    );

    // ── Step 1: Open broken file ────────────────────────────────
    client.open_document(&item_uri, broken_source);

    // Poll pull diagnostics until the BogusType error appears.
    let scan_deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut found_error = false;
    let mut last_pull_resp = json!(null);
    while std::time::Instant::now() < scan_deadline {
        std::thread::sleep(Duration::from_secs(3));
        client.save_document(&item_uri);
        std::thread::sleep(Duration::from_secs(2));
        let resp = client.request(
            "textDocument/diagnostic",
            json!({ "textDocument": { "uri": item_uri } }),
        );
        // Assert the pull diagnostics response is well-formed.
        assert!(
            resp.get("error").is_none(),
            "textDocument/diagnostic must not return error: {resp}",
        );
        assert!(
            resp["result"]["items"].is_array(),
            "pull diagnostics must return items array: {resp}",
        );
        last_pull_resp = resp.clone();
        let items = resp["result"]["items"].as_array().unwrap();
        if items.iter().any(|d| {
            d["message"]
                .as_str()
                .is_some_and(|m| m.contains("BogusType") || m.contains("CS0246"))
        }) {
            found_error = true;
            break;
        }
    }
    assert!(
        found_error,
        "sidecar must detect BogusType error within 90s. Last response: {last_pull_resp}",
    );

    // Assert the detected error has proper structure.
    let initial_items = last_pull_resp["result"]["items"].as_array().unwrap();
    let bogus_diag = initial_items
        .iter()
        .find(|d| {
            d["message"]
                .as_str()
                .is_some_and(|m| m.contains("BogusType") || m.contains("CS0246"))
        })
        .unwrap();
    assert_eq!(
        bogus_diag["severity"].as_u64().unwrap(),
        1,
        "BogusType must be Error severity (1), got: {}",
        bogus_diag["severity"],
    );
    assert!(
        bogus_diag["range"]["start"]["line"].as_u64().is_some(),
        "diagnostic must have range.start.line: {bogus_diag}",
    );
    assert!(
        bogus_diag["range"]["end"]["line"].as_u64().is_some(),
        "diagnostic must have range.end.line: {bogus_diag}",
    );
    assert_eq!(
        bogus_diag["source"].as_str().unwrap(),
        "forge-csharp",
        "diagnostic source must be forge-csharp",
    );

    // ── Step 2: Close the broken file ───────────────────────────
    client.close_document(&item_uri);

    // Close must produce a publishDiagnostics with empty diagnostics.
    let close_notif =
        client.wait_for_notification("textDocument/publishDiagnostics", Duration::from_secs(5));
    assert!(
        close_notif["params"]["uri"]
            .as_str()
            .unwrap()
            .contains("Item.cs"),
        "close publishDiagnostics must target Item.cs, got: {}",
        close_notif["params"]["uri"],
    );
    assert!(
        close_notif["params"]["diagnostics"]
            .as_array()
            .unwrap()
            .is_empty(),
        "close publishDiagnostics must have empty diagnostics array",
    );

    // ── Step 3: Fix the file on disk and reopen ─────────────────
    let fixed_source = r"namespace VerifyTest;
public class Item
{
    public int Value { get; set; }
}
";
    std::fs::write(&file_path, fixed_source).unwrap();
    client.open_document(&item_uri, fixed_source);

    // Wait for didOpen text sync + diagnostics to complete.
    std::thread::sleep(Duration::from_secs(3));

    // ── Step 4: Pull diagnostics — must be clean ────────────────
    let fixed_resp = client.request(
        "textDocument/diagnostic",
        json!({ "textDocument": { "uri": item_uri } }),
    );
    assert!(
        fixed_resp.get("error").is_none(),
        "pull diagnostics after fix must not error: {fixed_resp}",
    );
    assert!(
        fixed_resp["result"]["items"].is_array(),
        "pull diagnostics must return items array: {fixed_resp}",
    );
    let fixed_items = fixed_resp["result"]["items"].as_array().unwrap();

    // Assert ZERO Error-severity diagnostics.
    let errors: Vec<String> = fixed_items
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
        "After reopening with fixed source (BogusType -> int), pull \
         diagnostics must return zero Error-severity diagnostics. \
         Stale errors: {errors:?}. Forge does not lie.",
    );

    // Assert no BogusType mentioned anywhere in any diagnostic.
    for diag in fixed_items {
        let msg = diag["message"].as_str().unwrap_or("");
        assert!(
            !msg.contains("BogusType"),
            "No diagnostic should mention BogusType after fix. Got: {msg}",
        );
    }

    // ── Step 5: Verify documentSymbol works on the fixed file ───
    let sym_resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": item_uri } }),
    );
    assert!(
        sym_resp.get("error").is_none(),
        "documentSymbol on open file must not error: {sym_resp}",
    );
    let symbols = sym_resp["result"].as_array().unwrap();
    assert!(
        !symbols.is_empty(),
        "documentSymbol must return symbols for the fixed file",
    );

    // ── Step 6: Pull diagnostics a second time — still clean ────
    let recheck_resp = client.request(
        "textDocument/diagnostic",
        json!({ "textDocument": { "uri": item_uri } }),
    );
    assert!(
        recheck_resp.get("error").is_none(),
        "second pull diagnostics must not error: {recheck_resp}",
    );
    let recheck_items = recheck_resp["result"]["items"].as_array().unwrap();
    let recheck_errors: Vec<String> = recheck_items
        .iter()
        .filter(|d| d["severity"].as_u64() == Some(1))
        .map(|d| d["message"].as_str().unwrap_or("?").to_string())
        .collect();
    assert!(
        recheck_errors.is_empty(),
        "Second pull must also be clean. Errors: {recheck_errors:?}",
    );

    // ── Shutdown ────────────────────────────────────────────────
    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Full-stack: diagnostics refreshed on didChange — edit introduces error.

#[test]
fn test_full_stack_diagnostics_refreshed_on_did_change() {
    require_dotnet();

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

// Full-stack: verification pass must read from disk and clear false positives.
// After solution-wide scan detects errors, fix the file ON DISK (no didChange),
// and the verification pass must re-read disk content, update the sidecar's
// compilation, and clear the stale errors.

#[test]
fn test_full_stack_verification_clears_stale_errors_from_disk() {
    require_dotnet();

    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("StaleTest");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("StaleTest.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    // Start with a BROKEN file on disk — the sidecar will cache this.
    let broken_source = r"namespace StaleTest;
public class Stale
{
    public GhostType Phantom { get; set; }
}
";
    std::fs::write(proj_dir.join("Stale.cs"), broken_source).unwrap();

    std::fs::write(
        tmp.path().join("StaleTest.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "StaleTest", "StaleTest/StaleTest.csproj", "{00000000-0000-0000-0000-000000000001}"
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
    let stale_path = real_root.join("StaleTest").join("Stale.cs");
    let _stale_uri = format!("file://{}", stale_path.display());

    // ── Initialize — sidecar loads the broken compilation ───────
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));

    // Do NOT open the file via didOpen — we want the solution-wide scan
    // to be the ONLY source of diagnostics. No editor interaction.

    // ── Wait for solution-wide scan to detect the GhostType error ──
    let scan_deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut initial_error_seen = false;

    while std::time::Instant::now() < scan_deadline {
        let msg = client.recv();
        if msg["method"].as_str() != Some("textDocument/publishDiagnostics") {
            continue;
        }
        let msg_uri = msg["params"]["uri"].as_str().unwrap_or("");
        if !msg_uri.contains("Stale.cs") {
            continue;
        }
        let diags = msg["params"]["diagnostics"].as_array().unwrap();
        let has_ghost_error = diags.iter().any(|d| {
            d["message"]
                .as_str()
                .is_some_and(|m| m.contains("GhostType") || m.contains("CS0246"))
        });
        if has_ghost_error {
            initial_error_seen = true;
            eprintln!("PASS: Solution-wide scan detected GhostType error");
            break;
        }
    }
    assert!(
        initial_error_seen,
        "solution-wide scan must detect GhostType error within 90s",
    );

    // ── Fix the file ON DISK — no didChange, no close/reopen ───
    let fixed_source = r"namespace StaleTest;
public class Stale
{
    public int Phantom { get; set; }
}
";
    std::fs::write(&stale_path, fixed_source).unwrap();
    eprintln!("Wrote fixed source to disk (GhostType -> int)");

    // ── Wait for verification pass to publish cleared diagnostics ──
    // The verification pass runs ~1s after the scan completes and publishes
    // exactly one more `publishDiagnostics` for Stale.cs. That notification
    // is the NEXT Stale.cs message after the initial scan error we already
    // consumed. Read messages until we see it (bounded to avoid blocking).
    let mut verification_result: Option<Vec<serde_json::Value>> = None;

    // Read up to 10 messages — verification fires within ~2s of scan.
    for _ in 0..10 {
        let msg = client.recv();
        if msg["method"].as_str() != Some("textDocument/publishDiagnostics") {
            continue;
        }
        let msg_uri = msg["params"]["uri"].as_str().unwrap_or("");
        if !msg_uri.contains("Stale.cs") {
            continue;
        }
        // This is the verification pass result for Stale.cs.
        let diags = msg["params"]["diagnostics"].as_array().unwrap().clone();
        eprintln!(
            "Verification notification for Stale.cs: {} diagnostics",
            diags.len()
        );
        verification_result = Some(diags);
        break;
    }

    let diags = verification_result.expect(
        "Must receive a second publishDiagnostics for Stale.cs from \
         the verification pass (got 10 messages, none for Stale.cs)",
    );
    let still_has_ghost = diags.iter().any(|d| {
        d["message"]
            .as_str()
            .is_some_and(|m| m.contains("GhostType") || m.contains("CS0246"))
    });
    assert!(
        !still_has_ghost,
        "Verification pass must clear stale GhostType error after file \
         was fixed on disk, but the error persists ({} diagnostics). \
         The verification pass must read from disk, send didChange to \
         update the sidecar compilation, and re-fetch diagnostics. \
         Forge does not lie about compilation state. Diagnostics: {diags:?}",
        diags.len(),
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Full-stack: solution-wide scan must NOT produce false positives for
// cross-project references. When project A depends on project B and B
// defines a type used by A, the solution-wide scan must compile B before
// A (topological order) so A's semantic model sees B's types as resolved.
//
// Without topological ordering, Roslyn's GetCompilationAsync on a freshly
// loaded MSBuildWorkspace returns compilations with unresolved
// CompilationReferences, producing phantom CS0246 "type could not be
// found" errors in files that actually compile fine.

#[test]
fn test_full_stack_cross_project_references_no_false_positives() {
    require_dotnet();

    let tmp = tempfile::tempdir().unwrap();

    // Build a diamond dependency graph with 8 projects to stress project
    // ordering during compilation. Layout:
    //
    //    Core (leaf — no deps)
    //     │
    //    ┌┴┬──┬──┐
    //   A B  C  D  (each depends on Core)
    //    └┬┴──┴──┘
    //     │
    //   Combined (depends on A, B, C, D)
    //     │
    //    App1, App2  (each depends on Combined)
    //
    // When MSBuildWorkspace enumerates projects in arbitrary order and
    // compiles them out-of-order, consumers see phantom CS0246 errors.

    let make_project =
        |dir: &std::path::Path, name: &str, deps: &[&str], source: &str, source_file: &str| {
            std::fs::create_dir_all(dir).unwrap();
            let mut refs = String::new();
            for d in deps {
                use std::fmt::Write;
                writeln!(
                    refs,
                    "    <ProjectReference Include=\"..\\{d}\\{d}.csproj\" />",
                )
                .unwrap();
            }
            let csproj = format!(
                r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
{refs}  </ItemGroup>
</Project>"#
            );
            std::fs::write(dir.join(format!("{name}.csproj")), csproj).unwrap();
            std::fs::write(dir.join(source_file), source).unwrap();
        };

    // Core — defines types used by all other projects.
    make_project(
        &tmp.path().join("Core"),
        "Core",
        &[],
        "namespace Core;\n\
         public class CoreType { public int Id { get; set; } }\n\
         public interface ICoreService { void Run(); }\n",
        "Core.cs",
    );

    // A, B, C, D — each depends on Core and defines their own types.
    for name in &["A", "B", "C", "D"] {
        let src = format!(
            "namespace {name};\n\
             using Core;\n\
             public class {name}Type\n\
             {{\n\
             \x20\x20\x20\x20public CoreType Core {{ get; set; }} = new();\n\
             \x20\x20\x20\x20public int Value {{ get; set; }}\n\
             }}\n"
        );
        make_project(
            &tmp.path().join(name),
            name,
            &["Core"],
            &src,
            &format!("{name}File.cs"),
        );
    }

    // Combined — depends on A, B, C, D and uses all their types.
    make_project(
        &tmp.path().join("Combined"),
        "Combined",
        &["A", "B", "C", "D", "Core"],
        "namespace Combined;\n\
         using A;\n\
         using B;\n\
         using C;\n\
         using D;\n\
         using Core;\n\
         public class CombinedType\n\
         {\n\
         \x20\x20\x20\x20public AType A { get; set; } = new();\n\
         \x20\x20\x20\x20public BType B { get; set; } = new();\n\
         \x20\x20\x20\x20public CType C { get; set; } = new();\n\
         \x20\x20\x20\x20public DType D { get; set; } = new();\n\
         \x20\x20\x20\x20public CoreType Core { get; set; } = new();\n\
         }\n",
        "Combined.cs",
    );

    // App1, App2 — top-level consumers of Combined.
    for name in &["App1", "App2"] {
        let src = format!(
            "namespace {name};\n\
             using Combined;\n\
             using Core;\n\
             public class {name}Main\n\
             {{\n\
             \x20\x20\x20\x20public CombinedType Combined {{ get; set; }} = new();\n\
             \x20\x20\x20\x20public CoreType Core {{ get; set; }} = new();\n\
             }}\n"
        );
        make_project(
            &tmp.path().join(name),
            name,
            &["Combined", "Core"],
            &src,
            &format!("{name}.cs"),
        );
    }

    // Write the .sln file with projects listed in REVERSE dependency order
    // (leafs last) to maximally stress enumerator ordering.
    let sln = r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App1", "App1/App1.csproj", "{00000000-0000-0000-0000-000000000001}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App2", "App2/App2.csproj", "{00000000-0000-0000-0000-000000000002}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Combined", "Combined/Combined.csproj", "{00000000-0000-0000-0000-000000000003}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "A/A.csproj", "{00000000-0000-0000-0000-000000000004}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "B", "B/B.csproj", "{00000000-0000-0000-0000-000000000005}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "C", "C/C.csproj", "{00000000-0000-0000-0000-000000000006}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "D", "D/D.csproj", "{00000000-0000-0000-0000-000000000007}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Core", "Core/Core.csproj", "{00000000-0000-0000-0000-000000000008}"
EndProject
Global
EndGlobal
"#;
    std::fs::write(tmp.path().join("Test.sln"), sln).unwrap();

    // Restore and build the solution to confirm it compiles cleanly — this
    // is ground truth. If dotnet build succeeds, Forge must not report
    // any errors.
    let restore = std::process::Command::new("dotnet")
        .args(["restore", "Test.sln", "--verbosity", "quiet"])
        .current_dir(tmp.path())
        .status()
        .expect("dotnet restore failed");
    assert!(restore.success(), "dotnet restore must succeed");

    let build = std::process::Command::new("dotnet")
        .args(["build", "Test.sln", "--no-restore", "--verbosity", "quiet"])
        .current_dir(tmp.path())
        .output()
        .expect("dotnet build failed");
    assert!(
        build.status.success(),
        "dotnet build must succeed — this is the ground truth. \
         stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&build.stdout),
        String::from_utf8_lossy(&build.stderr),
    );

    let real_root = std::fs::canonicalize(tmp.path()).unwrap();
    let root_uri = format!("file://{}", real_root.display());
    let consumer_path = real_root.join("Combined").join("Combined.cs");
    let consumer_uri = format!("file://{}", consumer_path.display());

    // ── Initialize ──────────────────────────────────────────────
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));

    // Do NOT open Consumer.cs via didOpen — we want the solution-wide scan
    // to be the source of truth. The solution compiles fine; the scan must
    // not lie about PublicType being missing.

    // ── Wait for and drain publishDiagnostics from the scan ──
    //
    // The scan publishes one notification per file WITH diagnostics.
    // We give the scan 20s to complete, then read messages from stdin
    // until we've received enough to conclude.
    //
    // Since recv() blocks forever when no messages arrive, we first
    // issue a textDocument/diagnostic (pull) — this is a REQUEST with
    // a response id. Reading until we get that id naturally drains
    // any buffered publish notifications along the way. The request()
    // method already skips notifications via its id-check, so we
    // replace it with a manual loop that collects notifications too.

    std::thread::sleep(Duration::from_secs(20));

    let mut all_publish_diags: Vec<(String, Vec<serde_json::Value>)> = Vec::new();

    // Send a pull diagnostics request to act as a drain barrier.
    let drain_id = next_id();
    client.send(&json!({
        "jsonrpc": "2.0",
        "id": drain_id,
        "method": "textDocument/diagnostic",
        "params": { "textDocument": { "uri": consumer_uri } },
    }));

    // Read messages until we receive the response to our drain barrier.
    // All publishDiagnostics notifications that were queued before our
    // request will arrive in order before the response to that request.
    loop {
        let msg = client.recv();
        if msg.get("id").and_then(serde_json::Value::as_i64) == Some(drain_id.into()) {
            // Response to our drain request. Stop reading.
            break;
        }
        if msg["method"].as_str() == Some("textDocument/publishDiagnostics") {
            let msg_uri = msg["params"]["uri"].as_str().unwrap_or("").to_string();
            let diags = msg["params"]["diagnostics"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            all_publish_diags.push((msg_uri, diags));
        }
    }

    // Analyze every published diagnostic for false-positive codes.
    let mut all_false_positives: Vec<(String, Vec<String>)> = Vec::new();
    for (uri, diags) in &all_publish_diags {
        let false_positives: Vec<String> = diags
            .iter()
            .filter(|d| d["severity"].as_u64() == Some(1))
            .filter_map(|d| {
                let msg = d["message"].as_str().unwrap_or("");
                let code = d["code"].as_str().unwrap_or("");
                // CS0246: type or namespace not found
                // CS0234: type or namespace does not exist in namespace
                // CS0103: name does not exist in current context
                // CS0012: type defined in an unreferenced assembly
                let is_false_pos =
                    code == "CS0246" || code == "CS0234" || code == "CS0103" || code == "CS0012";
                if is_false_pos {
                    Some(format!("{code}: {msg}"))
                } else {
                    None
                }
            })
            .collect();
        if !false_positives.is_empty() {
            all_false_positives.push((uri.clone(), false_positives));
        }
    }

    // Unused variable silencing.
    let _ = &consumer_uri;

    // ── Assert: NO false-positive type-not-found errors ──
    //
    // The whole point of Forge is to NOT LIE TO THE USER. The solution
    // builds cleanly via `dotnet build`. Forge must not publish errors
    // for types that the compiler resolves correctly.
    assert!(
        all_false_positives.is_empty(),
        "Solution-wide scan PUBLISHED false-positive type-not-found \
         errors to the editor. The solution builds cleanly via \
         `dotnet build` — Forge must not lie about compilation state. \
         False positives by URI: {all_false_positives:?}\n\
         All publishDiagnostics notifications received: {all_publish_diags:?}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Full-stack: diagnostics on file with syntax error (not just type error).

#[test]
fn test_full_stack_diagnostics_syntax_error() {
    require_dotnet();

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
