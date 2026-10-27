//! Editor configuration and unavailable package edits through a real F# project.
//! Implements [CONFIG-RESOLUTION] and [NUGET-XML-DOM].
use super::*;

#[test]
fn real_project_configuration_retains_valid_layers_after_rejected_updates_and_edits() {
    require_dotnet();
    let (workspace, root, _, _) = create_fsharp_test_workspace();
    std::fs::write(
        workspace.path().join("sharplsp.toml"),
        "[csharp]\nenabled=false\n[fsharp]\nenabled=false\n[testing]\nconfiguration='Debug'\n",
    )
    .expect("write the real workspace configuration");
    let project = workspace.path().join("TestFSharp/TestFSharp.fsproj");
    let before = std::fs::read(&project).expect("read real project before rejected edit");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(workspace.path()));
    assert_rpc_ok(
        &client.initialize_with_root(json!(root)),
        "initialize F# project configuration",
    );
    let initial = client.request(
        "sharplsp/configuration",
        json!({"scopeUri":path_to_file_uri(&project)}),
    );
    assert_configuration(&initial, "Debug");
    client.notify("workspace/didChangeConfiguration", json!({"settings":{"sharplsp":{"testing":{"configuration":"Release"},"debug":{"exceptions":{"ignore":["System.Exception"]}}}}}));
    assert_configuration(
        &client.request("sharplsp/configuration", json!({})),
        "Release",
    );
    assert_rejected_updates(&mut client);
    assert_unavailable_edits(&mut client, &project);
    assert_eq!(
        std::fs::read(&project).expect("read unchanged project"),
        before,
        "failed edits cannot mutate a real project"
    );
    client.shutdown_and_exit();
}

/// A successful request keeps both the selected configuration and workspace settings.
fn assert_configuration(response: &Value, configuration: &str) {
    assert_rpc_ok(response, "effective configuration");
    assert_eq!(
        response["result"]["testing"]["configuration"],
        configuration
    );
    assert_eq!(response["result"]["csharp"]["enabled"], false);
    assert_eq!(response["result"]["fsharp"]["enabled"], false);
}

/// Reject bad requests and notifications, then prove the prior good layer survives.
fn assert_rejected_updates(client: &mut LspClient) {
    for overrides in [
        json!({"testing":{"configuration":"Release;Rebuild"}}),
        json!({"debug":{"exceptions":{"ignore":["System.*Exception"]}}}),
        json!({"unknown_setting":true}),
    ] {
        let rejected = client.request("sharplsp/configuration", json!({"overrides":overrides}));
        assert_eq!(rejected["jsonrpc"], "2.0");
        assert!(rejected["id"].is_number());
        assert_eq!(
            rejected["error"]["code"], -32602,
            "invalid configuration is InvalidParams: {rejected}"
        );
        assert_ne!(
            rejected["error"]["message"]
                .as_str()
                .expect("error message"),
            ""
        );
        client.notify(
            "workspace/didChangeConfiguration",
            json!({"settings":{"sharplsp":overrides}}),
        );
        let retained = client.request("sharplsp/configuration", json!({}));
        assert_configuration(&retained, "Release");
        assert_eq!(
            retained["result"]["debug"]["exceptions"]["ignore"],
            json!(["System.Exception"])
        );
    }
    let temporary = client.request(
        "sharplsp/configuration",
        json!({"overrides":{"testing":{"configuration":"Custom"}}}),
    );
    assert_configuration(&temporary, "Custom");
    assert_configuration(
        &client.request("sharplsp/configuration", json!({})),
        "Release",
    );
}

/// Neither install nor uninstall may claim to edit when the DOM owner is disabled.
fn assert_unavailable_edits(client: &mut LspClient, project: &std::path::Path) {
    let target = json!({"id":project,"path":project,"kind":"project","displayName":"F#"});
    for method in ["sharplsp/nuget/install", "sharplsp/nuget/uninstall"] {
        let (response, notifications) = client.request_collecting_notifications(
            method,
            json!({"target":target,"packageId":"Newtonsoft.Json","version":"13.0.3"}),
        );
        assert_rpc_ok(&response, method);
        assert_eq!(response["result"]["success"], false);
        assert!(
            response["result"].get("modifiedFiles").is_none(),
            "the wire contract omits an empty modifiedFiles list"
        );
        assert!(response["result"]["message"]
            .as_str()
            .expect("actionable edit failure")
            .contains("not available"));
        assert!(
            !notifications
                .iter()
                .any(|notification| notification["method"] == "sharplsp/nuget/restoreProgress"),
            "no failed edit can start a restore"
        );
        assert_configuration(
            &client.request("sharplsp/configuration", json!({})),
            "Release",
        );
    }
}
