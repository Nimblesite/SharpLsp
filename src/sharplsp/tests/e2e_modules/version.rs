use super::*;

/// Real CLI bootstrap errors exit before starting the language server.
/// Implements [DIST-VERSION-OUTPUT] and [DIST-CLEAN-OUTPUT].
#[test]
fn closed_version_output_reports_failure_without_starting_the_server() {
    for arguments in [vec!["--version"], vec!["--version", "--json"]] {
        let (reader, writer) = std::io::pipe().expect("create a real CLI stdout pipe");
        drop(reader);
        let output = Command::new(built_sharplsp())
            .args(arguments)
            .stdout(writer)
            .output()
            .expect("run the actual version CLI against a closed output consumer");
        assert_version_write_failure(output);
    }
}

fn assert_version_write_failure(output: std::process::Output) {
    assert_eq!(
        output.status.code(),
        Some(1),
        "failed version writes fail CLI"
    );
    assert!(
        output.stdout.is_empty(),
        "bootstrap failure emits no LSP frames"
    );
    let error = String::from_utf8(output.stderr).expect("bootstrap errors are UTF-8");
    assert!(error.starts_with("version dispatch error:"), "{error}");
    assert_eq!(
        error.lines().count(),
        1,
        "bootstrap produces one actionable error"
    );
}

// ── CLI version flag ─────────────────────────────────────────────

/// `sharplsp --version` prints "sharplsp X.Y.Z" and exits 0.
///
/// Editor extensions rely on this exact format to detect version mismatches.
/// If this test fails, every extension (VS Code, Zed, etc.) will break.
#[test]
fn version_flag_prints_correct_format_and_exits_zero() {
    let output = Command::new(built_sharplsp())
        .arg("--version")
        .output()
        .expect("failed to run sharplsp --version");

    assert!(
        output.status.success(),
        "sharplsp --version must exit with code 0, got: {}",
        output.status,
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();

    // Format: "sharplsp X.Y.Z"
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    assert_eq!(
        parts.len(),
        2,
        "Expected exactly 2 tokens ('sharplsp X.Y.Z'), got: {trimmed:?}",
    );
    assert_eq!(
        parts[0], "sharplsp",
        "First token must be 'sharplsp', got: {:?}",
        parts[0],
    );

    // Version must match Cargo.toml.
    let expected_version = env!("CARGO_PKG_VERSION");
    assert_eq!(
        parts[1], expected_version,
        "Version must match Cargo.toml ({expected_version}), got: {:?}",
        parts[1],
    );

    // Verify it's a valid semver-ish format (X.Y.Z).
    let segments: Vec<&str> = parts[1].split('.').collect();
    assert!(
        segments.len() >= 2,
        "Version must have at least X.Y segments, got: {:?}",
        parts[1],
    );
    for segment in &segments {
        assert!(
            segment.parse::<u32>().is_ok(),
            "Each version segment must be numeric, got: {segment:?} in {:?}",
            parts[1],
        );
    }
}
