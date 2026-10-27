//! Region folding follows complete document revisions. [SHARPLSP-ARCHITECTURE-ROUTING]
use super::*;

const NESTED: &str = "namespace TestHover;\n#region Outer\npublic class Folded\n{\n#region Inner\n    public int Value => 1;\n#endregion\n}\n#endregion\n";
const PARTIAL: &str = "namespace TestHover;\n#region Outer\npublic class Folded\n{\n#region Inner\n    public int Value => 2;\n#endregion\n}\n";
const PLAIN: &str = "namespace TestHover;\npublic class Folded\n{\n    public int Value => 3;\n}\n";

/// Only explicit, closed region directives carry the region kind.
fn regions(client: &mut LspClient, uri: &str) -> Vec<(u64, u64)> {
    let response = document_request(client, "textDocument/foldingRange", uri);
    assert_rpc_ok(&response, "live folding ranges");
    response["result"]
        .as_array()
        .expect("folding array")
        .iter()
        .filter(|fold| fold["kind"] == "region")
        .map(|fold| {
            let start = fold["startLine"].as_u64().expect("region start");
            let end = fold["endLine"].as_u64().expect("region end");
            assert!(end > start, "a region spans actual source lines");
            assert!(fold["collapsedText"].is_null());
            (start, end)
        })
        .collect()
}

#[test]
fn real_project_region_folding_tracks_nested_partial_and_removed_directives() {
    require_dotnet();
    let (workspace, root, uri, _) = create_test_workspace();
    std::fs::write(workspace.path().join("TestHover/Program.cs"), NESTED)
        .expect("write the actual C# region fixture");
    std::fs::write(
        workspace.path().join("sharplsp.toml"),
        "[csharp]\nenabled=false\n[fsharp]\nenabled=false\n",
    )
    .expect("syntax folding needs no sidecar");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(workspace.path()));
    assert_rpc_ok(
        &client.initialize_with_root(json!(root)),
        "initialize actual region project",
    );
    client.open_document(&uri, NESTED);
    assert_eq!(
        regions(&mut client, &uri),
        vec![(4, 6), (1, 8)],
        "nested pairs close innermost first and end on their directive"
    );
    client.change_document(&uri, 2, PARTIAL);
    assert_eq!(
        regions(&mut client, &uri),
        vec![(4, 6)],
        "an unfinished outer region cannot swallow the remaining file"
    );
    client.change_document(&uri, 3, PLAIN);
    assert_eq!(
        regions(&mut client, &uri),
        Vec::<(u64, u64)>::new(),
        "removing directives removes their folds immediately"
    );
    let symbols = document_request(&mut client, "textDocument/documentSymbol", &uri);
    assert_rpc_ok(
        &symbols,
        "syntax remains responsive after incomplete directives",
    );
    assert!(
        find_symbol(&symbols["result"], "Folded").is_some(),
        "the class stays navigable after edits: {symbols}"
    );
    client.shutdown_and_exit();
}
