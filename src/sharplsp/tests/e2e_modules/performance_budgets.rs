//! The latency and memory targets of [SHARPLSP-PERFORMANCE] and
//! [HOVER-PERFORMANCE] that need a real compiler, on the generated solution of
//! `navigation_latency.rs`: a thousand files by default, six hundred thousand
//! lines with `SHARPLSP_BENCH_FILES=1200 SHARPLSP_BENCH_LINES=500`.

use super::navigation_latency::{
    ask, ask_until_ready, bench_workspace, column, compiler_megabytes, file_count, percentile,
    size, timed, USED,
};
use super::*;

/// The resident memory of the host process itself, in megabytes.
fn host_megabytes(client: &LspClient) -> u64 {
    let system = sysinfo::System::new_all().expect("read the process table");
    let host = sysinfo::Pid::from_u32(client.child.id());
    system.process(host).expect("the host is alive").memory() >> 20
}

/// The resident-memory ceilings of the host and one compiler, in megabytes,
/// for a solution of `files` files: the medium-solution row up to a million
/// lines, the large-solution row beyond. [SHARPLSP-PERFORMANCE]
fn memory_budget(files: usize) -> (u64, u64) {
    let lines = files.saturating_mul(size("SHARPLSP_BENCH_LINES", 7).max(7));
    if lines > 1_000_000 {
        (3072, 5120)
    } else {
        (2048, 3072)
    }
}

#[test]
fn hover_completion_and_memory_meet_their_budgets() {
    require_dotnet();
    let files = file_count();
    let (_tmp, root_uri, file_uri, source) = bench_workspace(files);
    let (hover, completion) = ("textDocument/hover", "textDocument/completion");
    let at = |n: usize, needle: &str| {
        let line = u32::try_from(7 + n).unwrap();
        (line, column(&source, 7 + n, needle))
    };

    // 1. Cold start: the first LSP response, then the first syntax answer.
    let launched = Instant::now();
    let mut client = LspClient::start_verbose();
    let pulls = json!({"textDocument": {"diagnostic": {}}});
    let initialized = client.initialize_with_capabilities(json!(root_uri), pulls);
    let first_response = launched.elapsed();
    assert!(
        initialized["result"]["capabilities"].is_object(),
        "{initialized}"
    );
    client.open_document(&file_uri, &source);
    let symbols = ask(
        &mut client,
        "textDocument/documentSymbol",
        &file_uri,
        (0, 0),
    );
    let first_answer = launched.elapsed();
    eprintln!("bench: first response {first_response:?}, first syntax answer {first_answer:?}");
    assert!(
        symbols["result"]
            .as_array()
            .is_some_and(|found| !found.is_empty()),
        "{symbols}"
    );
    assert!(
        first_response < Duration::from_secs(3),
        "cold start {first_response:?}"
    );
    assert!(
        first_answer < Duration::from_secs(3),
        "first syntax answer {first_answer:?}"
    );

    // 2. The first hover after the solution loads.
    let _ = ask_until_ready(&mut client, &file_uri, at(0, "Shape0()"));
    let started = Instant::now();
    let cold = ask(&mut client, hover, &file_uri, at(0, "Shape0()"));
    let cold_hover = started.elapsed();
    eprintln!("bench: {files} files, first hover {cold_hover:?}");
    assert_hover_ok(&cold);
    assert!(cold["result"]["contents"]["value"]
        .as_str()
        .is_some_and(|text| text.contains("Shape0")));
    assert!(
        cold_hover < Duration::from_secs(3),
        "first hover {cold_hover:?}"
    );

    // 3. Hover on forty distinct symbols, none memoized. [HOVER-PERFORMANCE]
    let hovers = timed(USED - 1, |n| {
        ask(
            &mut client,
            hover,
            &file_uri,
            at(n + 1, &format!("Shape{}()", n + 1)),
        )
    });
    let (p50, p95) = (percentile(&hovers, 50), percentile(&hovers, 95));
    eprintln!("bench: hover p50 {p50:?} p95 {p95:?}");
    assert!(p50 < Duration::from_millis(150), "hover p50 {p50:?}");
    assert!(p95 < Duration::from_millis(300), "hover p95 {p95:?}");

    // 4. A repeated hover is the memo's answer.
    let repeats = timed(21, |_| {
        ask(&mut client, hover, &file_uri, at(0, "Shape0()"))
    });
    let repeat = percentile(&repeats, 50);
    eprintln!("bench: repeated hover {repeat:?}");
    assert!(
        repeat < Duration::from_millis(50),
        "repeated hover {repeat:?}"
    );

    // 5. Completion after a member access, on forty lines; never memoized.
    let completions = timed(USED, |n| {
        let response = ask(&mut client, completion, &file_uri, at(n, "Area()"));
        let items = response["result"]["items"]
            .as_array()
            .or(response["result"].as_array());
        let labels: Vec<&str> = items
            .into_iter()
            .flatten()
            .filter_map(|item| item["label"].as_str())
            .collect();
        assert!(
            labels.contains(&"Area") && labels.contains(&"Side"),
            "members of the shape: {labels:?}"
        );
        response
    });
    let (p50, p95) = (percentile(&completions, 50), percentile(&completions, 95));
    eprintln!("bench: completion p50 {p50:?} p95 {p95:?}");
    assert!(p50 < Duration::from_millis(100), "completion p50 {p50:?}");
    assert!(p95 < Duration::from_millis(200), "completion p95 {p95:?}");

    // 6. Sustained hovering does not grow the compiler: each edit makes every
    //    hover a fresh round trip. Then the memory targets themselves.
    let before = compiler_megabytes(&client);
    for round in 0..10 {
        client.change_document(&file_uri, 2 + round, &source);
        let _ = timed(USED, |n| {
            ask(&mut client, hover, &file_uri, at(n, &format!("Shape{n}()")))
        });
    }
    let (compiler, host) = (compiler_megabytes(&client), host_megabytes(&client));
    eprintln!("bench: compiler {before} MB before, {compiler} MB after 400 hovers; host {host} MB");
    assert!(
        compiler < before + 200,
        "the compiler grew from {before} MB to {compiler} MB"
    );
    let (host_budget, compiler_budget) = memory_budget(files);
    assert!(
        host < host_budget,
        "host {host} MB, budget {host_budget} MB"
    );
    assert!(
        compiler < compiler_budget,
        "compiler {compiler} MB, budget {compiler_budget} MB"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
