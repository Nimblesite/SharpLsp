//! Requests reach the sidecar in the order they arrived at the host:
//! `[SIDECAR-IPC-DRIVER]` ("workspace mutations and semantic reads retain
//! arrival order"). The Solution Explorer's `solution/read`, queued behind a
//! 26s `workspace/open`, was overtaken by the solution-wide diagnostics scan
//! the host issued the instant the open finished, and waited another 15s.

use std::sync::Arc;
use std::time::Duration;

use super::SidecarManager;
use crate::sidecar::protocol::Envelope;
use crate::sidecar::transport::FramedTransport;

/// Rounds of the race; the overtaking needs two threads to interleave.
const ROUNDS: usize = 200;

/// A log sink as slow as a file write: the host's request log line is what
/// held a reader between taking its ID and taking the transport.
struct FileLikeSink;

impl std::io::Write for FileLikeSink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        std::thread::sleep(Duration::from_millis(1));
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A subscriber for one thread that logs through [`FileLikeSink`].
fn logged_like_production() -> impl tracing::Subscriber + Send + Sync {
    tracing_subscriber::fmt()
        .with_writer(|| FileLikeSink)
        .finish()
}

/// Answer `request` with an empty payload.
async fn answer(sidecar: &mut FramedTransport, request: &Envelope) {
    let response = Envelope {
        id: request.id,
        method: None,
        payload: Vec::new(),
        error: None,
    };
    sidecar.write_envelope(&response).await.unwrap();
}

/// The next request the sidecar reads, answered.
async fn next_method(sidecar: &mut FramedTransport) -> String {
    let request = sidecar.read_envelope().await.unwrap().unwrap();
    answer(sidecar, &request).await;
    request.method.unwrap()
}

/// One round: `workspace/open` in flight, `solution/read` queued behind it,
/// and the scan issued the moment the open completes, as the host does.
async fn round(manager: &Arc<SidecarManager>, sidecar: &mut FramedTransport) -> Vec<String> {
    let opener = Arc::clone(manager);
    let open_then_scan = tokio::spawn(async move {
        let _ = opener.request("workspace/open", Vec::new()).await;
        opener
            .request("workspace/diagnostics/all", Vec::new())
            .await
    });
    let open = sidecar.read_envelope().await.unwrap().unwrap();

    // The LSP main loop asks from its own thread through `block_on`, exactly as
    // `workspace_symbols` sends `solution/read`, and its request log line costs
    // what a real log sink does.
    let reader = Arc::clone(manager);
    let runtime = tokio::runtime::Handle::current();
    let (started, asking) = tokio::sync::oneshot::channel();
    let read = std::thread::spawn(move || {
        let _logging = tracing::subscriber::set_default(logged_like_production());
        let _ = started.send(());
        let _ = runtime.block_on(reader.request("solution/read", Vec::new()));
    });
    // Queued behind the open well before the open completes.
    asking.await.unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;

    answer(sidecar, &open).await;
    let order = vec![next_method(sidecar).await, next_method(sidecar).await];
    read.join().unwrap();
    let _ = open_then_scan.await;
    order
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_queued_request_is_never_overtaken_by_a_later_one() {
    let (host_side, sidecar_side) = tokio::io::duplex(64 * 1024);
    let manager = Arc::new(SidecarManager::connected_to_stream_for_tests(host_side).await);
    let mut sidecar = FramedTransport::from_stream(sidecar_side);

    for attempt in 0..ROUNDS {
        let order = round(&manager, &mut sidecar).await;
        assert_eq!(
            order,
            ["solution/read", "workspace/diagnostics/all"],
            "round {attempt}: the request queued first must be written first"
        );
    }
}
