//! Graceful sidecar shutdown: `[SIDECAR-SHUTDOWN-PROTOCOL]` (GitHub #172).
//!
//! One correlated `shutdown` request, a bounded wait for ITS acknowledgement,
//! then a bounded wait for the process to exit on its own. The sidecar flushes
//! that acknowledgement before it stops (`[SIDECAR-SHUTDOWN-ACK]`), so a hard
//! kill is left for a sidecar that did not answer, or answered and stayed.

use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::process::Child;
use tracing::{info, warn};

use super::super::protocol::Envelope;
use super::super::transport::FramedTransport;
use super::SidecarManager;

/// How long the sidecar has to acknowledge `shutdown`.
const ACK_BUDGET: Duration = Duration::from_secs(1);

/// The whole graceful budget. What the acknowledgement leaves of it is the
/// sidecar's time to exit on its own.
const GRACEFUL_BUDGET: Duration = Duration::from_secs(5);

impl SidecarManager {
    /// Stop the sidecar: acknowledgement first, then its own exit, and a kill
    /// only when either is missing. Idempotent — a stopped manager has no
    /// connection to ask and no process to reap.
    pub async fn shutdown(&self) {
        self.shutting_down
            .store(true, std::sync::atomic::Ordering::Release);
        info!(sidecar = %self.name, "Shutting down sidecar");
        let started = Instant::now();
        let acknowledged = self.request_shutdown_ack().await;
        if let Some(mut child) = self.child.lock().await.take() {
            let remaining = GRACEFUL_BUDGET.saturating_sub(started.elapsed());
            reap(&self.name, &mut child, acknowledged, remaining).await;
        }
    }

    /// Ask the live connection to acknowledge `shutdown`, then close IPC
    /// either way. A connection busy with a request is not waited for.
    async fn request_shutdown_ack(&self) -> bool {
        let Ok(mut connection) = self.transport.try_lock() else {
            return false;
        };
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let acknowledged = match connection.as_mut() {
            Some(transport) => request_ack(transport, id).await.map_or_else(
                |error| {
                    warn!(sidecar = %self.name, error = %format!("{error:#}"), "Sidecar did not acknowledge shutdown");
                    false
                },
                |()| true,
            ),
            None => false,
        };
        *connection = None;
        acknowledged
    }
}

/// Send `shutdown` as request `id` and wait, within [`ACK_BUDGET`], for the
/// acknowledgement of THAT request.
async fn request_ack(transport: &mut FramedTransport, id: u32) -> Result<()> {
    let request = Envelope::request(id, "shutdown", rmp_serde::to_vec("shutdown")?);
    tokio::time::timeout(ACK_BUDGET, async {
        transport.write_envelope(&request).await?;
        let reply = transport
            .read_envelope()
            .await?
            .context("the sidecar closed IPC without acknowledging")?;
        verify_ack(&reply, id)
    })
    .await
    .context("no acknowledgement within the budget")?
}

/// The reply answers request `id` with `ok`, and nothing else.
fn verify_ack(reply: &Envelope, id: u32) -> Result<()> {
    if reply.id != Some(id) {
        bail!(
            "the reply answers request {:?}, not shutdown request {id}",
            reply.id
        );
    }
    if let Some(error) = &reply.error {
        bail!("the sidecar refused shutdown: {error}");
    }
    let word: String =
        rmp_serde::from_slice(&reply.payload).context("undecodable acknowledgement")?;
    if word != "ok" {
        bail!("unexpected acknowledgement {word:?}");
    }
    Ok(())
}

/// End the child. One that acknowledged gets `remaining` to exit on its own;
/// one that did not, or overstays, is killed.
async fn reap(name: &str, child: &mut Child, acknowledged: bool, remaining: Duration) {
    if acknowledged && exits_on_its_own(name, child, remaining).await {
        return;
    }
    warn!(sidecar = %name, acknowledged, "Killing sidecar");
    if let Err(error) = child.kill().await {
        warn!(sidecar = %name, %error, "Killing the sidecar failed");
    }
}

