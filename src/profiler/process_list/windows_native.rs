//! Windows process enumeration via the native process table (`sysinfo`).
//!
//! Spawned enumerators are both fragile and slow on Windows: WMIC is
//! deprecated, ships only as a Feature-on-Demand, and is absent by default on
//! Windows 11 24H2+ / Server 2025, while its supported replacement —
//! PowerShell `Get-CimInstance Win32_Process` — pays roughly a second of
//! shell startup plus CIM query per call, blowing the profiler's <500ms
//! `listProcesses` budget. In-process enumeration spawns nothing (no console
//! flash either) and returns in milliseconds.

use std::ffi::OsString;
use std::path::Path;

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use super::DotNetProcess;

/// Enumerate all Windows processes from the native process table.
///
/// Cannot fail: processes the caller may not inspect (protected/system) are
/// enumerated with an empty command line and classified by bare name, so the
/// `kill` .NET-only guard still fails closed for them.
pub(super) fn process_list() -> Vec<DotNetProcess> {
    let mut system = System::new();
    let _ = system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_exe(UpdateKind::Always),
    );
    system
        .processes()
        .values()
        .map(|process| DotNetProcess {
            pid: process.pid().as_u32(),
            name: process.name().to_string_lossy().into_owned(),
            command_line: join_command_line(process.exe(), process.cmd()),
            runtime_version: None,
        })
        .collect()
}

/// Reconstruct a classification/display command line: the resolved executable
/// path (preferred over `argv[0]`, which may be relative or bare) followed by
/// the remaining argv tokens. The executable token is quoted when it contains
/// spaces so the parent module's `first_exe_token` recovers the full path.
/// Protected processes expose neither — they yield an empty string and
/// `classify` falls back to the bare process name.
fn join_command_line(exe: Option<&Path>, argv: &[OsString]) -> String {
    let exe_token = exe.map_or_else(
        || {
            argv.first()
                .map(|arg| arg.to_string_lossy().into_owned())
                .unwrap_or_default()
        },
        |path| path.to_string_lossy().into_owned(),
    );
    let mut line = quote_if_spaced(exe_token);
    for arg in argv.iter().skip(1) {
        line.push(' ');
        line.push_str(&arg.to_string_lossy());
    }
    line
}

/// Wrap a token in double quotes when it contains spaces (Windows command-line
/// convention, and what `first_exe_token` expects for spaced paths).
fn quote_if_spaced(token: String) -> String {
    if token.contains(' ') {
        format!("\"{token}\"")
    } else {
        token
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(tokens: &[&str]) -> Vec<OsString> {
        tokens.iter().map(OsString::from).collect()
    }

    #[test]
    fn join_command_line_prefers_the_resolved_exe_over_argv0() {
        let argv = args(&["dotnet", "run"]);
        let line = join_command_line(Some(Path::new(r"C:\dotnet\dotnet.exe")), &argv);
        assert_eq!(line, r"C:\dotnet\dotnet.exe run");
    }

    #[test]
    fn join_command_line_quotes_spaced_exe_paths_for_first_exe_token() {
        let argv = args(&["app", "--serve"]);
        let line = join_command_line(Some(Path::new(r"C:\Program Files\App\app.exe")), &argv);
        assert_eq!(line, r#""C:\Program Files\App\app.exe" --serve"#);
    }

    #[test]
    fn join_command_line_preserves_commas_in_arguments() {
        // Regression: the old wmic CSV path split on ',' and silently
        // corrupted any process whose command line contained a comma.
        let argv = args(&["dotnet", "App.dll", "--tag", "a,b,c"]);
        let line = join_command_line(Some(Path::new(r"C:\dotnet\dotnet.exe")), &argv);
        assert_eq!(line, r"C:\dotnet\dotnet.exe App.dll --tag a,b,c");
    }

    #[test]
    fn join_command_line_falls_back_to_argv0_then_empty() {
        assert_eq!(
            join_command_line(None, &args(&["myapp.exe", "-x"])),
            "myapp.exe -x"
        );
        // Protected/system process: no exe, no argv.
        assert_eq!(join_command_line(None, &[]), "");
    }
}
