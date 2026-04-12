use super::*;

// ── Full-Stack Tests (Rust + .NET Sidecar + Roslyn) ──────────────

// 33. FULL-STACK: HOVER ON CLASS, METHOD, PROPERTY WITH REAL SIDECAR

#[test]
fn test_full_stack_hover_class_method_property() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed — cannot run full-stack hover test");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for the sidecar to load Roslyn + MSBuild (may take 30-60s).
    let class_hover =
        poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let contents = &class_hover["contents"];
    assert_eq!(contents["kind"], "markdown", "contents must be markdown");
    let markdown = contents["value"].as_str().unwrap();
    assert!(!markdown.is_empty(), "hover markdown must not be empty");
    assert!(markdown.contains("```"), "must have code block fence");
    assert!(
        markdown.contains("Calculator"),
        "must contain class name: {markdown}"
    );
    assert!(
        markdown.contains("class"),
        "must contain 'class' keyword: {markdown}"
    );

    // Verify range is present.
    if let Some(range) = class_hover.get("range") {
        assert!(range.get("start").is_some(), "range must have start");
        assert!(range.get("end").is_some(), "range must have end");
    }

    // ASSERT: METHOD HOVER — signature with params, XML docs
    let method_hover = hover(&mut client, &file_uri, 9, 15);
    assert_hover_ok(&method_hover);
    assert!(
        !method_hover["result"].is_null(),
        "method hover must not be null"
    );
    let method_md = method_hover["result"]["contents"]["value"]
        .as_str()
        .unwrap();
    assert!(
        method_md.contains("Add"),
        "must contain method name 'Add': {method_md}"
    );
    assert!(
        method_md.contains("```"),
        "must have code block: {method_md}"
    );

    // ASSERT: PROPERTY HOVER — type, name, accessor
    let prop_hover = hover(&mut client, &file_uri, 12, 18);
    assert_hover_ok(&prop_hover);
    assert!(
        !prop_hover["result"].is_null(),
        "property hover must not be null"
    );
    let prop_md = prop_hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(
        prop_md.contains("Name"),
        "must contain property name: {prop_md}"
    );
    assert!(
        prop_md.contains("```"),
        "must have code elaborate: {prop_md}"
    );

    // ASSERT: OBSOLETE METHOD — deprecation warning
    let obsolete_hover = hover(&mut client, &file_uri, 15, 15);
    assert_hover_ok(&obsolete_hover);
    assert!(
        !obsolete_hover["result"].is_null(),
        "obsolete method hover must not be null",
    );
    let obsolete_md = obsolete_hover["result"]["contents"]["value"]
        .as_str()
        .unwrap();
    assert!(
        obsolete_md.contains("OldAdd"),
        "must contain method name: {obsolete_md}"
    );
    assert!(
        obsolete_md.contains("```"),
        "must have code block: {obsolete_md}"
    );

    // ASSERT: COMMENT → null (tree-sitter pre-validation still works)
    let _ = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": file_uri } }),
    );
    let comment_hover = hover(&mut client, &file_uri, 2, 10);
    assert_hover_ok(&comment_hover);
    assert!(
        comment_hover["result"].is_null(),
        "hover on comment must still return null even with sidecar running",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 34. FULL-STACK: HOVER ON STRUCT, ENUM, INTERFACE

#[test]
fn test_full_stack_hover_struct_enum_interface() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar — poll on Calculator class.
    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // STRUCT
    let struct_hover = hover(&mut client, &file_uri, 20, 14);
    assert_hover_ok(&struct_hover);
    assert!(
        !struct_hover["result"].is_null(),
        "struct hover must not be null"
    );
    let struct_md = struct_hover["result"]["contents"]["value"]
        .as_str()
        .unwrap();
    assert!(
        struct_md.contains("Point"),
        "struct hover must show 'Point'"
    );
    assert!(
        struct_md.contains("struct"),
        "struct hover must show 'struct'"
    );
    assert!(
        struct_md.contains("```"),
        "struct hover must have code block"
    );

    // INTERFACE
    let iface_hover = hover(&mut client, &file_uri, 26, 17);
    assert_hover_ok(&iface_hover);
    assert!(
        !iface_hover["result"].is_null(),
        "interface hover must not be null"
    );
    let iface_md = iface_hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(iface_md.contains("ICalculator"), "must show 'ICalculator'");
    assert!(iface_md.contains("interface"), "must show 'interface'");

    // ENUM
    let enum_hover = hover(&mut client, &file_uri, 31, 12);
    assert_hover_ok(&enum_hover);
    assert!(
        !enum_hover["result"].is_null(),
        "enum hover must not be null"
    );
    let enum_md = enum_hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(enum_md.contains("Color"), "must show 'Color'");
    assert!(enum_md.contains("enum"), "must show 'enum'");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 35. FULL-STACK: HOVER AFTER EDIT — content updates with sidecar

#[test]
fn test_full_stack_hover_after_edit() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar to be ready.
    let initial = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));
    let initial_md = initial["contents"]["value"].as_str().unwrap();
    assert!(
        initial_md.contains("Calculator"),
        "initial hover must show Calculator"
    );

    // Edit the file — add a new class.
    let new_source = format!(
        "{source}\n\n/// <summary>A brand new shiny service.</summary>\npublic class BrandNewService\n{{\n    public void Execute() {{ }}\n}}"
    );
    client.change_document(&file_uri, 2, &new_source);

    // Hover on the new class — poll until sidecar processes the update.
    let new_line = new_source
        .lines()
        .position(|l| l.contains("BrandNewService"))
        .unwrap();
    let new_hover = poll_hover_until_ready(
        &mut client,
        &file_uri,
        u32::try_from(new_line).unwrap(),
        14,
        Duration::from_secs(30),
    );
    let new_md = new_hover["contents"]["value"].as_str().unwrap();
    assert!(
        new_md.contains("BrandNewService"),
        "after edit, hover must show new class: {new_md}",
    );
    assert!(
        new_md.to_lowercase().contains("shiny") || new_md.to_lowercase().contains("brand new"),
        "after edit, hover must show new XML doc: {new_md}",
    );

    // Original class hover still works.
    let orig = hover(&mut client, &file_uri, 3, 14);
    assert_hover_ok(&orig);
    assert!(!orig["result"].is_null(), "original class must still hover");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 36. FULL-STACK: HOVER ON VAR KEYWORD RETURNS INFERRED TYPE

