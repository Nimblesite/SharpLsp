//! Sidecar lifecycle manager — spawn, health monitoring, crash recovery.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use super::protocol::Envelope;
use super::transport::FramedTransport;

mod exchange;
mod preemption;
mod recovery;
mod shutdown;

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod arrival_order_tests;

#[cfg(test)]
mod preemption_tests;

/// Maximum backoff delay for crash recovery. `[SIDECAR-RECOVERY-BACKOFF]`
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Initial backoff delay.
const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
/// Health ping interval. `[SIDECAR-HEALTH-ACTIVITY]`
const PING_INTERVAL: Duration = Duration::from_secs(5);
/// Ping response timeout.
const PING_TIMEOUT: Duration = Duration::from_secs(2);
/// How long to wait for the sidecar READY signal. `[SIDECAR-STARTUP-HANDSHAKE]`
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Response budget for ordinary sidecar requests. Anything slower is wedged,
/// not busy — see `[SIDECAR-IPC-TIMEOUT]`.
const REQUEST_TIMEOUT: Duration = Duration::from_mins(2);
/// Response budget for `workspace/open`, which legitimately runs a full
/// `MSBuild` design-time build (minutes on a cold `NuGet` cache).
const WORKSPACE_OPEN_TIMEOUT: Duration = Duration::from_mins(10);
/// Legacy facade pending `[SIDECAR-ARCHITECTURE-OWNERSHIP]`.
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
    /// The workspace this sidecar last opened. Every `workspace/open` holds it,
    /// so a watched-file reload and a solution switch cannot interleave their
    /// opens and a reload reopens the last one ([DIAG-LSP-REFRESH], #494).
    workspace: Mutex<crate::workspace_open::OpenedWorkspace>,
    /// Monotonic request ID.
    // TODO [SIDECAR-IPC-CORRELATION]: validate every response ID before accepting it.
    next_id: AtomicU32,
    /// Current backoff duration for crash recovery.
    backoff: Mutex<Duration>,
    /// Earliest instant a respawn may be attempted after a spawn-time failure.
    /// Spawn failures (e.g. a sidecar that exits before READY) must engage the
    /// same throttle as crashes so a persistent failure cannot trigger an
    /// unthrottled respawn storm — one doomed process per LSP request. (#152)
    spawn_retry_after: Mutex<Option<Instant>>,
    /// Set before shutdown begins so background callers stop retrying or respawning.
    shutting_down: AtomicBool,
    /// Set once the health monitor runs, so each manager runs one.
    monitored: AtomicBool,
    /// A new process must receive its previous compiler inputs before serving requests.
    ever_connected: AtomicBool,
    /// Compiler-specific session metadata, with weak access to canonical VFS inputs.
    session: recovery::SessionInputs,
    /// Code lenses an interactive request may preempt ([SHARPLSP-FEATURES-CODE-LENS], #504).
    preemption: preemption::Preemption,
    /// Source ownership for replaying open documents to the correct compiler.
    language: Option<crate::tree_sitter_parse::LangId>,
    /// Out-of-band event lines the sidecar writes to its stdout after the
    /// READY handshake (`SHARPLSP-EVENT <name> <payload>`). Forwarded by a
    /// per-child reader task so the pipe never fills; survives respawns
    /// because every new child is wired to the same sender.
    /// [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
    events_tx: tokio::sync::mpsc::UnboundedSender<String>,
    /// The receiving half of `events_tx`, handed out once via
    /// [`SidecarManager::take_event_receiver`].
    events_rx: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<String>>>,
    /// Typed IPC notifications, independent of request/response traffic.
    notifications_tx: tokio::sync::mpsc::UnboundedSender<Envelope>,
    /// Single consumer for compiler-workspace invalidations.
    notifications_rx: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Envelope>>>,
}

