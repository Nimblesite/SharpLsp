//! One native process launcher with per-child environment overrides. [DIST-CI-ARTIFACT-TESTS]
use super::*;

impl LspClient {
    /// Launch an isolated server without mutating the test runner's environment.
    pub fn spawn_in_with_env(
        stderr: Stdio,
        cwd: Option<&std::path::Path>,
        environment: &[(&str, &std::ffi::OsStr)],
    ) -> Self {
        let binary = sharplsp_binary_path();
        let debug = launcher_debug(&binary);
        let failure = format!("failed to spawn sharplsp\n{debug}");
        eprintln!("{debug}");
        let mut command = Command::new(&binary);
        let _ = command.envs(environment.iter().copied());
        if let Some(dir) = cwd {
            let _ = command.current_dir(dir);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .expect(&failure);
        let stdin = child.stdin.take().expect("no stdin");
        let stdout = child.stdout.take().expect("no stdout");
        let stderr = child.stderr.take();
        let reader = BufReader::new(stdout);
        Self {
            child,
            stdin: Some(stdin),
            reader,
            stderr,
            config_dir: None,
        }
    }
}