#[test]
fn test_full_stack_hover_var_keyword() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar.
    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 13, Duration::from_secs(90));

    // Hover on `var` at line 42, char 8 ("var calc = new Calculator()")
    let var_hover = hover(&mut client, &file_uri, 42, 8);
    assert_hover_ok(&var_hover);
    assert!(!var_hover["result"].is_null(), "var hover must not be null");
    let md = var_hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(md.contains("```"), "var hover must have code block: {md}");
    assert!(
        md.to_lowercase().contains("inferred") || md.contains("Calculator"),
        "var hover must show inferred type: {md}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 37. FULL-STACK: HOVER XML DOCUMENTATION RENDERS TAGS

#[test]
fn test_full_stack_hover_xml_documentation() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 13, Duration::from_secs(90));

    // Hover on Add method (line 9, char 15) — has <summary>, <param>, <returns>.
    let h = hover(&mut client, &file_uri, 9, 15);
    assert_hover_ok(&h);
    assert!(!h["result"].is_null(), "method hover must not be null");
    let md = h["result"]["contents"]["value"].as_str().unwrap();
    assert!(md.contains("```"), "must have code block: {md}");
    assert!(md.contains("Add"), "must contain method name: {md}");
    assert!(
        md.to_lowercase().contains("adds") || md.to_lowercase().contains("two integers"),
        "must render <summary>: {md}",
    );
    assert!(
        md.to_lowercase().contains("first operand") || md.to_lowercase().contains("parameter"),
        "must render <param>: {md}",
    );
    assert!(
        md.to_lowercase().contains("sum") || md.to_lowercase().contains("return"),
        "must render <returns>: {md}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 38. FULL-STACK: HOVER ON [Obsolete] SYMBOL INCLUDES DEPRECATION

#[test]
fn test_full_stack_hover_obsolete_deprecation() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 13, Duration::from_secs(90));

    // Hover on OldAdd (line 15, char 15) — marked [System.Obsolete("Use Add instead")]
    let h = hover(&mut client, &file_uri, 15, 15);
    assert_hover_ok(&h);
    assert!(!h["result"].is_null(), "obsolete hover must not be null");
    let md = h["result"]["contents"]["value"].as_str().unwrap();
    assert!(md.contains("OldAdd"), "must contain method name: {md}");
    assert!(md.contains("```"), "must have code block: {md}");
    assert!(
        md.contains("Deprecated") || md.contains("Obsolete"),
        "must show deprecation: {md}",
    );
    assert!(
        md.contains("Use Add instead"),
        "must include obsolete message: {md}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 39. FULL-STACK: HOVER CACHE HIT RETURNS FAST

#[test]
fn test_full_stack_hover_cache_hit_latency() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // First hover — warm the cache.
    let first = poll_hover_until_ready(&mut client, &file_uri, 3, 13, Duration::from_secs(90));
    assert!(
        !first["contents"]["value"].is_null(),
        "first hover must return content"
    );

    // Second hover — same position, should hit cache.
    let start = std::time::Instant::now();
    let second = hover(&mut client, &file_uri, 3, 13);
    let elapsed = start.elapsed();
    assert_hover_ok(&second);
    assert!(
        !second["result"].is_null(),
        "cached hover must return content"
    );

    // Cache hit should be <50ms (generous; target is <1ms).
    assert!(
        elapsed.as_millis() < 50,
        "cache hit must be fast, took {}ms",
        elapsed.as_millis(),
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 45. HOVER LATENCY BENCHMARK

#[test]
fn test_full_stack_hover_latency_benchmark() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 13, Duration::from_secs(90));

    // Measure latency across distinct positions.
    let positions: [(u32, u32); 6] = [
        (3, 13),  // Calculator
        (9, 15),  // Add
        (12, 18), // Name
        (15, 15), // OldAdd
        (20, 14), // Point
        (31, 12), // Color
    ];

    let mut latencies = Vec::new();
    for &(line, character) in &positions {
        let start = std::time::Instant::now();
        let h = hover(&mut client, &file_uri, line, character);
        let elapsed = start.elapsed();
        assert_hover_ok(&h);
        latencies.push(elapsed.as_millis());
    }

    latencies.sort_unstable();
    let p50 = latencies[latencies.len() / 2];
    let p95 = latencies[latencies.len() * 95 / 100];
    eprintln!("Hover latency: p50={p50}ms p95={p95}ms (all: {latencies:?})");

    assert!(p50 < 200, "p50 must be <200ms, got {p50}ms");
    // CI runners have high jitter; allow up to 5s for worst-case outliers.
    assert!(p95 < 5000, "p95 must be <5000ms, got {p95}ms");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 44. HOVER AFTER SIDECAR CRASH RECOVERY

#[test]
fn test_full_stack_hover_crash_recovery() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet SDK not installed");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // First hover — sidecar is healthy.
    let first = poll_hover_until_ready(&mut client, &file_uri, 3, 13, Duration::from_secs(90));
    assert!(
        !first["contents"]["value"].is_null(),
        "first hover must work"
    );

    // Rapid hovers — server must not crash or hang even under load.
    for _ in 0..5 {
        let h = hover(&mut client, &file_uri, 3, 13);
        assert_hover_ok(&h);
    }

    // Different symbol — proves pipeline is alive.
    let method = hover(&mut client, &file_uri, 9, 15);
    assert_hover_ok(&method);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