impl SidecarManager {
    /// Create a new sidecar manager.
    pub fn new(
        name: &str,
        spawn_command: &str,
        spawn_args: Vec<String>,
        socket_path: &str,
    ) -> Self {
        let (events_tx, events_rx) = tokio::sync::mpsc::unbounded_channel();
        let (notifications_tx, notifications_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            name: name.to_string(),
            spawn_command: spawn_command.to_string(),
            spawn_args,
            socket_path: socket_path.to_string(),
            child: Mutex::new(None),
            transport: Mutex::new(None),
            workspace: Mutex::default(),
            next_id: AtomicU32::new(1),
            backoff: Mutex::new(INITIAL_BACKOFF),
            spawn_retry_after: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            monitored: AtomicBool::new(false),
            ever_connected: AtomicBool::new(false),
            session: recovery::SessionInputs::default(),
            preemption: preemption::Preemption::default(),
            language: None,
            events_tx,
            events_rx: std::sync::Mutex::new(Some(events_rx)),
            notifications_tx,
            notifications_rx: std::sync::Mutex::new(Some(notifications_rx)),
        }
    }

    /// Returns the display name of this sidecar.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Hand out the single receiver for this sidecar's out-of-band stdout
    /// events (`SHARPLSP-EVENT` lines). Returns `None` after the first call.
    pub fn take_event_receiver(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<String>> {
        self.events_rx.lock().ok().and_then(|mut slot| slot.take())
    }

    /// Receive sidecar-originated notifications even with no request in flight.
    pub fn take_notification_receiver(
        &self,
    ) -> Option<tokio::sync::mpsc::UnboundedReceiver<Envelope>> {
        self.notifications_rx
            .lock()
            .ok()
            .and_then(|mut receiver| receiver.take())
    }

    /// Whether graceful shutdown has begun for this manager.
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    /// The workspace this sidecar last opened, held across a whole
    /// `workspace/open` so a reload and a switch can never interleave
    /// ([DIAG-LSP-REFRESH], #494).
    pub(crate) async fn lock_workspace(
        &self,
    ) -> tokio::sync::MutexGuard<'_, crate::workspace_open::OpenedWorkspace> {
        self.workspace.lock().await
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
        Self {
            language: Some(crate::tree_sitter_parse::LangId::CSharp),
            ..Self::new("C# (Roslyn)", &command, args, &socket_path)
        }
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
        Self {
            language: Some(crate::tree_sitter_parse::LangId::FSharp),
            ..Self::new("F# (FCS)", &command, args, &socket_path)
        }
    }

