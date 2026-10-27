//! Actual SDK workspace completion signals, including replacement and switching back.
//! Implements [DIAG-IPC-INITIALIZED] and [DIAG-TRUTH-GUARANTEES].
use super::*;

#[test]
fn workspace_completion_signals_follow_both_real_compilers_and_each_solution_selection() {
    let first = broken_workspace();
    let second = broken_workspace();
    let mut client = initialized(&first);
    let mut traffic = Vec::new();
    let mut previous = selection::assert_selected(&mut client, &first, &[], &mut traffic);
    assert_completed(&traffic);
    for selected in [&second, &first] {
        traffic.clear();
        let response = observed_request(
            &mut client,
            "sharplsp/loadSolution",
            json!({"solutionPath":selected.root.join("Medium.sln")}),
            &mut traffic,
        );
        assert_eq!(response["result"]["success"], true);
        previous = selection::assert_selected(&mut client, selected, &previous, &mut traffic);
        assert_completed(&traffic);
    }
    client.shutdown_and_exit();
}

/// Both loaded compiler engines announce completion exactly once per workspace selection.
fn assert_completed(traffic: &[Value]) {
    let completed: Vec<_> = traffic
        .iter()
        .filter(|message| message["method"] == "workspace/projectInitializationComplete")
        .collect();
    assert_eq!(
        completed.len(),
        2,
        "both real compiler workspace opens must signal completion"
    );
    for notification in completed {
        assert_eq!(notification["jsonrpc"], "2.0");
        assert!(
            notification.get("id").is_none(),
            "completion is a notification, not a request"
        );
        assert_eq!(notification["params"], Value::Null);
    }
    assert_no_push(traffic);
}
