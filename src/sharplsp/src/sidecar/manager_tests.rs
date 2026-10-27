#![expect(
    clippy::unwrap_used,
    clippy::panic_in_result_fn,
    reason = "test code — panics are the correct failure mode; returning Err \
              instead would hide which condition broke"
)]

use super::*;
use anyhow::Result;
use std::path::PathBuf;

/// `command` on the process `PATH`, as [`sidecar_launch`] resolves it.
fn find_on_path(command: &str) -> Option<PathBuf> {
    crate::paths::find_command(command, &std::env::var_os("PATH")?)
}

/// On Unix, `ipc_path` must produce a `.sock` path containing the sidecar name.
#[cfg(unix)]
#[test]
fn ipc_path_unix_ends_with_sock_and_contains_name() {
    let path = ipc_path("sharplsp-csharp", &PathBuf::from("/some/workspace"));
    assert!(
        crate::paths::has_extension(&path, &["sock"]),
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

#[tokio::test]
async fn shutdown_prevents_background_respawn() {
    let manager = SidecarManager::new("test", "unused", vec![], "unused");

    manager.shutdown().await;

    assert!(manager.is_shutting_down());
    let error = manager.request("ping", Vec::new()).await.unwrap_err();
    assert!(error.to_string().contains("shutting down"));
}

#[tokio::test]
async fn health_monitor_runs_once_per_manager() {
    let manager = Arc::new(SidecarManager::new("test", "cmd", vec![], "/tmp/test.sock"));
    let first = tokio::spawn(Arc::clone(&manager).start_health_monitor());
    tokio::task::yield_now().await;
    let second = tokio::time::timeout(
        Duration::from_secs(5),
        Arc::clone(&manager).start_health_monitor(),
    )
    .await;
    assert!(second.is_ok(), "a second monitor returns at once");
    assert!(!first.is_finished(), "the first monitor keeps running");
    first.abort();
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
    assert_eq!(args, launched_with("/tmp/sharplsp-test.sock"));
}

#[test]
fn sidecar_launch_falls_back_to_dotnet_run() {
    let name = format!("SharpLsp.Missing.Sidecar.{}", std::process::id());
    let command_name = format!("sharplsp-missing-sidecar-{}", std::process::id());
    let subdir = format!("missing-sidecar-dir-{}", std::process::id());

    let (command, args) = sidecar_launch(&command_name, &subdir, &name, "/tmp/sharplsp-test.sock");

    assert_eq!(command, "dotnet");
    assert_eq!(
        args,
        vec![
            "run".to_string(),
            "--project".to_string(),
            format!("src/sidecars/{name}"),
            "--".to_string(),
            "/tmp/sharplsp-test.sock".to_string(),
            "--parent-pid".to_string(),
            std::process::id().to_string(),
        ]
    );
}

/// The arguments every launch source must pass: the endpoint, then this
/// host's PID for the sidecar's parent-death watchdog. Spelled out
/// literally — not via `sidecar_args` — so the contract is what is tested.
/// `[SIDECAR-STARTUP-SPAWN]`, `[SIDECAR-PROCESS-PARENT]` (GitHub #163)
pub(super) fn launched_with(socket: &str) -> Vec<String> {
    vec![
        socket.to_string(),
        "--parent-pid".to_string(),
        std::process::id().to_string(),
    ]
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
    assert_eq!(args, launched_with("/tmp/sharplsp-test.sock"));

    remove_vsix_sidecar(&subdir, &name)?;
    Ok(())
}

#[test]
fn installed_sidecar_exe_returns_none_for_missing_sidecar() {
    let subdir = format!("sidecar-missing-{}", std::process::id());
    let name = format!("SharpLsp.Sidecar.Missing{}", std::process::id());
    assert!(installed_sidecar_exe(&subdir, &name).is_none());
}

/// The directory the test executable runs from, where a VSIX lays sidecars.
pub(super) fn test_exe_dir() -> Result<PathBuf> {
    Ok(std::env::current_exe()
        .context("current test executable")?
        .parent()
        .context("test executable directory")?
        .to_path_buf())
}

pub(super) fn create_vsix_sidecar(subdir: &str, name: &str) -> Result<PathBuf> {
    let exe_dir = test_exe_dir()?;
    let exe = exe_dir.join(subdir).join(sidecar_exe_name(name));
    let parent = exe.parent().context("sidecar executable parent")?;
    std::fs::create_dir_all(parent).context("create sidecar test directory")?;
    std::fs::write(&exe, b"").context("write sidecar test executable")?;
    Ok(exe)
}

pub(super) fn remove_vsix_sidecar(subdir: &str, name: &str) -> Result<()> {
    let exe_dir = test_exe_dir()?;
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
    crate::paths::executable_name(name)
}

#[test]
fn sidecar_launch_uses_env_var_override() {
    use std::fs;

    let dir = std::env::temp_dir().join(format!("sharplsp-env-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("SharpLsp.Sidecar.CSharp");
    fs::write(&exe, b"").unwrap();

    // Implements [SHARPLSP-ARCHITECTURE-EXTENSIONS-SIDECAR-ENV]: SHARPLSP_CSHARP_SIDECAR_PATH overrides all other resolution.
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
    assert_eq!(args, launched_with("/tmp/sharplsp-test-env.sock"));
}

/// A wedged sidecar (accepts the request, never answers) must fail the
/// request within its budget and poison the transport so the next request
/// respawns a clean process — not hang the LSP main loop forever.
/// Implements [SHARPLSP-ARCHITECTURE-SIDECARS-TIMEOUT].
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

    let first = manager.request("ping", Vec::new()).await.unwrap_err();
    assert!(
        !format!("{first:#}").contains("backoff"),
        "first attempt must surface the real spawn failure, got: {first:#}"
    );

    let second = manager.request("ping", Vec::new()).await.unwrap_err();
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
    let err = manager.request("ping", Vec::new()).await.unwrap_err();
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
