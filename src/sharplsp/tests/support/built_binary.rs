//! The `sharplsp` binary this test run built. Implements [DIST-CI-ARTIFACT-TESTS].
use std::path::PathBuf;

/// nextest sets `NEXTEST_BIN_EXE_sharplsp` when the test starts. The compile-time
/// `CARGO_BIN_EXE_sharplsp` names the build runner's target directory, which does
/// not exist once a test archive is extracted on another runner.
pub fn built_sharplsp() -> PathBuf {
    std::env::var_os("NEXTEST_BIN_EXE_sharplsp").map_or_else(
        || PathBuf::from(env!("CARGO_BIN_EXE_sharplsp")),
        PathBuf::from,
    )
}
