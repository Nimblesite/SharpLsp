//! [PROFILER-PERFORMANCE] Cancelling a real dump leaves the target and host usable.
use super::profiler_full_stack::start_profiler_session;
use super::*;

#[test]
fn profiler_dump_cancellation_preserves_target_and_recovers() {
    let (_target, pid, mut client) = start_profiler_session();
    let dir = tempfile::tempdir().expect("temporary dump directory");
    let cancelled = dir.path().join("cancelled.dmp");
    let params = json!({"pid": pid, "dump_type": "Heap", "output_path": cancelled});
    cancel_dump(&mut client, params);
    assert_target_available(&mut client, pid);
    let completed = dir.path().join("completed.dmp");
    let response = client.request(
        "sharplsp/profiler/collectDump",
        json!({"pid": pid, "dump_type": "Heap", "output_path": completed}),
    );
    assert!(response.get("error").is_none(), "{response}");
    assert!(response["result"]["file_size_bytes"]
        .as_u64()
        .is_some_and(|n| n > 0));
    assert!(completed.metadata().expect("completed dump").len() > 0);
    client.shutdown_and_exit();
    client.wait_with_timeout();
}

fn cancel_dump(client: &mut LspClient, params: Value) {
    let id = next_id();
    client.send(&json!({"jsonrpc":"2.0", "id":id,
        "method":"sharplsp/profiler/collectDump", "params":params}));
    let progress = client.wait_for_notification("$/progress", Duration::from_secs(10));
    assert_eq!(progress["params"]["value"]["kind"], "begin");
    client.notify("$/cancelRequest", json!({"id": id}));
    loop {
        let message = client.recv();
        if message.get("id") == Some(&json!(id)) {
            assert_eq!(message["error"]["code"], -32800, "{message}");
            assert!(message.get("result").is_none(), "{message}");
            break;
        }
    }
}

fn assert_target_available(client: &mut LspClient, pid: u32) {
    let response = client.request("sharplsp/profiler/listProcesses", json!({}));
    assert!(response.get("error").is_none(), "{response}");
    let processes = response["result"].as_array().expect("process list");
    assert!(
        processes.iter().any(|process| process["pid"] == pid),
        "{response}"
    );
}
