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

    /// Returns the display name of this sidecar.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Create a manager for the C# sidecar.
    pub fn csharp(workspace_root: &Path) -> Self {
        let socket_path = format!(
            "{}/sharplsp-csharp-{:x}.sock",
            std::env::temp_dir().display(),
            fxhash(workspace_root.to_string_lossy().as_bytes())
        );

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
        let socket_path = format!(
            "{}/sharplsp-fsharp-{:x}.sock",
            std::env::temp_dir().display(),
            fxhash(workspace_root.to_string_lossy().as_bytes())
        );

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

        let (child, transport) = self.spawn_process().await?;
        *self.child.lock().await = Some(child);
        *transport_guard = Some(transport);
        info!(sidecar = %self.name, "Sidecar connected");
        Ok(())
    }

    /// Send a request to the sidecar and wait for the response.
    pub async fn request(&self, method: &str, payload: Vec<u8>) -> Result<Vec<u8>> {
        self.ensure_running().await?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        info!(sidecar = %self.name, method = %method, id = id, "Sidecar request");
        let envelope = Envelope::request(id, method, payload);

        let mut transport_guard = self.transport.lock().await;
        let transport = transport_guard.as_mut().context("sidecar not connected")?;

        transport.write_envelope(&envelope).await?;

        let response = transport
            .read_envelope()
            .await?
            .context("sidecar closed connection")?;

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

    /// Spawn the sidecar process and connect via Unix socket.
    /// Returns the child process and transport for the caller to store.
    async fn spawn_process(&self) -> Result<(Child, FramedTransport)> {
        info!(sidecar = %self.name, "Spawning sidecar");

        // Clean up stale socket.
        let _ = tokio::fs::remove_file(&self.socket_path).await;

        info!(
            sidecar = %self.name,
            command = %self.spawn_command,
            args = ?self.spawn_args,
            socket = %self.socket_path,
            "Spawning sidecar process"
        );
        let mut child = Command::new(&self.spawn_command)
            .args(&self.spawn_args)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .with_context(|| {
                format!(
                    "failed to spawn {} sidecar: command={:?} args={:?}",
                    self.name, self.spawn_command, self.spawn_args
                )
            })?;

        let socket_path = self.wait_for_ready(&mut child).await?;

        // Connect to the sidecar's Unix socket.
        let stream = UnixStream::connect(&socket_path)
            .await
            .with_context(|| format!("connect to sidecar socket: {socket_path}"))?;

        let transport = FramedTransport::new(stream);
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

        ready
    }

    /// Send a ping and verify the response.
    pub async fn health_check(&self) -> Result<()> {
        let ping_payload = rmp_serde::to_vec("ping")?;
        let result = tokio::time::timeout(PING_TIMEOUT, self.request("ping", ping_payload)).await;

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
    debug!(tool_command, subdir, name, socket_path, "Resolving sidecar launch command");

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
}
