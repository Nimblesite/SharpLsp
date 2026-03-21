//! Sidecar lifecycle manager — spawn, health monitoring, crash recovery.

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::AsyncBufReadExt;
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use super::protocol::Envelope;
use super::transport::FramedTransport;

/// Maximum backoff delay for crash recovery.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Initial backoff delay.
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
/// Health ping interval.
const PING_INTERVAL: Duration = Duration::from_secs(5);
/// Ping response timeout.
const PING_TIMEOUT: Duration = Duration::from_secs(2);
/// How long to wait for the sidecar READY signal.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Manages a single sidecar process (C# or F#).
pub struct SidecarManager {
    /// Display name for logging.
    name: String,
    /// Command to spawn the sidecar.
    spawn_command: String,
    /// Arguments for the spawn command.
    spawn_args: Vec<String>,
    /// Socket path for IPC.
    socket_path: String,
    /// The running child process.
    child: Mutex<Option<Child>>,
    /// The IPC transport.
    transport: Mutex<Option<FramedTransport>>,
    /// Request ID counter.
    next_id: AtomicU32,
    /// Current backoff duration for crash recovery.
    backoff: Mutex<Duration>,
}

impl SidecarManager {
    /// Create a new sidecar manager.
    pub fn new(
        name: &str,
        spawn_command: &str,
        spawn_args: Vec<String>,
        socket_path: &str,
    ) -> Self {
        Self {
            name: name.to_string(),
            spawn_command: spawn_command.to_string(),
            spawn_args,
            socket_path: socket_path.to_string(),
            child: Mutex::new(None),
            transport: Mutex::new(None),
            next_id: AtomicU32::new(1),
            backoff: Mutex::new(INITIAL_BACKOFF),
        }
    }

    /// Create a manager for the C# sidecar.
    pub fn csharp(workspace_root: &Path) -> Self {
        let socket_path = format!(
            "{}/forge-csharp-{:x}.sock",
            std::env::temp_dir().display(),
            fxhash(workspace_root.to_string_lossy().as_bytes())
        );

        Self::new(
            "C# (Roslyn)",
            "dotnet",
            vec![
                "run".to_string(),
                "--project".to_string(),
                "sidecars/Forge.Sidecar.CSharp".to_string(),
                "--".to_string(),
                socket_path.clone(),
            ],
            &socket_path,
        )
    }

    /// Ensure the sidecar is running and connected.
    pub async fn ensure_running(&self) -> Result<()> {
        let transport_guard = self.transport.lock().await;
        if transport_guard.is_some() {
            return Ok(());
        }
        drop(transport_guard);

        self.spawn_and_connect().await
    }

    /// Send a request to the sidecar and wait for the response.
    pub async fn request(
        &self,
        method: &str,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>> {
        self.ensure_running().await?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let envelope = Envelope::request(id, method, payload);

        let mut transport_guard = self.transport.lock().await;
        let transport = transport_guard
            .as_mut()
            .context("sidecar not connected")?;

        transport.write_envelope(&envelope).await?;

        let response = transport
            .read_envelope()
            .await?
            .context("sidecar closed connection")?;

        if let Some(err) = response.error {
            bail!("sidecar error: {err}");
        }

        // Reset backoff on successful communication.
        *self.backoff.lock().await = INITIAL_BACKOFF;

        Ok(response.payload)
    }

    /// Spawn the sidecar process and connect via Unix socket.
    async fn spawn_and_connect(&self) -> Result<()> {
        info!(sidecar = %self.name, "Spawning sidecar");

        // Clean up stale socket.
        let _ = tokio::fs::remove_file(&self.socket_path).await;

        let mut child = Command::new(&self.spawn_command)
            .args(&self.spawn_args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .with_context(|| format!("failed to spawn {} sidecar", self.name))?;

        // Wait for the READY signal on stdout.
        let stdout = child.stdout.take().context("no stdout")?;
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut line = String::new();

        let ready = tokio::time::timeout(READY_TIMEOUT, async {
            loop {
                line.clear();
                let bytes = reader
                    .read_line(&mut line)
                    .await
                    .context("read stdout")?;
                if bytes == 0 {
                    bail!("sidecar exited before READY");
                }
                if let Some(path) = line.trim().strip_prefix("READY:") {
                    info!(
                        sidecar = %self.name,
                        socket = %path,
                        "Sidecar ready"
                    );
                    return Ok(path.to_string());
                }
            }
        })
        .await
        .context("timeout waiting for sidecar READY")?;

        let socket_path = ready?;

        // Connect to the sidecar's Unix socket.
        let stream = UnixStream::connect(&socket_path)
            .await
            .with_context(|| {
                format!("connect to sidecar socket: {socket_path}")
            })?;

        let transport = FramedTransport::new(stream);

        *self.child.lock().await = Some(child);
        *self.transport.lock().await = Some(transport);

        info!(sidecar = %self.name, "Sidecar connected");
        Ok(())
    }

    /// Send a ping and verify the response.
    pub async fn health_check(&self) -> Result<()> {
        let ping_payload = rmp_serde::to_vec("ping")?;
        let result = tokio::time::timeout(
            PING_TIMEOUT,
            self.request("ping", ping_payload),
        )
        .await;

        match result {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(err)) => {
                warn!(sidecar = %self.name, "Health check failed: {err:#}");
                Err(err)
            }
            Err(_) => {
                warn!(sidecar = %self.name, "Health check timed out");
                bail!("health check timed out")
            }
        }
    }

    /// Handle a crash: clean up and prepare for restart with backoff.
    pub async fn handle_crash(&self) {
        error!(sidecar = %self.name, "Sidecar crashed, cleaning up");

        // Clear transport.
        *self.transport.lock().await = None;

        // Kill child if still running.
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }

        // Apply backoff.
        let mut backoff = self.backoff.lock().await;
        let delay = *backoff;
        *backoff = (*backoff * 2).min(MAX_BACKOFF);
        drop(backoff);

        warn!(
            sidecar = %self.name,
            delay_secs = delay.as_secs(),
            "Will restart after backoff"
        );
        tokio::time::sleep(delay).await;
    }

    /// Run the health monitoring loop — pings the sidecar periodically.
    /// On failure, triggers crash recovery with exponential backoff.
    /// Must be called from within a tokio runtime (e.g. via `runtime.spawn`).
    pub async fn start_health_monitor(self: Arc<Self>) -> ! {
        health_loop(self).await
    }

    /// Gracefully shut down the sidecar.
    pub async fn shutdown(&self) {
        info!(sidecar = %self.name, "Shutting down sidecar");

        // Try graceful shutdown via IPC.
        let shutdown_payload = rmp_serde::to_vec("shutdown")
            .unwrap_or_default();
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            self.request("shutdown", shutdown_payload),
        )
        .await;

        // Kill if still running.
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }

        *self.transport.lock().await = None;
    }
}

/// Background health monitoring loop — pings the sidecar periodically.
async fn health_loop(sidecar: Arc<SidecarManager>) -> ! {
    loop {
        tokio::time::sleep(PING_INTERVAL).await;

        // Only check health if we have a connection.
        if sidecar.transport.lock().await.is_none() {
            continue;
        }

        if sidecar.health_check().await.is_err() {
            sidecar.handle_crash().await;
        }
    }
}

/// Simple FNV-style hash for generating short socket names.
fn fxhash(bytes: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in bytes {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}