    /// Spawn and connect unless `connection` already holds a transport. The
    /// caller holds the transport lock during the entire spawn, so no
    /// concurrent caller can spawn a duplicate process.
    async fn connect_if_needed(&self, connection: &mut Option<FramedTransport>) -> Result<()> {
        if connection.is_some() {
            return Ok(());
        }

        self.enforce_spawn_backoff().await?;

        match self.spawn_process().await {
            Ok((child, mut transport)) => {
                if let Some(mut notifications) = transport.take_notifications() {
                    let sender = self.notifications_tx.clone();
                    drop(tokio::spawn(async move {
                        while let Some(notification) = notifications.recv().await {
                            if sender.send(notification).is_err() {
                                return;
                            }
                        }
                    }));
                }
                *self.child.lock().await = Some(child);
                *connection = Some(transport);
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

    /// Double the shared backoff, capped at `MAX_BACKOFF`, and return the delay
    /// it held before: the one this failure must wait out.
    async fn grow_backoff(&self) -> Duration {
        let mut backoff = self.backoff.lock().await;
        let delay = *backoff;
        *backoff = (*backoff * 2).min(MAX_BACKOFF);
        delay
    }

    /// Record a spawn-time failure: grow the shared backoff (as crashes do) and
    /// arm the retry gate so the next respawn waits out the delay (#152).
    async fn record_spawn_failure(&self) {
        let delay = self.grow_backoff().await;
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
    /// never fire. See `[SIDECAR-IPC-TIMEOUT]`.
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
        self.request_budgeted(method, payload, budget, None).await
    }

    /// Propagate the real diagnostic request lifetime through serialized compiler IPC.
    pub async fn request_cancellable(
        &self,
        method: &str,
        payload: Vec<u8>,
        cancel: Option<&lspkit_server::CancellationToken>,
    ) -> Result<Vec<u8>> {
        self.request_budgeted(method, payload, request_budget(method), cancel)
            .await
    }

    /// Acquire the serialized compiler session with a cancellable wait and bounded exchange.
    /// One FIFO acquisition covers connecting, numbering and exchange, preventing overtaking.
    /// Implements [SIDECAR-IPC-DRIVER].
    async fn request_budgeted(
        &self,
        method: &str,
        payload: Vec<u8>,
        budget: Duration,
        cancel: Option<&lspkit_server::CancellationToken>,
    ) -> Result<Vec<u8>> {
        if self.is_shutting_down() {
            bail!("{} sidecar is shutting down", self.name);
        }
        // An interactive request cancels the code lenses ahead of it before it
        // waits its turn; a lens waits as a preemptible one. [SHARPLSP-FEATURES-CODE-LENS]
        self.preemption.preempt_for(method);
        let background = self.preemption.begin(method, cancel);
        let cancel = background.as_ref().map(|work| &work.token).or(cancel);
        let mut transport_guard =
            lspkit_sidecar::cancellation::until_cancelled(self.transport.lock(), cancel).await?;
        self.session.remember(method, &payload)?;
        let fresh = transport_guard.is_none();
        self.connect_if_needed(&mut transport_guard).await?;
        self.request_connected(&mut transport_guard, method, payload, budget, fresh, cancel)
            .await
    }

    /// Tear down the connection after a request timeout. The late response
    /// would otherwise be handed to the next caller and desync the framed
    /// protocol, so the transport is dropped and the process killed — the
    /// next request respawns a clean sidecar. `[SIDECAR-IPC-TIMEOUT]`
    async fn fail_timed_out_request<T>(
        &self,
        transport: &mut Option<FramedTransport>,
        method: &str,
        id: u32,
        budget: Duration,
    ) -> Result<T> {
        self.disconnect(transport).await;
        let seconds = budget.as_secs();
        error!(
            sidecar = %self.name,
            method = %method,
            id = id,
            timeout_secs = seconds,
            "Sidecar request timed out; dropping connection for respawn"
        );
        let name = &self.name;
        bail!("{name} sidecar request {method} timed out after {seconds}s")
    }

    /// Spawn the sidecar process and connect via Unix socket.
    /// Returns the child process and transport for the caller to store.
    /// TODO `[SIDECAR-STARTUP-SPAWN]`: pass `--endpoint`, generation, and protocol (the parent PID is passed).
    async fn spawn_process(&self) -> Result<(Child, FramedTransport)> {
        info!(sidecar = %self.name, "Spawning sidecar");

        // TODO [SIDECAR-STARTUP-ENDPOINT]: never unlink a pre-existing unowned socket.
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
        info!(sidecar = %self.name, pid = child.id().unwrap_or(0), "Sidecar process spawned");

        let socket_path = self.wait_for_ready(&mut child).await?;

        let transport = connect_transport(&socket_path).await?;
        Ok((child, transport))
    }

    /// TODO `[SIDECAR-STARTUP-HANDSHAKE]`: parse and validate versioned READY JSON.
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
                    // Keep consuming stdout for the life of this child: it now
                    // carries out-of-band `SHARPLSP-EVENT` lines, and an unread
                    // pipe would eventually fill and block the sidecar.
                    drop(tokio::spawn(forward_stdout_events(
                        reader,
                        self.events_tx.clone(),
                        self.name.clone(),
                    )));
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
    /// a stale frame for the next caller. `[SIDECAR-IPC-TIMEOUT]`
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
        let delay = self.grow_backoff().await;

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
    /// Runs at most once per manager: a later call returns at once, so every
    /// successful `workspace/open`, including a reopen after a failed first
    /// open, can ask for it.
    pub async fn start_health_monitor(self: Arc<Self>) {
        if self.monitored.swap(true, Ordering::AcqRel) {
            return;
        }
        health_loop(self).await;
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

    /// Test-only: [`Self::connected_to_stream_for_tests`] as one language's
    /// compiler, so open buffers route to it the way they route to a real one.
    pub(crate) async fn compiler_on_stream_for_tests(
        stream: tokio::io::DuplexStream,
        language: crate::tree_sitter_parse::LangId,
    ) -> Self {
        let mut manager = Self::connected_to_stream_for_tests(stream).await;
        manager.language = Some(language);
        manager
    }
}

/// Forward post-READY `SHARPLSP-EVENT` stdout lines from a sidecar child into
/// the manager's event channel, so out-of-band notifications (e.g. a settled
/// file-based restore) reach the host without a socket round-trip — and so
/// the pipe can never fill and block the sidecar. Ends at child exit (EOF);
/// each respawned child gets its own forwarder wired to the same channel.
/// [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
async fn forward_stdout_events(
    mut reader: tokio::io::BufReader<tokio::process::ChildStdout>,
    events: tokio::sync::mpsc::UnboundedSender<String>,
    sidecar: String,
) {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if let Some(event) = line.trim().strip_prefix("SHARPLSP-EVENT ") {
            debug!(sidecar = %sidecar, event = %event, "Sidecar event");
            if events.send(event.to_string()).is_err() {
                return;
            }
        }
    }
}

/// Response budget for a sidecar method. `workspace/open` legitimately runs a
/// full `MSBuild` design-time build; anything else past two minutes is wedged.
/// `[SIDECAR-IPC-TIMEOUT]`
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
///   3. Dev build via `dotnet run --project src/sidecars/<name>`
///      (CWD = repo root).
// TODO [SIDECAR-STARTUP-RESOLUTION]: validate absolute candidates and remove dotnet run.
fn sidecar_launch(
    tool_command: &str,
    subdir: &str,
    name: &str,
    socket_path: &str,
) -> (String, Vec<String>) {
    let path_var = std::env::var_os("PATH");
    sidecar_launch_on(path_var.as_deref(), tool_command, subdir, name, socket_path)
}

/// [`sidecar_launch`] against the `PATH` value `path_var`, so the resolution
/// order is testable without mutating the process environment.
fn sidecar_launch_on(
    path_var: Option<&std::ffi::OsStr>,
    tool_command: &str,
    subdir: &str,
    name: &str,
    socket_path: &str,
) -> (String, Vec<String>) {
    debug!(
        tool_command,
        subdir, name, socket_path, "Resolving sidecar launch command"
    );

    // [SHARPLSP-ARCHITECTURE-EXTENSIONS-SIDECAR-ENV]: env var override takes absolute priority.
    if let Some(exe) = env_var_sidecar_override(subdir) {
        info!(exe = %exe.display(), source = "env-var", "Sidecar resolved");
        return (exe.to_string_lossy().to_string(), sidecar_args(socket_path));
    }

    if let Some(found) = path_var.and_then(|path| crate::paths::find_command(tool_command, path)) {
        info!(tool = %tool_command, path = %found.display(), source = "PATH", "Sidecar resolved");
        return (tool_command.to_string(), sidecar_args(socket_path));
    }
    debug!(tool_command, "Tool not found on PATH");

    if let Some(exe) = installed_sidecar_exe(subdir, name) {
        info!(exe = %exe.display(), source = "installed", "Sidecar resolved");
        return (exe.to_string_lossy().to_string(), sidecar_args(socket_path));
    }

    info!(sidecar = %name, source = "dotnet-run", "Sidecar resolved — using dev dotnet run");
    let run = [
        "run".to_string(),
        "--project".to_string(),
        format!("src/sidecars/{name}"),
        "--".to_string(),
    ];
    (
        "dotnet".to_string(),
        run.into_iter().chain(sidecar_args(socket_path)).collect(),
    )
}

/// Arguments every launch source passes the sidecar: its endpoint, then this
/// host's PID, which arms the sidecar's parent-death watchdog and Windows Job
/// Object containment so a hard host death cannot leak the sidecar tree.
/// Implements `[SIDECAR-STARTUP-SPAWN]` and `[SIDECAR-PROCESS-PARENT]` (GitHub #163).
fn sidecar_args(socket_path: &str) -> Vec<String> {
    vec![
        socket_path.to_string(),
        "--parent-pid".to_string(),
        std::process::id().to_string(),
    ]
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

    let exe_name = crate::paths::executable_name(name);

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
// TODO [SIDECAR-STARTUP-ENDPOINT]: generate a fresh OS-CSPRNG nonce for every spawn generation.
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
#[path = "manager_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "manager_path_tests.rs"]
mod path_tests;
