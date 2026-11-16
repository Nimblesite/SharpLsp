//! Navigation latency and memory against a generated thousand-file solution:
//! every budget of [DEFINITION-PERFORMANCE] and [REFERENCES-PERFORMANCE] that
//! needs a real compiler. `SHARPLSP_BENCH_FILES` and `SHARPLSP_BENCH_LINES`
//! (lines per file) size the solution for a larger run on a developer machine,
//! such as four thousand files of five hundred lines for two million lines;
//! the budgets are asserted at any size.

use super::*;
use workspace_diagnostic_protocol::recovery::{owned_apphosts, published_apphost_uri};

/// The shapes the opened document uses, one per line.
pub const USED: usize = 40;
/// The shapes that implement `IShape`. [DEFINITION-PERFORMANCE]
const IMPLEMENTERS: usize = 120;

/// How many shape files the solution holds: each calls `Hub.Touch` once, and
/// the first [`IMPLEMENTERS`] implement `IShape`.
pub fn file_count() -> usize {
    size("SHARPLSP_BENCH_FILES", 1000)
}

/// A size from the environment, else `default`.
pub fn size(variable: &str, default: usize) -> usize {
    std::env::var(variable)
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(default)
}

/// The find-references budget of a solution of `files` files.
/// [REFERENCES-PERFORMANCE]
fn references_budget(files: usize) -> Duration {
    match files {
        0..100 => Duration::from_millis(500),
        100..=1000 => Duration::from_secs(2),
        _ => Duration::from_secs(5),
    }
}

/// Filler members that bring a shape file to `SHARPLSP_BENCH_LINES` lines.
fn filler() -> String {
    (0..size("SHARPLSP_BENCH_LINES", 0).saturating_sub(7))
        .map(|k| format!("    public int Member{k}(int value) {{ return value + {k}; }}\n"))
        .collect::<Vec<_>>()
        .concat()
}

/// The opened document: line `7 + n` constructs `Shape{n}` and calls `Area`.
fn program_source() -> String {
    let uses = (0..USED)
        .map(|n| format!("        var s{n} = new Shape{n}(); total += s{n}.Area();"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "namespace Bench;\n\npublic static class Program\n{{\n    public static int Run()\n    {{\n        var total = 0;\n{uses}\n        return Hub.Touch(total);\n    }}\n}}\n"
    )
}

/// A restored one-project solution of `files` shapes; returns its root URI
/// and the opened document's URI and text.
pub fn bench_workspace(files: usize) -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("Bench");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        project.join("Bench.csproj"),
        "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <TargetFramework>net9.0</TargetFramework>\n    <OutputType>Library</OutputType>\n  </PropertyGroup>\n</Project>\n",
    )
    .unwrap();
    std::fs::write(
        project.join("Hub.cs"),
        "namespace Bench;\n\npublic static class Hub\n{\n    public static int Touch(int value) { return value + 1; }\n}\n\npublic interface IShape\n{\n    int Area();\n}\n",
    )
    .unwrap();
    let filler = filler();
    for n in 0..files {
        let base = if n < IMPLEMENTERS { " : IShape" } else { "" };
        let shape = format!(
            "namespace Bench;\n\npublic class Shape{n}{base}\n{{\n    public int Side {{ get; set; }} = {n};\n    public int Area() {{ return Hub.Touch(Side); }}\n{filler}}}\n"
        );
        std::fs::write(project.join(format!("Shape{n}.cs")), shape).unwrap();
    }
    let source = program_source();
    std::fs::write(project.join("Program.cs"), &source).unwrap();
    restore_project(&project);
    let root_uri = path_to_file_uri(tmp.path());
    let file_uri = path_to_file_uri(&project.join("Program.cs"));
    (tmp, root_uri, file_uri, source)
}

/// The column of `needle` on `line` of `source`.
pub fn column(source: &str, line: usize, needle: &str) -> u32 {
    let text = source.lines().nth(line).expect("line exists");
    u32::try_from(text.find(needle).expect("needle is on the line")).unwrap()
}

