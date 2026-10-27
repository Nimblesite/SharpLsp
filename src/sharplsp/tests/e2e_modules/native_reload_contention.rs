//! Native watched-file reloads must never stall the foreground request loop.
//!
//! Implements [DIAG-LSP-REFRESH]: a source the loaded graph does not know
//! requires a project-graph reload so new implicit SDK sources are discovered
//! (#466) — but that reload is SIDECAR work, and the loop that answers the
//! editor's requests must keep answering while it runs. PR #494's CI regressed
//! exactly here: every debug/test suite materialises a fixture project inside
//! the watched workspace, the native watcher answered with a full reload per
//! event batch, and the reloads ran ON the foreground loop — so `launch`
//! resolution (`sharplsp/configuration`), `sharplsp/hotReload` and test
//! discovery queued behind them until the suites' 50 s budgets expired.

use super::*;

/// Each storm source is its own event batch: writes sit outside the watcher's
/// 150 ms coalescing quiet window, so each one owes the graph a reload.
const STORM_BATCH_GAP: Duration = Duration::from_millis(500);

/// The budget an unrelated request may take while reloads churn. One warm
/// `sharplsp/configuration` answers in single-digit milliseconds; queued behind
/// even two serialized sidecar reloads it blows past this by an order of
/// magnitude — which is the regression this test pins.
const FOREGROUND_BUDGET: Duration = Duration::from_secs(3);

#[test]
fn native_reload_storm_cannot_stall_foreground_requests() {
    require_dotnet();

    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("LoopProbe");
    std::fs::create_dir_all(&proj_dir).unwrap();
    std::fs::write(
        proj_dir.join("LoopProbe.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();
    std::fs::write(
        proj_dir.join("Baseline.cs"),
        r"namespace LoopProbe;
public class Baseline { public int Value { get; set; } }
",
    )
    .unwrap();
    std::fs::write(
        tmp.path().join("LoopProbe.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "LoopProbe", "LoopProbe/LoopProbe.csproj", "{00000000-0000-0000-0000-000000000001}"
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
    let root_uri = path_to_file_uri(&real_root);

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));

    // The sidecar's completion notification is the signal that the workspace
    // loaded and native watching is armed — before it, no storm can start.
    let armed = Instant::now();
    loop {
        let msg = client.recv();
        if msg["method"].as_str() == Some("workspace/projectInitializationComplete") {
            break;
        }
        assert!(
            armed.elapsed() < Duration::from_mins(2),
            "the sidecar must finish loading the solution within 120s",
        );
    }

    // Warm probe: the request every debug launch resolves through.
    let warm = configuration_probe(&mut client);
    assert!(
        warm.value.get("error").is_none(),
        "warm sharplsp/configuration must succeed: {}",
        warm.value
    );

    // The storm: new sources the loaded graph does not know yet. Each write is
    // its own batch, so each owes the sidecar a full project-graph reload —
    // exactly what a suite materialising a fixture project produces.
    for index in 0..10 {
        std::fs::write(
            proj_dir.join(format!("Storm{index}.cs")),
            format!("namespace LoopProbe.Storm{index};\npublic class S{index} {{ }}\n"),
        )
        .unwrap();
        std::thread::sleep(STORM_BATCH_GAP);
    }

    // The regression: an unrelated foreground request must not queue behind the
    // reloads the storm owes. On the stalled loop this waits for every one of
    // them; a responsive loop answers at warm speed.
    let probed = configuration_probe(&mut client);
    assert!(
        probed.value.get("error").is_none(),
        "sharplsp/configuration during native reloads must succeed: {}",
        probed.value
    );
    assert!(
        probed.elapsed < FOREGROUND_BUDGET,
        "sharplsp/configuration took {}ms while native reloads churned \
         (warm: {}ms) — watched-file reloads are blocking the foreground loop. \
         Every debug launch resolves through this request, so a materialised \
         fixture project stalls the launch until the test budget expires",
        probed.elapsed.as_millis(),
        warm.elapsed.as_millis(),
    );

    // And the reloads still HAPPEN: the first stormed source must eventually be
    // adopted and published, pinning the #466 discovery this scheduling change
    // must preserve. Silence here would mean the fix simply stopped reloading.
    let adoption = Instant::now();
    loop {
        let msg = client.recv();
        if msg["method"].as_str() == Some("textDocument/publishDiagnostics")
            && msg["params"]["uri"]
                .as_str()
                .is_some_and(|uri| uri.contains("Storm0.cs"))
        {
            break;
        }
        assert!(
            adoption.elapsed() < Duration::from_mins(2),
            "the stormed source Storm0.cs must be adopted and published within 120s",
        );
    }

    client.shutdown_and_exit();
}

/// One `sharplsp/configuration` round trip with its elapsed time.
fn configuration_probe(client: &mut LspClient) -> Probe {
    let started = Instant::now();
    let value = client.request("sharplsp/configuration", json!({}));
    Probe {
        value,
        elapsed: started.elapsed(),
    }
}

struct Probe {
    value: Value,
    elapsed: Duration,
}
