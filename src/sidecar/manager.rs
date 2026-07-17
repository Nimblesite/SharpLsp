//! Sidecar lifecycle manager — spawn, health monitoring, crash recovery.

use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

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
/// Response budget for ordinary sidecar requests. Anything slower is wedged,
/// not busy — see [SIDECAR-REQUEST-TIMEOUT].
const REQUEST_TIMEOUT: Duration = Duration::from_mins(2);
/// Response budget for `workspace/open`, which legitimately runs a full
/// `MSBuild` design-time build (minutes on a cold `NuGet` cache).
const WORKSPACE_OPEN_TIMEOUT: Duration = Duration::from_mins(10);
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
    /// Earliest instant a respawn may be attempted after a spawn-time failure.
    /// Spawn failures (e.g. a sidecar that exits before READY) must engage the
    /// same throttle as crashes so a persistent failure cannot trigger an
    /// unthrottled respawn storm — one doomed process per LSP request. (#152)
    spawn_retry_after: Mutex<Option<Instant>>,
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
            spawn_retry_after: Mutex::new(None),
        }
    }

    /// Returns the display name of this sidecar.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Create a manager for the C# sidecar.
    pub fn csharp(workspace_root: &Path) -> Self {
        let socket_path = ipc_path("sharplsp-csharp", workspace_root);

        let (command, args) = sidecar_launch(
            "sharplsp-sidecar-csharp",
            "sidecar-csharp",
            "SharpLsp.Sidecar.CSharp",
            &socket_path,
        );
        Self::new("C# (Roslyn)", &command, args, &socket_path)
    }

    /// Create a manager for the F# sidecar.
    pub fn fsharp(workspace_root: &Path) -> Self {
        let socket_path = ipc_path("sharplsp-fsharp", workspace_root);

        let (command, args) = sidecar_launch(
            "sharplsp-sidecar-fsharp",
            "sidecar-fsharp",
            "SharpLsp.Sidecar.FSharp",
            &socket_path,
        );
        Self::new("F# (FCS)", &command, args, &socket_path)
    }

    /// Ensure the sidecar is running and connected.
    ///
    /// Holds the transport lock during the entire spawn to prevent
    /// concurrent callers from spawning duplicate sidecar processes.
    pub async fn ensure_running(&self) -> Result<()> {
        let mut transport_guard = self.transport.lock().await;
        if transport_guard.is_some() {
            return Ok(());
        }

        self.enforce_spawn_backoff().await?;

        match self.spawn_process().await {
            Ok((child, transport)) => {
                *self.child.lock().await = Some(child);
                *transport_guard = Some(transport);
                *self.backoff.lock().await = INITIAL_BACKOFF;
                *self.spawn_retry_after.lock().await = None;
                info!(sidecar = %self.name, "Sidecar connected");
                Ok(())
            }
            Err(err) => {
                self.record_spawn_failure().await;
                Err(err)
            }
        }
    }

    /// Refuse a respawn while a prior spawn failure's backoff window is open.
    /// Without this, `request` would relaunch a doomed sidecar with zero delay
    /// on every semantic LSP request (#152).
    async fn enforce_spawn_backoff(&self) -> Result<()> {
        if let Some(until) = *self.spawn_retry_after.lock().await {
            let now = Instant::now();
            if now < until {
                let remaining = (until - now).as_millis();
                bail!("sidecar spawn in backoff; {remaining}ms until retry");
            }
        }
        Ok(())
    }

    /// Record a spawn-time failure: grow the shared backoff (as crashes do) and
    /// arm the retry gate so the next respawn waits out the delay (#152).
    async fn record_spawn_failure(&self) {
        let mut backoff = self.backoff.lock().await;
        let delay = *backoff;
        *backoff = (*backoff * 2).min(MAX_BACKOFF);
        drop(backoff);
        *self.spawn_retry_after.lock().await = Some(Instant::now() + delay);
        warn!(
            sidecar = %self.name,
            delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
            "Sidecar spawn failed; backing off before respawn"
        );
    }

    /// Send a request to the sidecar and wait for the response.
    ///
    /// Bounded by a per-method budget: without one, a wedged sidecar handler
    /// blocks the LSP main loop forever — the health monitor deliberately
    /// skips pinging while a request holds the transport, so recovery would
    /// never fire. Implements [SIDECAR-REQUEST-TIMEOUT].
    pub async fn request(&self, method: &str, payload: Vec<u8>) -> Result<Vec<u8>> {
        self.request_with_budget(method, payload, request_budget(method))
            .await
    }

    /// [`SidecarManager::request`] with an explicit response budget — health
    /// pings use a much shorter one than semantic requests.
    async fn request_with_budget(
        &self,
        method: &str,
        payload: Vec<u8>,
        budget: Duration,
    ) -> Result<Vec<u8>> {
        self.ensure_running().await?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        info!(sidecar = %self.name, method = %method, id = id, "Sidecar request");
        let envelope = Envelope::request(id, method, payload);

        let mut transport_guard = self.transport.lock().await;
        let transport = transport_guard.as_mut().context("sidecar not connected")?;

        let exchange = async {
            transport.write_envelope(&envelope).await?;
            transport
                .read_envelope()
                .await?
                .context("sidecar closed connection")
        };
        let Ok(exchange_result) = tokio::time::timeout(budget, exchange).await else {
            return self
                .fail_timed_out_request(&mut transport_guard, method, id, budget)
                .await;
        };
        let response = exchange_result?;

        if let Some(err) = response.error {
            error!(sidecar = %self.name, method = %method, id = id, "Sidecar error: {err}");
            bail!("sidecar error: {err}");
        }

        info!(
            sidecar = %self.name,
            method = %method,
            id = id,
            bytes = response.payload.len(),
            "Sidecar response"
        );

        // Reset backoff on successful communication.
        *self.backoff.lock().await = INITIAL_BACKOFF;

        Ok(response.payload)
    }

    /// Tear down the connection after a request timeout. The late response
    /// would otherwise be handed to the next caller and desync the framed
    /// protocol, so the transport is dropped and the process killed — the
    /// next request respawns a clean sidecar. [SIDECAR-REQUEST-TIMEOUT]
    async fn fail_timed_out_request(
        &self,
        transport: &mut Option<FramedTransport>,
        method: &str,
        id: u32,
        budget: Duration,
    ) -> Result<Vec<u8>> {
        *transport = None;
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        error!(
            sidecar = %self.name,
            method = %method,
            id = id,
            timeout_secs = budget.as_secs(),
            "Sidecar request timed out; dropping connection for respawn"
        );
        bail!(
            "{} sidecar request {method} timed out after {}s",
            self.name,
            budget.as_secs()
        )
    }

    /// Spawn the sidecar process and connect via Unix socket.
    /// Returns the child process and transport for the caller to store.
    async fn spawn_process(&self) -> Result<(Child, FramedTransport)> {
        info!(sidecar = %self.name, "Spawning sidecar");

        // Clean up stale socket (Unix only).
        #[cfg(unix)]
        let _ = tokio::fs::remove_file(&self.socket_path).await;

        info!(
            sidecar = %self.name,
            command = %self.spawn_command,
            args = ?self.spawn_args,
            socket = %self.socket_path,
            "Spawning sidecar process"
        );
        let mut command = Command::new(&self.spawn_command);
        let _ = command
            .args(&self.spawn_args)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit());
        crate::utils::hide_console_window_tokio(&mut command);
        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to spawn {} sidecar: command={:?} args={:?}",
                self.name, self.spawn_command, self.spawn_args
            )
        })?;

        let socket_path = self.wait_for_ready(&mut child).await?;

        let transport = connect_transport(&socket_path).await?;
        Ok((child, transport))
    }

    /// Wait for the READY signal on the sidecar's stdout.
    async fn wait_for_ready(&self, child: &mut Child) -> Result<String> {
        let stdout = child.stdout.take().context("no stdout")?;
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut line = String::new();

        let ready = tokio::time::timeout(READY_TIMEOUT, async {
            loop {
                line.clear();
                let bytes = reader.read_line(&mut line).await.context("read stdout")?;
                if bytes == 0 {
                    // #150: a bare "exited before READY" is undiagnosable (it is
                    // exactly what made #110 take multiple log uploads). Reap the
                    // child for its exit status and point at the sidecar log dir,
                    // whose FATAL line the host inherits via the child's stderr.
                    let status = match child.wait().await {
                        Ok(status) => status.to_string(),
                        Err(err) => format!("unknown exit status: {err}"),
                    };
                    let log_dir = std::env::temp_dir().join("sharplsp-logs");
                    bail!(
                        "sidecar exited before READY ({status}); sidecar logs: {}",
                        log_dir.display()
                    );
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

        ready
    }

    /// Send a ping and verify the response.
    ///
    /// Routed through [`SidecarManager::request_with_budget`] so a timed-out
    /// ping poisons the transport instead of abandoning a pending response
    /// mid-stream — an outer timeout that merely drops the read future leaves
    /// a stale frame for the next caller. [SIDECAR-REQUEST-TIMEOUT]
    pub async fn health_check(&self) -> Result<()> {
        let ping_payload = rmp_serde::to_vec("ping")?;
        match self
            .request_with_budget("ping", ping_payload, PING_TIMEOUT)
            .await
        {
            Ok(_) => Ok(()),
            Err(err) => {
                warn!(sidecar = %self.name, "Health check failed: {err:#}");
                Err(err)
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
        if let Ok(mut transport_guard) = self.transport.try_lock() {
            if let Some(transport) = transport_guard.as_mut() {
                let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                let payload = rmp_serde::to_vec("shutdown").unwrap_or_default();
                let envelope = Envelope::request(id, "shutdown", payload);
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    transport.write_envelope(&envelope).await?;
                    transport.read_envelope().await
                })
                .await;
            }
            *transport_guard = None;
        }

        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
    }
}

#[cfg(test)]
impl SidecarManager {
    /// Test-only: a manager pre-wired to an in-memory stream, so pipeline
    /// tests (e.g. the diagnostics push pipeline) can script sidecar
    /// responses without spawning a real process.
    pub(crate) async fn connected_to_stream_for_tests(stream: tokio::io::DuplexStream) -> Self {
        let manager = Self::new("test", "unused-command", vec![], "unused-endpoint");
        *manager.transport.lock().await = Some(FramedTransport::from_stream(stream));
        manager
    }
}

/// Response budget for a sidecar method. `workspace/open` legitimately runs a
/// full `MSBuild` design-time build; anything else past two minutes is wedged.
/// [SIDECAR-REQUEST-TIMEOUT]
fn request_budget(method: &str) -> Duration {
    if method == "workspace/open" {
        WORKSPACE_OPEN_TIMEOUT
    } else {
        REQUEST_TIMEOUT
    }
}

/// Background health monitoring loop — pings the sidecar periodically.
///
/// Skips health checks when the transport lock is held by an in-flight
/// request. A busy lock proves the sidecar is alive (we are actively
/// communicating with it). Waiting for the lock would cause false
/// timeouts that kill the sidecar during slow operations like
/// workspace/open.
async fn health_loop(sidecar: Arc<SidecarManager>) -> ! {
    loop {
        tokio::time::sleep(PING_INTERVAL).await;

        // If the transport lock is held, a request is in-flight — skip.
        let Ok(guard) = sidecar.transport.try_lock() else {
            continue;
        };

        // No connection yet — nothing to check.
        if guard.is_none() {
            drop(guard);
            continue;
        }
        drop(guard);

        if sidecar.health_check().await.is_err() {
            sidecar.handle_crash().await;
        }
    }
}

/// Resolve sidecar launch command and arguments.
///
/// Resolution order:
///   1. `dotnet tool` shim on `PATH` (e.g. `sharplsp-sidecar-csharp`).
///      This is the production distribution path.
///   2. Legacy installed layouts (VSIX bundle, `make install`, dev target).
///      Kept as a transitional fallback while the distribution spec
///      migrates away from bundled sidecars; see
///      `docs/specs/BINARY-DEPLOYMENT.md`.
///   3. Dev build via `dotnet run --project sidecars/<name>`
///      (CWD = repo root).
fn sidecar_launch(
    tool_command: &str,
    subdir: &str,
    name: &str,
    socket_path: &str,
) -> (String, Vec<String>) {
    debug!(
        tool_command,
        subdir, name, socket_path, "Resolving sidecar launch command"
    );

    // [SIDECAR-RESOLVE-ENV]: env var override takes absolute priority.
    if let Some(exe) = env_var_sidecar_override(subdir) {
        info!(exe = %exe.display(), source = "env-var", "Sidecar resolved");
        return (
            exe.to_string_lossy().to_string(),
            vec![socket_path.to_string()],
        );
    }

    if let Some(found) = find_on_path(tool_command) {
        info!(tool = %tool_command, path = %found.display(), source = "PATH", "Sidecar resolved");
        return (tool_command.to_string(), vec![socket_path.to_string()]);
    }
    debug!(tool_command, "Tool not found on PATH");

    if let Some(exe) = installed_sidecar_exe(subdir, name) {
        info!(exe = %exe.display(), source = "installed", "Sidecar resolved");
        return (
            exe.to_string_lossy().to_string(),
            vec![socket_path.to_string()],
        );
    }

    info!(sidecar = %name, source = "dotnet-run", "Sidecar resolved — using dev dotnet run");
    (
        "dotnet".to_string(),
        vec![
            "run".to_string(),
            "--project".to_string(),
            format!("sidecars/{name}"),
            "--".to_string(),
            socket_path.to_string(),
        ],
    )
}

/// Return the sidecar path from an env var override, if set.
///
/// Converts `sidecar-csharp` → `SHARPLSP_CSHARP_SIDECAR_PATH`,
/// `sidecar-fsharp` → `SHARPLSP_FSHARP_SIDECAR_PATH`, etc.
fn env_var_sidecar_override(subdir: &str) -> Option<std::path::PathBuf> {
    let kind = subdir.strip_prefix("sidecar-")?;
    let env_key = format!("SHARPLSP_{}_SIDECAR_PATH", kind.to_ascii_uppercase());
    match std::env::var(&env_key) {
        Err(_) => {
            debug!(env_key = %env_key, "Env var not set — skipping env-var override");
            None
        }
        Ok(val) => {
            let path = std::path::PathBuf::from(&val);
            if path.exists() {
                debug!(env_key = %env_key, path = %val, "Env var sidecar override resolved");
                Some(path)
            } else {
                warn!(env_key = %env_key, path = %val, "Env var sidecar override set but path does not exist — skipping");
                None
            }
        }
    }
}

/// Resolve a command name to its full path via the `PATH` environment
/// variable. Returns `None` if the command is not found or is not
/// executable. On Windows, also tries `.exe` and `.cmd` suffixes.
fn find_on_path(command: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let suffixes: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    for dir in std::env::split_paths(&path_var) {
        for suffix in suffixes {
            let candidate = dir.join(format!("{command}{suffix}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Check for a published sidecar executable.
///
/// Searches three layouts in priority order:
///   1. VSIX bundle:    `<exe_dir>/<subdir>/<name>[.exe]`
///   2. `make install`: `<exe_dir>/../lib/sharplsp/<subdir>/<name>[.exe]`
///   3. Dev build:      `<exe_dir>/../<subdir>/<name>[.exe]`
///      (e.g. `target/sidecar-csharp/` next to `target/release/sharplsp`,
///      where `make build-dotnet` writes the published sidecar output)
fn installed_sidecar_exe(subdir: &str, name: &str) -> Option<std::path::PathBuf> {
    let current = std::env::current_exe().ok()?;
    let exe_dir = current.parent()?;
    debug!(current_exe = %current.display(), exe_dir = %exe_dir.display(), "Resolving installed sidecar");

    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    // 1. VSIX layout: sidecar sits next to the binary.
    let vsix = exe_dir.join(subdir).join(&exe_name);
    debug!(candidate = %vsix.display(), "Checking VSIX layout");
    if vsix.exists() {
        debug!(path = %vsix.display(), "Found sidecar at VSIX layout");
        return Some(vsix);
    }

    // 2. make install layout: ../lib/sharplsp/<subdir>/
    let installed = exe_dir
        .parent()?
        .join("lib/sharplsp")
        .join(subdir)
        .join(&exe_name);
    debug!(candidate = %installed.display(), "Checking make-install layout");
    if installed.exists() {
        debug!(path = %installed.display(), "Found sidecar at make-install layout");
        return Some(installed);
    }

    // 3. Dev-build layout: sibling of target/release or target/debug.
    let dev = exe_dir.parent()?.join(subdir).join(&exe_name);
    debug!(candidate = %dev.display(), "Checking dev-build layout");
    if dev.exists() {
        debug!(path = %dev.display(), "Found sidecar at dev-build layout");
        Some(dev)
    } else {
        warn!(
            vsix = %vsix.display(),
            installed = %installed.display(),
            dev = %dev.display(),
            "No installed sidecar found at any layout — falling back to dotnet run"
        );
        None
    }
}

/// Monotonic counter making each sidecar endpoint unique within this process.
static IPC_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A short endpoint token that is unique per spawn.
///
/// #151: deriving the endpoint from the workspace root alone makes two hosts on
/// the same folder (e.g. two editor windows) compute an identical endpoint — on
/// Windows the second sidecar finds the single-instance pipe name taken and dies
/// before READY; on Unix it deletes and steals the live socket. Folding the
/// process id and a monotonic counter into the hash keeps the token short
/// (constant length, so it never trips the Unix socket-path limit) while making
/// it unique across hosts (pid) and within a host (counter). It is computed once
/// per manager and reused across restarts, so a restart keeps its own endpoint.
fn unique_endpoint_token(workspace_root: &Path) -> String {
    let sequence = IPC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let key = format!(
        "{}|{}|{}",
        workspace_root.to_string_lossy(),
        std::process::id(),
        sequence
    );
    format!("{:x}", fxhash(key.as_bytes()))
}

/// Build a platform-appropriate IPC path for a sidecar.
#[cfg(unix)]
fn ipc_path(name: &str, workspace_root: &Path) -> String {
    format!(
        "{}/{}-{}.sock",
        std::env::temp_dir().display(),
        name,
        unique_endpoint_token(workspace_root)
    )
}

/// Build a platform-appropriate IPC path for a sidecar.
#[cfg(windows)]
fn ipc_path(name: &str, workspace_root: &Path) -> String {
    format!(
        r"\\.\pipe\{}-{}",
        name,
        unique_endpoint_token(workspace_root)
    )
}

/// Connect to the sidecar IPC endpoint and return a `FramedTransport`.
#[cfg(unix)]
async fn connect_transport(path: &str) -> Result<FramedTransport> {
    let stream = tokio::net::UnixStream::connect(path)
        .await
        .with_context(|| format!("connect to sidecar socket: {path}"))?;
    Ok(FramedTransport::new(stream))
}

/// Connect to the sidecar IPC endpoint and return a `FramedTransport`.
#[cfg(windows)]
#[expect(
    clippy::unused_async,
    reason = "API parity with the unix variant which awaits the connect"
)]
async fn connect_transport(path: &str) -> Result<FramedTransport> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let pipe = ClientOptions::new()
        .open(path)
        .with_context(|| format!("connect to sidecar named pipe: {path}"))?;
    Ok(FramedTransport::new(pipe))
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

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;
    use anyhow::Result;
    use std::path::PathBuf;

    /// On Unix, `ipc_path` must produce a `.sock` path containing the sidecar name.
    #[cfg(unix)]
    #[test]
    fn ipc_path_unix_ends_with_sock_and_contains_name() {
        let path = ipc_path("sharplsp-csharp", &PathBuf::from("/some/workspace"));
        assert!(
            std::path::Path::new(&path)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("sock")),
            "expected path ending in '.sock', got: {path}"
        );
        assert!(
            path.contains("sharplsp-csharp"),
            "expected path to contain 'sharplsp-csharp', got: {path}"
        );
    }

    /// On Windows, `ipc_path` must produce a named-pipe path starting with `\\.\pipe\`.
    #[cfg(windows)]
    #[test]
    fn ipc_path_windows_starts_with_pipe_prefix_and_contains_name() {
        let path = ipc_path("sharplsp-fsharp", &PathBuf::from(r"C:\workspace"));
        assert!(
            path.starts_with(r"\\.\pipe\"),
            r"expected path starting with '\\.\pipe\', got: {path}"
        );
        assert!(
            path.contains("sharplsp-fsharp"),
            "expected path to contain 'sharplsp-fsharp', got: {path}"
        );
    }

    #[test]
    fn fxhash_is_deterministic() {
        let input = b"hello world";
        assert_eq!(fxhash(input), fxhash(input));
    }

    #[test]
    fn fxhash_different_inputs_produce_different_outputs() {
        assert_ne!(fxhash(b"hello"), fxhash(b"world"));
        assert_ne!(fxhash(b""), fxhash(b"a"));
        assert_ne!(fxhash(b"abc"), fxhash(b"abd"));
    }

    #[test]
    fn fxhash_empty_input() {
        // Should not panic and should return the initial seed after zero iterations.
        let result = fxhash(b"");
        assert_eq!(result, 0x811c_9dc5);
    }

    #[test]
    fn new_stores_name() {
        let mgr = SidecarManager::new("test-sidecar", "echo", vec![], "/tmp/test.sock");
        assert_eq!(mgr.name(), "test-sidecar");
    }

    #[test]
    fn new_stores_socket_path() {
        let mgr = SidecarManager::new("test", "echo", vec![], "/tmp/my.sock");
        assert_eq!(mgr.socket_path, "/tmp/my.sock");
    }

    #[test]
    fn name_returns_display_name() {
        let mgr = SidecarManager::new("My Sidecar", "cmd", vec![], "/tmp/s.sock");
        assert_eq!(mgr.name(), "My Sidecar");
    }

    #[test]
    fn csharp_has_correct_name() {
        let mgr = SidecarManager::csharp(&PathBuf::from("/workspace"));
        assert_eq!(mgr.name(), "C# (Roslyn)");
    }

    #[test]
    fn csharp_socket_path_contains_sharplsp_csharp() {
        let mgr = SidecarManager::csharp(&PathBuf::from("/workspace"));
        assert!(
            mgr.socket_path.contains("sharplsp-csharp"),
            "expected socket_path to contain 'sharplsp-csharp', got: {}",
            mgr.socket_path
        );
    }

    #[test]
    fn fsharp_has_correct_name() {
        let mgr = SidecarManager::fsharp(&PathBuf::from("/workspace"));
        assert_eq!(mgr.name(), "F# (FCS)");
    }

    #[test]
    fn fsharp_socket_path_contains_sharplsp_fsharp() {
        let mgr = SidecarManager::fsharp(&PathBuf::from("/workspace"));
        assert!(
            mgr.socket_path.contains("sharplsp-fsharp"),
            "expected socket_path to contain 'sharplsp-fsharp', got: {}",
            mgr.socket_path
        );
    }

    #[test]
    fn find_on_path_finds_dotnet() -> Result<()> {
        let path = find_on_path("dotnet").context("dotnet must be available for sidecar tests")?;
        assert!(path.is_file());
        Ok(())
    }

    #[test]
    fn find_on_path_returns_none_for_missing_command() {
        let command = format!("sharplsp-missing-command-{}", std::process::id());
        assert!(find_on_path(&command).is_none());
    }

    #[test]
    fn sidecar_launch_prefers_path_tool() {
        let (command, args) = sidecar_launch(
            "dotnet",
            "unused-sidecar-dir",
            "Unused.Sidecar",
            "/tmp/sharplsp-test.sock",
        );
        assert_eq!(command, "dotnet");
        assert_eq!(args, vec!["/tmp/sharplsp-test.sock"]);
    }

    #[test]
    fn sidecar_launch_falls_back_to_dotnet_run() {
        let name = format!("SharpLsp.Missing.Sidecar.{}", std::process::id());
        let command_name = format!("sharplsp-missing-sidecar-{}", std::process::id());
        let subdir = format!("missing-sidecar-dir-{}", std::process::id());

        let (command, args) =
            sidecar_launch(&command_name, &subdir, &name, "/tmp/sharplsp-test.sock");

        assert_eq!(command, "dotnet");
        assert_eq!(
            args,
            vec![
                "run".to_string(),
                "--project".to_string(),
                format!("sidecars/{name}"),
                "--".to_string(),
                "/tmp/sharplsp-test.sock".to_string(),
            ]
        );
    }

    #[test]
    fn sidecar_launch_uses_legacy_installed_sidecar() -> Result<()> {
        let subdir = format!("sidecar-test-{}", std::process::id());
        let name = format!("SharpLsp.Sidecar.Test{}", std::process::id());
        let exe = create_vsix_sidecar(&subdir, &name)?;

        let (command, args) = sidecar_launch(
            "sharplsp-missing-installed-sidecar",
            &subdir,
            &name,
            "/tmp/sharplsp-test.sock",
        );

        assert_eq!(PathBuf::from(command), exe);
        assert_eq!(args, vec!["/tmp/sharplsp-test.sock"]);

        remove_vsix_sidecar(&subdir, &name)?;
        Ok(())
    }

    #[test]
    fn installed_sidecar_exe_returns_none_for_missing_sidecar() {
        let subdir = format!("sidecar-missing-{}", std::process::id());
        let name = format!("SharpLsp.Sidecar.Missing{}", std::process::id());
        assert!(installed_sidecar_exe(&subdir, &name).is_none());
    }

    fn create_vsix_sidecar(subdir: &str, name: &str) -> Result<PathBuf> {
        let exe_dir = std::env::current_exe()
            .context("current test executable")?
            .parent()
            .context("test executable directory")?
            .to_path_buf();
        let exe = exe_dir.join(subdir).join(sidecar_exe_name(name));
        let parent = exe.parent().context("sidecar executable parent")?;
        std::fs::create_dir_all(parent).context("create sidecar test directory")?;
        std::fs::write(&exe, b"").context("write sidecar test executable")?;
        Ok(exe)
    }

    fn remove_vsix_sidecar(subdir: &str, name: &str) -> Result<()> {
        let exe_dir = std::env::current_exe()
            .context("current test executable")?
            .parent()
            .context("test executable directory")?
            .to_path_buf();
        let dir = exe_dir.join(subdir);
        let exe = dir.join(sidecar_exe_name(name));
        if exe.exists() {
            std::fs::remove_file(exe).context("remove sidecar test executable")?;
        }
        if dir.exists() {
            std::fs::remove_dir(dir).context("remove sidecar test directory")?;
        }
        Ok(())
    }

    fn sidecar_exe_name(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    }

    #[test]
    fn sidecar_launch_uses_env_var_override() {
        use std::fs;

        let dir = std::env::temp_dir().join(format!("sharplsp-env-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("SharpLsp.Sidecar.CSharp");
        fs::write(&exe, b"").unwrap();

        // Implements [SIDECAR-RESOLVE-ENV]: SHARPLSP_CSHARP_SIDECAR_PATH overrides all other resolution.
        std::env::set_var("SHARPLSP_CSHARP_SIDECAR_PATH", exe.to_str().unwrap());

        let (command, args) = sidecar_launch(
            "sharplsp-missing-tool",
            "sidecar-csharp",
            "SharpLsp.Sidecar.CSharp",
            "/tmp/sharplsp-test-env.sock",
        );

        std::env::remove_var("SHARPLSP_CSHARP_SIDECAR_PATH");
        let _ = fs::remove_file(&exe);

        assert_eq!(
            PathBuf::from(&command),
            exe,
            "sidecar_launch must use SHARPLSP_CSHARP_SIDECAR_PATH when set"
        );
        assert_eq!(args, vec!["/tmp/sharplsp-test-env.sock"]);
    }

    /// A wedged sidecar (accepts the request, never answers) must fail the
    /// request within its budget and poison the transport so the next request
    /// respawns a clean process — not hang the LSP main loop forever.
    /// Implements [SIDECAR-REQUEST-TIMEOUT].
    #[tokio::test]
    async fn request_times_out_and_poisons_the_transport() {
        let manager = SidecarManager::new("test", "unused-command", vec![], "unused-endpoint");
        // In-memory pipe standing in for a sidecar that never responds. Keep
        // the far end alive — dropping it would EOF the stream and take the
        // "closed connection" path instead of the timeout path.
        let (host_side, _wedged_sidecar_side) = tokio::io::duplex(1024);
        *manager.transport.lock().await = Some(FramedTransport::from_stream(host_side));

        let result = manager
            .request_with_budget("ping", Vec::new(), Duration::from_millis(100))
            .await;

        assert!(result.is_err(), "wedged sidecar must not hang the request");
        assert!(
            manager.transport.lock().await.is_none(),
            "timed-out transport must be dropped so the next request respawns"
        );
    }

    /// GitHub #151: two hosts (e.g. two editor windows) on the same workspace
    /// must not compute the same IPC endpoint — on Windows the second sidecar
    /// finds the single-instance pipe name taken and dies before READY; on
    /// Unix it silently deletes and steals the live socket.
    #[test]
    fn same_workspace_managers_get_distinct_ipc_endpoints() {
        let first = SidecarManager::csharp(&PathBuf::from("/workspace"));
        let second = SidecarManager::csharp(&PathBuf::from("/workspace"));
        assert_ne!(
            first.socket_path, second.socket_path,
            "managers for the same workspace must get unique IPC endpoints (GitHub #151)"
        );
    }

    /// GitHub #152: a spawn-time failure must engage the same backoff that
    /// crash recovery uses — otherwise every semantic LSP request launches a
    /// fresh doomed process with zero delay.
    #[tokio::test]
    async fn spawn_failure_suppresses_immediate_respawn_with_backoff() {
        let missing = format!("sharplsp-missing-cmd-{}", std::process::id());
        let manager = SidecarManager::new("test", &missing, vec![], "/tmp/sharplsp-backoff.sock");

        let first = manager.ensure_running().await.unwrap_err();
        assert!(
            !format!("{first:#}").contains("backoff"),
            "first attempt must surface the real spawn failure, got: {first:#}"
        );

        let second = manager.ensure_running().await.unwrap_err();
        assert!(
            format!("{second:#}").contains("backoff"),
            "an immediate respawn after a spawn failure must be suppressed \
             by backoff (GitHub #152), got: {second:#}"
        );
    }

    /// GitHub #150: when the sidecar dies before READY, the error must carry
    /// the child's exit status and point at the sidecar log directory instead
    /// of the bare "exited before READY" that made #110 undiagnosable.
    #[cfg(unix)]
    #[tokio::test]
    async fn pre_ready_exit_reports_exit_status_and_log_hint() {
        let manager = SidecarManager::new("test", "false", vec![], "/tmp/sharplsp-eof.sock");
        let err = manager.ensure_running().await.unwrap_err();
        let message = format!("{err:#}");
        assert!(
            message.contains("exit status"),
            "error must report the child's exit status (GitHub #150), got: {message}"
        );
        assert!(
            message.contains("sharplsp-logs"),
            "error must point at the sidecar log directory (GitHub #150), got: {message}"
        );
    }
}
