//! Full-stack e2e for the dump-analysis pipeline (PROFILER-SPEC §4.2.1, §4.5,
//! §5.1, §5A): object retention graphs, GC roots, object inspection, and heap
//! snapshot diffing — all against REAL heap dumps of a live .NET process, plus
//! trace conversion of a REAL `.nettrace` capture. No mocks anywhere.

use super::profiler_full_stack::{start_profiler_session, stop_profile_target};
use super::*;

/// Locate `dotnet-dump` the way the host's tool discovery does: PATH first,
/// then the default `dotnet tool install -g` shim directory.
fn dotnet_dump_binary() -> PathBuf {
    let shim_name = if cfg!(windows) {
        "dotnet-dump.exe"
    } else {
        "dotnet-dump"
    };
    let global_shim = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| {
            PathBuf::from(home)
                .join(".dotnet")
                .join("tools")
                .join(shim_name)
        });
    match global_shim {
        Some(path) if path.exists() => path,
        _ => PathBuf::from("dotnet-dump"),
    }
}

/// Run one SOS command inside `dotnet-dump analyze` and return its stdout —
/// the same invocation shape the host uses (command + `exit` piped to stdin).
fn run_dump_command(dump_path: &str, command: &str) -> String {
    let mut child = Command::new(dotnet_dump_binary())
        .args(["analyze", dump_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn dotnet-dump analyze");
    child
        .stdin
        .take()
        .expect("dotnet-dump stdin")
        .write_all(format!("{command}\nexit\n").as_bytes())
        .expect("write dotnet-dump command");
    let output = child
        .wait_with_output()
        .expect("dotnet-dump analyze output");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Harvest a REAL object address from a heap dump: the last instance row
/// (`<address> <mt> <size>`) that `dumpheap -type <fragment>` prints.
fn harvest_heap_address(dump_path: &str, type_fragment: &str) -> Option<String> {
    let stdout = run_dump_command(dump_path, &format!("dumpheap -type {type_fragment}"));
    stdout.lines().rev().find_map(instance_row_address)
}

/// Parse a `dumpheap` instance row into its object address. Instance rows are
/// exactly three tokens (address, method table, size) — which also excludes
/// the `Statistics:` section rows (four+ tokens) and the `Found N objects`
/// trailer (non-hex first token).
fn instance_row_address(line: &str) -> Option<String> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let [address, method_table, size] = tokens.as_slice() else {
        return None;
    };
    (is_hex_address(address)
        && is_hex_address(method_table)
        && size.chars().all(|c| c.is_ascii_digit() || c == ','))
    .then(|| (*address).to_string())
}

/// SOS tables print heap addresses as bare hex words (no `0x` prefix).
fn is_hex_address(token: &str) -> bool {
    token.len() >= 8 && token.chars().all(|c| c.is_ascii_hexdigit())
}

/// Collect a heap dump of `pid` through the LSP and return the dump path.
fn collect_heap_dump(client: &mut LspClient, pid: u32, dir: &Path, file_name: &str) -> String {
    let dump_path = dir.join(file_name).to_string_lossy().to_string();
    let resp = client.request(
        "sharplsp/profiler/collectDump",
        json!({ "pid": pid, "dump_type": "Heap", "output_path": &dump_path }),
    );
    assert!(
        resp.get("error").is_none(),
        "collectDump must succeed: {resp}"
    );
    assert!(
        resp["result"]["file_size_bytes"].as_u64().unwrap_or(0) > 0,
        "dump must be non-empty: {resp}"
    );
    dump_path
}

/// PROFILER-SPEC §5A + §4.5 + §5.1 — the complete memory-analysis workflow a
/// user actually performs: snapshot a live process twice, walk a real object's
/// retention graph, trace its GC roots, inspect its fields, and diff the two
/// snapshots for leak suspects.
#[test]
fn test_profiler_object_graph_roots_inspect_and_diff_full_stack() {
    let (mut target, target_pid, mut client) = start_profiler_session();
    let tmp_dir = tempfile::tempdir().expect("create temp dir");

    // 1. Baseline heap snapshot, then let the target allocate, then compare
    //    snapshot — the §5.1 baseline → exercise → compare workflow.
    let baseline_dump = collect_heap_dump(&mut client, target_pid, tmp_dir.path(), "baseline.dmp");
    std::thread::sleep(Duration::from_secs(2));
    let comparison_dump =
        collect_heap_dump(&mut client, target_pid, tmp_dir.path(), "comparison.dmp");

    // 2. Harvest a REAL object address. ProfileTarget's StringBuilder hotspot
    //    guarantees instances, and StringBuilder's m_ChunkChars char[] field
    //    is a never-null reference — exercising the graph's edge traversal.
    let address = harvest_heap_address(&baseline_dump, "System.Text.StringBuilder").expect(
        "baseline heap dump must contain StringBuilder instances \
         (ProfileTarget allocates them constantly)",
    );

    // 3. Object retention graph from the real root address.
    let resp = client.request(
        "sharplsp/profiler/getObjectGraph",
        json!({
            "dump_path": &baseline_dump,
            "root_address": &address,
            "max_depth": 2,
            "max_nodes": 5,
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "getObjectGraph must succeed on a real address: {resp}"
    );
    let graph = &resp["result"];
    let nodes = graph["nodes"].as_array().expect("nodes must be an array");
    let root = nodes
        .iter()
        .find(|node| node["id"] == json!(address))
        .unwrap_or_else(|| panic!("graph must contain the requested root {address}: {graph}"));
    assert!(
        root["type_name"]
            .as_str()
            .is_some_and(|name| name.contains("StringBuilder")),
        "root must be the harvested StringBuilder: {root}"
    );
    assert!(
        root["size_bytes"].as_u64().unwrap_or(0) > 0,
        "root must have a real shallow size: {root}"
    );
    assert_eq!(root["depth"], json!(0), "root sits at depth 0: {root}");

    // StringBuilder always holds m_ChunkChars → at least one outgoing edge,
    // and BFS must have followed it to a depth-1 child node.
    let edges = graph["edges"].as_array().expect("edges must be an array");
    assert!(
        edges.iter().any(|edge| edge["from"] == json!(address)),
        "root must hold at least one reference (m_ChunkChars): {graph}"
    );
    for edge in edges {
        assert!(
            edge["field_name"].as_str().is_some_and(|f| !f.is_empty()),
            "every edge names its holding field: {edge}"
        );
        assert_eq!(edge["reference_kind"], json!("Strong"), "edge kind: {edge}");
    }
    assert!(
        nodes.len() >= 2,
        "BFS must reach at least one referenced child: {graph}"
    );
    assert!(
        nodes.iter().any(|node| node["depth"].as_u64() == Some(1)),
        "a depth-1 child node must exist: {graph}"
    );
    let stats = &graph["stats"];
    assert_eq!(
        stats["total_nodes_traversed"].as_u64(),
        u64::try_from(nodes.len()).ok(),
        "stats must count the returned nodes: {stats}"
    );
    assert_eq!(
        stats["total_edges_traversed"].as_u64(),
        u64::try_from(edges.len()).ok(),
        "stats must count the returned edges: {stats}"
    );

    // 4. Type-filtered graph: only matching nodes may appear.
    let resp = client.request(
        "sharplsp/profiler/getObjectGraph",
        json!({
            "dump_path": &baseline_dump,
            "root_address": &address,
            "max_depth": 1,
            "max_nodes": 4,
            "type_filter": "StringBuilder",
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "filtered getObjectGraph must succeed: {resp}"
    );
    let filtered_nodes = resp["result"]["nodes"]
        .as_array()
        .expect("filtered nodes must be an array");
    assert!(
        !filtered_nodes.is_empty(),
        "the StringBuilder root itself matches the filter: {resp}"
    );
    for node in filtered_nodes {
        assert!(
            node["type_name"]
                .as_str()
                .is_some_and(|name| name.contains("StringBuilder")),
            "type_filter must prune non-matching nodes: {node}"
        );
    }

    // 5. GC roots of the same real object (§4.5). Chains depend on GC timing,
    //    but the request must succeed and any chain returned must be sound.
    let resp = client.request(
        "sharplsp/profiler/findGCRoots",
        json!({ "dump_path": &baseline_dump, "object_address": &address }),
    );
    assert!(
        resp.get("error").is_none(),
        "findGCRoots must succeed on a real address: {resp}"
    );
    let chains = resp["result"].as_array().expect("chains must be an array");
    for chain in chains {
        let chain_roots = chain["roots"].as_array().expect("roots must be an array");
        assert!(!chain_roots.is_empty(), "a chain cannot be empty: {chain}");
        for chain_root in chain_roots {
            assert!(
                chain_root["address"]
                    .as_str()
                    .is_some_and(|a| !a.is_empty()),
                "every chain node carries an address: {chain_root}"
            );
            assert!(
                matches!(chain_root["root_kind"].as_str(), Some("Root" | "Reference")),
                "root_kind must be Root or Reference: {chain_root}"
            );
        }
    }

    // 6. Inspect the same real object (§5A.2).
    let resp = client.request(
        "sharplsp/profiler/inspectObject",
        json!({ "dump_path": &baseline_dump, "object_address": &address }),
    );
    assert!(
        resp.get("error").is_none(),
        "inspectObject must succeed on a real address: {resp}"
    );
    let inspection = &resp["result"];
    assert!(
        inspection["type_name"]
            .as_str()
            .is_some_and(|name| name.contains("StringBuilder")),
        "inspection must name the real type: {inspection}"
    );
    assert!(
        inspection["size_bytes"].as_u64().unwrap_or(0) > 0,
        "inspection must report a real size: {inspection}"
    );
    let fields = inspection["fields"].as_array().expect("fields array");
    assert!(
        !fields.is_empty(),
        "StringBuilder has fields — inspection must list them: {inspection}"
    );
    for field in fields {
        assert!(
            field["name"].as_str().is_some_and(|name| !name.is_empty()),
            "every field carries a name: {field}"
        );
    }

    // 7. Diff the two snapshots (§5.1 compare step). With growing_only=false
    //    and a 0% floor every stable-or-growing type is reported.
    let resp = client.request(
        "sharplsp/profiler/diffHeapSnapshots",
        json!({
            "baseline_dump_path": &baseline_dump,
            "comparison_dump_path": &comparison_dump,
            "growing_only": false,
            "min_growth_percent": 0.0,
            "limit": 200,
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "diffHeapSnapshots must succeed: {resp}"
    );
    let diff = &resp["result"];
    assert!(
        diff["baseline_total_objects"].as_u64().unwrap_or(0) > 0,
        "baseline totals must be real: {diff}"
    );
    assert!(
        diff["comparison_total_objects"].as_u64().unwrap_or(0) > 0,
        "comparison totals must be real: {diff}"
    );
    let diffs = diff["diffs"].as_array().expect("diffs must be an array");
    assert!(
        !diffs.is_empty(),
        "a live heap always has stable-or-growing types: {diff}"
    );
    for entry in diffs {
        assert!(
            entry["type_name"]
                .as_str()
                .is_some_and(|name| !name.is_empty()),
            "every diff names its type: {entry}"
        );
        let baseline_count = entry["baseline_count"].as_i64().unwrap_or(0);
        let comparison_count = entry["comparison_count"].as_i64().unwrap_or(0);
        assert_eq!(
            entry["count_delta"].as_i64(),
            Some(comparison_count - baseline_count),
            "count_delta must be comparison - baseline: {entry}"
        );
    }
    let deltas: Vec<i64> = diffs
        .iter()
        .filter_map(|entry| entry["size_delta_bytes"].as_i64())
        .collect();
    assert!(
        deltas.windows(2).all(|pair| pair[0] >= pair[1]),
        "diffs must be sorted by size delta descending: {deltas:?}"
    );
    assert!(
        diff["leak_suspects"].is_array(),
        "leak_suspects must be present: {diff}"
    );

    // 8. growing_only variant — the default leak-hunting view.
    let resp = client.request(
        "sharplsp/profiler/diffHeapSnapshots",
        json!({
            "baseline_dump_path": &baseline_dump,
            "comparison_dump_path": &comparison_dump,
            "growing_only": true,
            "min_growth_percent": 0.0,
            "limit": 200,
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "growing-only diff must succeed: {resp}"
    );
    let growing = resp["result"]["diffs"]
        .as_array()
        .expect("diffs must be an array");
    for entry in growing {
        assert!(
            entry["count_delta"].as_i64().unwrap_or(0) > 0
                || entry["size_delta_bytes"].as_i64().unwrap_or(0) > 0,
            "growing_only must exclude non-growing types: {entry}"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
    stop_profile_target(&mut target);
}

/// PROFILER-SPEC §4.2.1 — `convertTrace` converts a previously captured REAL
/// `.nettrace` through the explicit handler (chromium format — distinct from
/// the speedscope conversion `stopTrace` performs automatically).
#[test]
fn test_profiler_convert_trace_full_stack_chromium() {
    let (mut target, target_pid, mut client) = start_profiler_session();
    let tmp_dir = tempfile::tempdir().expect("create temp dir");
    let trace_path = tmp_dir
        .path()
        .join("convert-me.nettrace")
        .to_string_lossy()
        .to_string();

    let resp = client.request(
        "sharplsp/profiler/startTrace",
        json!({
            "pid": target_pid,
            "profile": "gc-collect",
            "duration": 0,
            "output_path": &trace_path,
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "startTrace must succeed: {resp}"
    );
    let session_id = resp["result"]["session_id"]
        .as_str()
        .expect("session_id must be a string")
        .to_string();

    std::thread::sleep(Duration::from_secs(2));

    let resp = client.request(
        "sharplsp/profiler/stopTrace",
        json!({ "session_id": session_id }),
    );
    assert!(
        resp.get("error").is_none(),
        "stopTrace must succeed: {resp}"
    );

    let resp = client.request(
        "sharplsp/profiler/convertTrace",
        json!({ "input_path": &trace_path, "format": "chromium" }),
    );
    assert!(
        resp.get("error").is_none(),
        "convertTrace must succeed on a real capture: {resp}"
    );
    let converted = resp["result"]["output_path"]
        .as_str()
        .expect("output_path must be a string");
    assert!(
        converted.ends_with(".chromium.json"),
        "chromium conversion must derive the sibling path: {converted}"
    );
    assert!(
        resp["result"]["file_size_bytes"].as_u64().unwrap_or(0) > 0,
        "converted file must be non-empty: {resp}"
    );
    assert!(
        Path::new(converted).exists(),
        "converted file must exist on disk: {converted}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
    stop_profile_target(&mut target);
}