/// Whether the child exits by itself within `remaining`.
async fn exits_on_its_own(name: &str, child: &mut Child, remaining: Duration) -> bool {
    match tokio::time::timeout(remaining, child.wait()).await {
        Ok(Ok(status)) => {
            info!(sidecar = %name, success = status.success(), code = ?status.code(), "Sidecar acknowledged shutdown and exited on its own");
            true
        }
        Ok(Err(error)) => {
            warn!(sidecar = %name, %error, "Waiting for the sidecar to exit failed");
            false
        }
        Err(_) => {
            warn!(sidecar = %name, budget_ms = remaining.as_millis(), "Sidecar acknowledged shutdown but did not exit");
            false
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use std::process::Stdio;

    use tokio::process::Command;

    use super::*;

    /// A child that exits zero at once, or one that outlives every budget here.
    fn spawn(lingers: bool) -> Child {
        let (program, args): (&str, &[&str]) = match (cfg!(windows), lingers) {
            (true, false) => ("cmd", &["/C", "exit 0"]),
            (true, true) => ("ping", &["-n", "60", "127.0.0.1"]),
            (false, false) => ("true", &[]),
            (false, true) => ("sleep", &["60"]),
        };
        Command::new(program)
            .args(args)
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    /// A connected pair: the host's transport and the scripted sidecar's.
    fn connected() -> (FramedTransport, FramedTransport) {
        let (host, sidecar) = tokio::io::duplex(4096);
        (
            FramedTransport::from_stream(host),
            FramedTransport::from_stream(sidecar),
        )
    }

    /// The sidecar's side: read the request, answer it with `reply(request)`.
    async fn answer(
        mut sidecar: FramedTransport,
        reply: impl FnOnce(&Envelope) -> Envelope,
    ) -> Envelope {
        let request = sidecar.read_envelope().await.unwrap().unwrap();
        sidecar.write_envelope(&reply(&request)).await.unwrap();
        request
    }

    /// A response to `id` carrying `word`, or refusing with `error`.
    fn response(id: Option<u32>, word: &str, error: Option<&str>) -> Envelope {
        Envelope {
            id,
            method: None,
            payload: rmp_serde::to_vec(word).unwrap(),
            error: error.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn the_correlated_ok_is_an_acknowledgement() {
        let (mut host, sidecar) = connected();
        let peer = tokio::spawn(answer(sidecar, |request| response(request.id, "ok", None)));

        let acknowledged = request_ack(&mut host, 7).await;
        let request = peer.await.unwrap();

        assert!(acknowledged.is_ok(), "{acknowledged:?}");
        assert_eq!(request.id, Some(7), "one correlated request");
        assert_eq!(request.method.as_deref(), Some("shutdown"));
    }

    #[tokio::test]
    async fn a_reply_to_another_request_or_a_refusal_is_no_acknowledgement() {
        let cases: [(Option<u32>, &str, Option<&str>, &str); 3] = [
            (Some(6), "ok", None, "not shutdown request 7"),
            (Some(7), "ok", Some("busy"), "refused shutdown: busy"),
            (Some(7), "pong", None, "unexpected acknowledgement"),
        ];
        for (id, word, error, why) in cases {
            let (mut host, sidecar) = connected();
            let peer = tokio::spawn(answer(sidecar, move |_| response(id, word, error)));
            let refused = request_ack(&mut host, 7).await.unwrap_err();
            let _ = peer.await.unwrap();
            assert!(
                format!("{refused:#}").contains(why),
                "{refused:#} must say {why}"
            );
        }
    }

    #[tokio::test]
    async fn silence_or_a_closed_connection_ends_the_wait_within_the_budget() {
        let (mut host, _silent) = connected();
        let started = Instant::now();
        let silence = request_ack(&mut host, 1).await.unwrap_err();
        assert!(
            format!("{silence:#}").contains("within the budget"),
            "{silence:#}"
        );
        assert!(
            started.elapsed() < ACK_BUDGET * 3,
            "the budget bounds the wait"
        );

        let (mut host, sidecar) = connected();
        let peer = tokio::spawn(async move {
            let mut sidecar = sidecar;
            let _ = sidecar.read_envelope().await.unwrap();
        });
        let closed = request_ack(&mut host, 2).await.unwrap_err();
        peer.await.unwrap();
        assert!(
            format!("{closed:#}").contains("without acknowledging"),
            "{closed:#}"
        );
    }

    #[tokio::test]
    async fn an_acknowledged_sidecar_exits_on_its_own() {
        let mut child = spawn(false);
        reap("test", &mut child, true, GRACEFUL_BUDGET).await;
        let status = child.wait().await.unwrap();
        assert!(
            status.success(),
            "it exited by itself, not killed: {status}"
        );
        assert_eq!(status.code(), Some(0));
    }

    /// Acknowledged but staying: killed once its budget runs out. Never
    /// acknowledged: killed at once, however long the budget.
    #[tokio::test]
    async fn a_sidecar_that_stays_or_never_acknowledged_is_killed() {
        let short = Duration::from_millis(300);
        for (acknowledged, budget, waits) in [
            (true, short, short),
            (false, GRACEFUL_BUDGET, Duration::ZERO),
        ] {
            let mut child = spawn(true);
            let started = Instant::now();
            reap("test", &mut child, acknowledged, budget).await;
            let status = child.wait().await.unwrap();
            assert!(
                !status.success(),
                "acknowledged={acknowledged}: killed, {status}"
            );
            assert!(
                started.elapsed() >= waits,
                "acknowledged={acknowledged}: waits {waits:?}"
            );
            assert!(
                started.elapsed() < GRACEFUL_BUDGET,
                "acknowledged={acknowledged}: and no more"
            );
        }
    }

    #[tokio::test]
    async fn shutdown_asks_the_live_connection_then_closes_it_and_is_idempotent() {
        let (host, sidecar) = tokio::io::duplex(4096);
        let manager = SidecarManager::connected_to_stream_for_tests(host).await;
        let peer = tokio::spawn(answer(FramedTransport::from_stream(sidecar), |request| {
            response(request.id, "ok", None)
        }));

        manager.shutdown().await;
        let request = peer.await.unwrap();
        assert_eq!(request.method.as_deref(), Some("shutdown"));
        assert!(manager.is_shutting_down());
        assert!(manager.transport.lock().await.is_none(), "IPC is closed");

        manager.shutdown().await;
        assert!(
            manager.transport.lock().await.is_none(),
            "a second shutdown is a no-op"
        );
        assert!(manager.child.lock().await.is_none());
    }
}
