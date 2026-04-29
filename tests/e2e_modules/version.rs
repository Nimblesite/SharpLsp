use super::*;

// ── CLI version flag ─────────────────────────────────────────────

/// `sharplsp --version` prints "sharplsp X.Y.Z" and exits 0.
///
/// Editor extensions rely on this exact format to detect version mismatches.
/// If this test fails, every extension (VS Code, Zed, etc.) will break.
#[test]
fn version_flag_prints_correct_format_and_exits_zero() {
    let output = Command::new(env!("CARGO_BIN_EXE_sharplsp-lsp"))
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
