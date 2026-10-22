//! Native LSP coverage of [TEST-REACTIVITY-BUILD], independent of an editor's task API.
use super::*;
use fixtures_cross_language::dotnet;

const COMPLETED: &str = "sharplsp/buildCompleted";

/// Drain through a request barrier, so silence assertions never block on stdout.
fn build_messages(client: &mut LspClient, delay: Duration) -> Vec<Value> {
    std::thread::sleep(delay);
    let (response, messages) =
        client.request_collecting_notifications("sharplsp/configuration", json!({}));
    assert_rpc_ok(&response, "build monitoring leaves requests responsive");
    messages
        .into_iter()
        .filter(|message| message["method"] == COMPLETED)
        .collect()
}

/// Await the native watcher without assuming a machine's event-delivery latency.
fn assert_one_build(client: &mut LspClient, root: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut messages = Vec::new();
    while messages.is_empty() && Instant::now() < deadline {
        messages.extend(build_messages(client, Duration::from_millis(100)));
    }
    messages.extend(build_messages(client, Duration::from_secs(1)));
    assert_eq!(
        messages.len(),
        1,
        "one real build's output burst is coalesced: {messages:?}"
    );
    let message = messages.first().expect("one completion was asserted");
    assert_eq!(
        message["params"]["root"], root,
        "the notification identifies its watched root"
    );
    assert!(
        message.get("id").is_none(),
        "completion is a notification, not a client request"
    );
}

#[test]
fn native_build_monitor_follows_real_builds_and_releases_old_roots() {
    require_dotnet();
    let (fsharp, fsharp_uri, _, _) = create_fsharp_test_workspace();
    let (csharp, _, _, _) = create_test_workspace();
    std::fs::write(
        fsharp.path().join("sharplsp.toml"),
        "[csharp]\nenabled=false\n[fsharp]\nenabled=false\n",
    )
    .expect("write sidecar-free fixture configuration");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(fsharp.path()));
    assert_rpc_ok(
        &client.initialize_with_root(json!(fsharp_uri)),
        "initialize real F# workspace",
    );
    assert!(
        build_messages(&mut client, Duration::ZERO).is_empty(),
        "initialization is not a build"
    );

    dotnet(
        &[
            "build",
            "TestFSharp/TestFSharp.fsproj",
            "--no-restore",
            "--nologo",
        ],
        fsharp.path(),
    );
    assert_one_build(&mut client, &fsharp_uri);
    std::fs::write(
        fsharp.path().join("Unbuilt.fs"),
        "module Unbuilt\nlet value = 1\n",
    )
    .expect("write an unbuilt F# source file");
    assert!(
        build_messages(&mut client, Duration::from_secs(1)).is_empty(),
        "source-only edits never announce compiled tests"
    );

    let csharp_root = csharp.path().join("TestHover");
    let project = csharp_root.join("TestHover.csproj");
    client.notify(
        "sharplsp/watchBuilds",
        json!({"targets": [project, project]}),
    );
    assert!(
        build_messages(&mut client, Duration::ZERO).is_empty(),
        "retargeting itself is not a build"
    );
    client.notify("sharplsp/watchBuilds", json!({"targets": false}));
    assert!(
        build_messages(&mut client, Duration::ZERO).is_empty(),
        "malformed subscriptions keep the previous valid roots"
    );
    dotnet(
        &[
            "build",
            "TestHover/TestHover.csproj",
            "--no-restore",
            "--nologo",
        ],
        csharp.path(),
    );
    assert_one_build(&mut client, &path_to_file_uri(&csharp_root));

    dotnet(
        &["clean", "TestFSharp/TestFSharp.fsproj", "--nologo"],
        fsharp.path(),
    );
    assert!(
        build_messages(&mut client, Duration::from_secs(1)).is_empty(),
        "the previous root's watcher was released"
    );
    client.notify("sharplsp/watchBuilds", json!({"targets": []}));
    assert!(
        build_messages(&mut client, Duration::ZERO).is_empty(),
        "unsubscribing emits no completion"
    );
    dotnet(
        &["clean", "TestHover/TestHover.csproj", "--nologo"],
        csharp.path(),
    );
    assert!(
        build_messages(&mut client, Duration::from_secs(1)).is_empty(),
        "an empty watch set releases every root"
    );
    client.shutdown_and_exit();
    client.wait_with_timeout();
}