/// Ask `method` at a position and return its response. The client pulls
/// diagnostics, as editors do, so no background publication pass competes for
/// the compiler; a server request such as a diagnostic refresh is not an answer.
pub fn ask(client: &mut LspClient, method: &str, uri: &str, at: (u32, u32)) -> Value {
    let id = i64::from(next_id());
    let mut params = hover_params(uri, at.0, at.1);
    if method == "textDocument/references" {
        params["context"] = json!({ "includeDeclaration": true });
    }
    client.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    loop {
        let message = client.recv();
        if message["id"].as_i64() == Some(id) && message.get("method").is_none() {
            return message;
        }
    }
}

/// `ask` until the compiler has loaded the solution and answers a location.
pub fn ask_until_ready(client: &mut LspClient, uri: &str, at: (u32, u32)) -> Value {
    let deadline = Instant::now() + Duration::from_mins(4);
    loop {
        let response = ask(client, "textDocument/definition", uri, at);
        assert_nav_ok(&response);
        if !response["result"].is_null() {
            return first_location(&response["result"]);
        }
        assert!(Instant::now() < deadline, "the solution never loaded");
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// `count` sorted round-trip times of `request`, each answer checked.
pub fn timed(count: usize, mut request: impl FnMut(usize) -> Value) -> Vec<Duration> {
    let mut times: Vec<Duration> = (0..count)
        .map(|n| {
            let started = Instant::now();
            let response = request(n);
            let elapsed = started.elapsed();
            assert_nav_ok(&response);
            assert!(
                !response["result"].is_null(),
                "request {n} answers: {response}"
            );
            elapsed
        })
        .collect();
    times.sort();
    times
}

/// The `percent`th percentile of sorted `times`.
pub fn percentile(times: &[Duration], percent: usize) -> Duration {
    let last = times.len().saturating_sub(1);
    times[(last * percent).div_ceil(100).min(last)]
}

/// The resident memory of this server's C# compiler, in megabytes.
pub fn compiler_megabytes(client: &LspClient) -> u64 {
    let apphost = published_apphost_uri("SHARPLSP_CSHARP_SIDECAR_PATH", "published C# apphost");
    let pid = *owned_apphosts(client, &apphost)
        .first()
        .expect("the server owns a C# compiler");
    let system = sysinfo::System::new_all().expect("read the process table");
    system.process(pid).expect("the compiler is alive").memory() >> 20
}

#[test]
fn navigation_meets_its_latency_and_memory_budgets_on_a_thousand_files() {
    require_dotnet();
    let files = file_count();
    let (tmp, root_uri, file_uri, source) = bench_workspace(files);
    let mut client = LspClient::start_verbose();
    let pulls = json!({"textDocument": {"diagnostic": {}}});
    let _ = client.initialize_with_capabilities(json!(root_uri), pulls);
    client.open_document(&file_uri, &source);
    let shape = |n: usize| {
        let line = u32::try_from(7 + n).unwrap();
        (line, column(&source, 7 + n, &format!("Shape{n}()")))
    };
    let (definition, implementation) = ("textDocument/definition", "textDocument/implementation");

    // 1. Cold start: the first answer after the solution loads.
    let loading = Instant::now();
    let first = ask_until_ready(&mut client, &file_uri, shape(0));
    eprintln!(
        "bench: {files} files, first definition after {:?}",
        loading.elapsed()
    );
    assert!(
        first["uri"]
            .as_str()
            .is_some_and(|uri| uri.ends_with("Shape0.cs")),
        "{first}"
    );
    assert_eq!(first["range"]["start"]["line"], 2, "the class declaration");

    // 2. Definition on forty distinct positions: none is memoized, each is a
    //    compiler round trip. [DEFINITION-PERFORMANCE]
    let definitions = timed(USED, |n| ask(&mut client, definition, &file_uri, shape(n)));
    let (p50, p95) = (percentile(&definitions, 50), percentile(&definitions, 95));
    eprintln!("bench: definition p50 {p50:?} p95 {p95:?}");
    assert!(p50 < Duration::from_millis(100), "definition p50 {p50:?}");
    assert!(p95 < Duration::from_millis(250), "definition p95 {p95:?}");
    let last = ask(&mut client, definition, &file_uri, shape(USED - 1));
    let landed = first_location(&last["result"]);
    let expected = format!("Shape{}.cs", USED - 1);
    assert!(
        landed["uri"]
            .as_str()
            .is_some_and(|uri| uri.ends_with(&expected)),
        "{landed}"
    );

    // 3. Implementations of an interface with over a hundred implementers.
    //    [DEFINITION-PERFORMANCE] `IShape` is declared on line 7 of Hub.cs.
    let hub_uri = file_uri.replace("Program.cs", "Hub.cs");
    let hub = std::fs::read_to_string(tmp.path().join("Bench/Hub.cs")).unwrap();
    client.open_document(&hub_uri, &hub);
    let _ = ask(&mut client, implementation, &hub_uri, (7, 17));
    let started = Instant::now();
    let implementations = ask(&mut client, implementation, &hub_uri, (7, 17));
    let implementing = started.elapsed();
    eprintln!("bench: {IMPLEMENTERS} implementations in {implementing:?}");
    assert_nav_ok(&implementations);
    let implementers = implementations["result"].as_array().map(Vec::len);
    assert_eq!(implementers, Some(IMPLEMENTERS.min(files)));
    assert!(
        implementing < Duration::from_millis(500),
        "implementations {implementing:?}"
    );

    // 4. References to a method every file calls: the medium-solution budget,
    //    then the memo's. [REFERENCES-PERFORMANCE] `Touch` is on line 4. The
    //    edit makes the timed request a fresh compiler round trip, and the
    //    pause lets the debounce window pass.
    let references = "textDocument/references";
    let _ = ask(&mut client, references, &hub_uri, (4, 22));
    client.change_document(&hub_uri, 2, &hub);
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    let found = ask(&mut client, references, &hub_uri, (4, 22));
    let finding = started.elapsed();
    eprintln!("bench: {} references in {finding:?}", files + 2);
    assert_nav_ok(&found);
    assert_eq!(found["result"].as_array().map(Vec::len), Some(files + 2));
    let budget = references_budget(files);
    assert!(
        finding < budget,
        "references {finding:?}, budget {budget:?}"
    );
    let started = Instant::now();
    let again = ask(&mut client, references, &hub_uri, (4, 22));
    let memoized = started.elapsed();
    assert_eq!(again["result"], found["result"]);
    // The repeat costs its transport alone, never a compiler round trip.
    let ceiling = Duration::from_millis(50).max(finding.div_f64(4.0));
    assert!(memoized < ceiling, "memoized references {memoized:?}");

    // 5. Document highlights of a local used on every line. [REFERENCES-PERFORMANCE]
    let highlight = "textDocument/documentHighlight";
    let highlights = timed(20, |n| {
        let line = u32::try_from(7 + n).unwrap();
        ask(
            &mut client,
            highlight,
            &file_uri,
            (line, column(&source, 7 + n, "total")),
        )
    });
    let slowest = percentile(&highlights, 100);
    eprintln!("bench: document highlight slowest {slowest:?}");
    assert!(
        slowest < Duration::from_millis(100),
        "highlight {slowest:?}"
    );
    let declared = ask(&mut client, highlight, &file_uri, (6, 12));
    assert_eq!(declared["result"].as_array().map(Vec::len), Some(USED + 2));

    // 6. Sustained definition requests do not grow the compiler: each edit
    //    makes every request a fresh round trip.
    let before = compiler_megabytes(&client);
    for round in 0..10 {
        client.change_document(&file_uri, 2 + round, &source);
        let _ = timed(USED, |n| ask(&mut client, definition, &file_uri, shape(n)));
    }
    let after = compiler_megabytes(&client);
    eprintln!("bench: compiler {before} MB before, {after} MB after 400 definitions");
    assert!(
        after < before + 200,
        "the compiler grew from {before} MB to {after} MB"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn references_on_a_small_solution_answer_within_half_a_second() {
    require_dotnet();
    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);
    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));
    // `AnimalBase` (line 8), `Speak` (line 11) and `Dog` (line 14): three
    // symbols, each asked once warm and never memoized. [REFERENCES-PERFORMANCE]
    let _ = references(&mut client, &file_uri, 2, 17, true);
    let positions = [(8, 22), (11, 26), (14, 13)];
    let times = timed(positions.len(), |n| {
        let (line, character) = positions[n];
        references(&mut client, &file_uri, line, character, true)
    });
    let slowest = percentile(&times, 100);
    eprintln!("bench: small-solution references slowest {slowest:?}");
    assert!(
        slowest < Duration::from_millis(500),
        "references {slowest:?}"
    );
    client.shutdown_and_exit();
    client.wait_with_timeout();
}
