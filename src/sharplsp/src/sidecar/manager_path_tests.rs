//! The sidecar launch chain against real files, candidate by candidate: env
//! override, `PATH` (where a shim `CreateProcess` cannot run must never stop the
//! chain, GitHub #167), the three installed layouts, then `dotnet run`.
//! Implements [SIDECAR-STARTUP-RESOLUTION].
#![expect(
    clippy::panic_in_result_fn,
    reason = "test code — a failed assert IS the failure mode; returning Err \
              instead would hide which condition broke"
)]

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::sidecar_launch_on;
use super::tests::{create_vsix_sidecar, remove_vsix_sidecar, test_exe_dir};
use crate::paths::test_paths::path_var_of;

const SOCKET: &str = "/tmp/sharplsp-path-test.sock";

/// Writes the empty file `name` into `dir`.
fn touch(dir: &Path, name: &str) -> Result<()> {
    std::fs::write(dir.join(name), b"").context("write PATH fixture")
}

/// GitHub #167: a `dotnet tool` `.cmd` shim (plus `.bat` and extensionless
/// spellings) on `PATH` resolved, the spawn failed, and the VSIX sidecar was
/// never tried. The chain must skip the shims, take the VSIX layout, then a
/// real `.exe` once one is on `PATH`, then `dotnet run` once no layout is left.
#[cfg(windows)]
#[test]
fn windows_path_shims_fall_through_to_the_next_candidate() -> Result<()> {
    let pid = std::process::id();
    let tool = format!("sharplsp-sidecar-pathtest-{pid}");
    let subdir = format!("sidecar-pathtest-{pid}");
    let name = format!("SharpLsp.Sidecar.PathTest{pid}");
    let shims = tempfile::tempdir().context("shim PATH dir")?;
    for suffix in [".cmd", ".bat", ""] {
        touch(shims.path(), &format!("{tool}{suffix}"))?;
    }
    let only_shims = path_var_of(&[shims.path()])?;
    let vsix = create_vsix_sidecar(&subdir, &name)?;

    // 1. Shims only on PATH: the VSIX sidecar is launched, not the shim.
    let (command, args) = sidecar_launch_on(Some(&only_shims), &tool, &subdir, &name, SOCKET);
    assert_ne!(
        command, tool,
        "a .cmd/.bat/extensionless shim must not resolve"
    );
    assert_eq!(PathBuf::from(&command), vsix);
    assert!(vsix.is_file());
    assert_eq!(args, vec![SOCKET.to_string()]);

    // 2. A real `.exe` in a later PATH entry: the PATH tool wins again.
    let real = tempfile::tempdir().context("real PATH dir")?;
    touch(real.path(), &format!("{tool}.exe"))?;
    let both = path_var_of(&[shims.path(), real.path()])?;
    let (command, args) = sidecar_launch_on(Some(&both), &tool, &subdir, &name, SOCKET);
    assert_eq!(command, tool);
    assert_ne!(PathBuf::from(&command), vsix);
    assert_eq!(args, vec![SOCKET.to_string()]);

    // 3. Shims only and no installed layout: the dev `dotnet run` fallback.
    remove_vsix_sidecar(&subdir, &name)?;
    let (command, args) = sidecar_launch_on(Some(&only_shims), &tool, &subdir, &name, SOCKET);
    assert_eq!(command, "dotnet");
    assert_eq!(args.first().map(String::as_str), Some("run"));
    assert!(args.contains(&format!("src/sidecars/{name}")));
    assert_eq!(args.last().map(String::as_str), Some(SOCKET));
    Ok(())
}

/// No `PATH` at all skips the PATH step and still reaches the installed layout.
#[test]
fn missing_path_skips_to_the_installed_sidecar() -> Result<()> {
    let pid = std::process::id();
    let subdir = format!("sidecar-nopath-{pid}");
    let name = format!("SharpLsp.Sidecar.NoPath{pid}");
    let vsix = create_vsix_sidecar(&subdir, &name)?;

    let (command, args) = sidecar_launch_on(None, "dotnet", &subdir, &name, SOCKET);
    assert_eq!(PathBuf::from(&command), vsix);
    assert_ne!(command, "dotnet");
    assert_eq!(args, vec![SOCKET.to_string()]);

    remove_vsix_sidecar(&subdir, &name)?;
    Ok(())
}

