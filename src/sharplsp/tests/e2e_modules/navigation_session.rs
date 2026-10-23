//! Real call graph navigation. Implements [SHARPLSP-FEATURES-NAVIGATION].
use super::*;

const FSHARP_CALLS: &str = "module TestFSharp\nlet leaf value = value\nlet middle value = leaf value\nlet root value = (middle value, middle value)\n";
const CSHARP_CALLS: &str = "namespace TestHover;\npublic static class Calls\n{\n    public static int Leaf(int value) => value;\n    public static int Middle(int value) => Leaf(value);\n    public static int Root(int value) => Middle(value) + Middle(value);\n}\n";

/// Follow both directions from an actual prepared item, preserving each call site.
fn assert_call_graph(client: &mut LspClient, uri: &str, root: (u64, u64), kind: u32) {
    let item = prepared(
        client,
        "textDocument/prepareCallHierarchy",
        uri,
        root.0,
        root.1,
    );
    assert_eq!(item["name"], if kind == 12 { "root" } else { "Root" });
    assert_eq!(item["kind"], kind);
    assert_eq!(item["uri"], uri);
    let response = client.request("callHierarchy/outgoingCalls", json!({"item": item}));
    assert_rpc_ok(&response, "root outgoing calls");
    let calls = response["result"].as_array().expect("outgoing call array");
    assert_eq!(calls.len(), 1, "two uses are one callee: {response}");
    let call = &calls[0];
    assert_eq!(
        call["to"]["name"],
        if kind == 12 { "middle" } else { "Middle" }
    );
    assert_eq!(call["to"]["kind"], kind);
    assert_eq!(call["to"]["uri"], uri);
    assert_call_sites(&call["fromRanges"], root.0, 2);
    assert_reverse_graph(client, uri, &call["to"], root.0, kind);
}

/// Both uses remain selectable, and expanding the leaf yields a terminal node.
fn assert_reverse_graph(
    client: &mut LspClient,
    uri: &str,
    middle: &Value,
    root_line: u64,
    kind: u32,
) {
    let incoming = client.request("callHierarchy/incomingCalls", json!({"item": middle}));
    assert_rpc_ok(&incoming, "middle incoming calls");
    let callers = incoming["result"].as_array().expect("incoming call array");
    assert_eq!(callers.len(), 1, "one caller with two sites: {incoming}");
    assert_eq!(
        callers[0]["from"]["name"],
        if kind == 12 { "root" } else { "Root" }
    );
    assert_eq!(callers[0]["from"]["uri"], uri);
    assert_call_sites(&callers[0]["fromRanges"], root_line, 2);
    let outgoing = client.request("callHierarchy/outgoingCalls", json!({"item": middle}));
    assert_rpc_ok(&outgoing, "expand middle");
    let targets = outgoing["result"].as_array().expect("middle callee array");
    assert_eq!(targets.len(), 1, "middle calls one leaf: {outgoing}");
    assert_eq!(
        targets[0]["to"]["name"],
        if kind == 12 { "leaf" } else { "Leaf" }
    );
    assert_eq!(targets[0]["to"]["uri"], uri);
    let terminal = client.request(
        "callHierarchy/outgoingCalls",
        json!({"item": targets[0]["to"]}),
    );
    assert_rpc_ok(&terminal, "leaf outgoing calls");
    assert_eq!(terminal["result"], json!([]), "leaf has no callees");
}

/// Every call site has a distinct, nonempty span on the caller's source line.
fn assert_call_sites(value: &Value, line: u64, count: usize) {
    let sites = value.as_array().expect("call site array");
    assert_eq!(sites.len(), count, "every application is retained: {value}");
    for site in sites {
        assert_eq!(site["start"]["line"], line);
        assert_eq!(site["end"]["line"], line);
        assert!(
            site["end"]["character"].as_u64().expect("end column")
                > site["start"]["character"].as_u64().expect("start column")
        );
    }
    assert_ne!(sites[0], sites[1], "distinct call sites cannot collapse");
}

#[test]
fn call_hierarchy_follows_real_fsharp_and_csharp_chains_with_repeated_calls() {
    require_dotnet();
    let (fsharp, root, uri, _) = create_fsharp_test_workspace();
    std::fs::write(fsharp.path().join("TestFSharp/Library.fs"), FSHARP_CALLS)
        .expect("write full F# graph");
    std::fs::write(
        fsharp.path().join("sharplsp.toml"),
        "[csharp]\nenabled=false\n",
    )
    .expect("F# runs independently");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(fsharp.path()));
    assert_rpc_ok(
        &client.initialize_with_root(json!(root)),
        "initialize F# graph",
    );
    client.notify(
        "textDocument/didOpen",
        json!({"textDocument":{"uri":uri,"languageId":"fsharp","version":1,"text":FSHARP_CALLS}}),
    );
    let _ = poll_hover_until_ready(&mut client, &uri, 3, 5, Duration::from_secs(90));
    assert_call_graph(&mut client, &uri, (3, 5), 12);
    client.shutdown_and_exit();
    let (csharp, root, uri, _) = create_test_workspace();
    std::fs::write(csharp.path().join("TestHover/Program.cs"), CSHARP_CALLS)
        .expect("write full C# graph");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(csharp.path()));
    assert_rpc_ok(
        &client.initialize_with_root(json!(root)),
        "initialize C# graph",
    );
    client.open_document(&uri, CSHARP_CALLS);
    let _ = poll_hover_until_ready(&mut client, &uri, 5, 23, Duration::from_secs(90));
    assert_call_graph(&mut client, &uri, (5, 23), 6);
    client.shutdown_and_exit();
}