/// GitHub #167, one shim at a time: each spelling `CreateProcess` cannot run,
/// alone on `PATH`, still hands the launch to the VSIX sidecar; adding the
/// real executable hands it back to the `PATH` tool. [SIDECAR-STARTUP-RESOLUTION]
#[test]
fn each_path_shim_alone_falls_through_to_the_vsix_sidecar() -> Result<()> {
    let pid = std::process::id();
    let (subdir, name) = (
        format!("sidecar-eachshim-{pid}"),
        format!("SharpLsp.Sidecar.EachShim{pid}"),
    );
    let tool = format!("sharplsp-sidecar-eachshim-{pid}");
    let vsix = create_vsix_sidecar(&subdir, &name)?;
    for suffix in [".cmd", ".bat", ".ps1", ".com", ".CMD", ".exe.cmd"] {
        let dir = tempfile::tempdir().context("shim PATH dir")?;
        touch(dir.path(), &format!("{tool}{suffix}"))?;
        let path_var = path_var_of(&[dir.path()])?;

        let (command, args) = sidecar_launch_on(Some(&path_var), &tool, &subdir, &name, SOCKET);
        assert_eq!(PathBuf::from(&command), vsix, "{suffix} must fall through");
        assert_eq!(args, vec![SOCKET.to_string()], "{suffix}");

        touch(dir.path(), &crate::paths::executable_name(&tool))?;
        let (command, _) = sidecar_launch_on(Some(&path_var), &tool, &subdir, &name, SOCKET);
        assert_eq!(
            command, tool,
            "{suffix}: the real executable beside it wins"
        );
    }
    remove_vsix_sidecar(&subdir, &name)?;
    Ok(())
}

/// Writes an empty sidecar executable `name` into `dir`, creating `dir`.
fn place_sidecar(dir: &Path, name: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(dir).context("create sidecar layout dir")?;
    let exe = dir.join(crate::paths::executable_name(name));
    std::fs::write(&exe, b"").context("write sidecar layout exe")?;
    Ok(exe)
}

/// The command `sidecar_launch_on` picks with no `PATH`.
fn launch_without_path(subdir: &str, name: &str) -> String {
    sidecar_launch_on(None, "unused-tool", subdir, name, SOCKET).0
}

/// The installed layouts resolve in priority order — VSIX, then `make install`,
/// then the dev build — each one shadowing the ones below it, and `dotnet run`
/// once none is left. [SIDECAR-STARTUP-RESOLUTION]
#[test]
fn installed_layouts_resolve_in_priority_order() -> Result<()> {
    let pid = std::process::id();
    let (subdir, name) = (
        format!("sidecar-layouts-{pid}"),
        format!("SharpLsp.Sidecar.Layouts{pid}"),
    );
    let target = test_exe_dir()?
        .parent()
        .context("exe dir parent")?
        .to_path_buf();
    let installed_dir = target.join("lib").join("sharplsp").join(&subdir);
    let dev_dir = target.join(&subdir);

    let dev = place_sidecar(&dev_dir, &name)?;
    assert_eq!(PathBuf::from(launch_without_path(&subdir, &name)), dev);
    let installed = place_sidecar(&installed_dir, &name)?;
    assert_eq!(
        PathBuf::from(launch_without_path(&subdir, &name)),
        installed
    );
    let vsix = create_vsix_sidecar(&subdir, &name)?;
    assert_eq!(PathBuf::from(launch_without_path(&subdir, &name)), vsix);

    remove_vsix_sidecar(&subdir, &name)?;
    assert_eq!(
        PathBuf::from(launch_without_path(&subdir, &name)),
        installed
    );
    std::fs::remove_dir_all(&installed_dir).context("remove make-install layout")?;
    assert_eq!(PathBuf::from(launch_without_path(&subdir, &name)), dev);
    std::fs::remove_dir_all(&dev_dir).context("remove dev layout")?;
    assert_eq!(launch_without_path(&subdir, &name), "dotnet");
    Ok(())
}

/// An env override naming a missing file is skipped, not launched; once the
/// file exists it beats every other candidate. [SHARPLSP-ARCHITECTURE-EXTENSIONS-SIDECAR-ENV]
#[test]
fn env_override_is_skipped_until_its_file_exists() -> Result<()> {
    let pid = std::process::id();
    let (subdir, name) = (
        format!("sidecar-envtest{pid}"),
        format!("SharpLsp.Sidecar.EnvTest{pid}"),
    );
    let key = format!("SHARPLSP_ENVTEST{pid}_SIDECAR_PATH");
    let dir = tempfile::tempdir().context("override dir")?;
    let override_exe = dir.path().join(crate::paths::executable_name(&name));
    std::env::set_var(&key, &override_exe);
    let vsix = create_vsix_sidecar(&subdir, &name)?;

    assert!(!override_exe.exists());
    assert_eq!(PathBuf::from(launch_without_path(&subdir, &name)), vsix);
    std::fs::write(&override_exe, b"").context("write override exe")?;
    let (command, args) = sidecar_launch_on(None, "unused-tool", &subdir, &name, SOCKET);
    assert_eq!(PathBuf::from(command), override_exe);
    assert_eq!(args, vec![SOCKET.to_string()]);

    std::env::remove_var(&key);
    assert_eq!(PathBuf::from(launch_without_path(&subdir, &name)), vsix);
    remove_vsix_sidecar(&subdir, &name)
}
