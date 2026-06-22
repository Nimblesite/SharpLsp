//! Build-configuration e2e test for [BUILD-DEPSFILE-LOCK] (GitHub issue #111).
//!
//! `SharpLsp.Sidecar.Common` is a *referenced-only* class library: it is consumed
//! by the executable sidecars (`SharpLsp.Sidecar.CSharp`) and the test project,
//! each of which generates its own `deps.json`. Common's own `deps.json` is never
//! read at runtime — it exists only to be written into `bin/` on every build,
//! where a concurrent/indexing process can momentarily hold it open and make the
//! `GenerateDepsFile` `MSBuild` task fail with:
//!
//!   error MSB4018: The "`GenerateDepsFile`" task failed unexpectedly.
//!   System.IO.IOException: The process cannot access the file
//!   'SharpLsp.Sidecar.Common.deps.json' because it is being used by another process.
//!
//! The fix is to stop emitting that unnecessary, lock-prone artifact for the
//! library: `<GenerateDependencyFile>false</GenerateDependencyFile>`. This test
//! asserts — via a real `MSBuild` evaluation of the real `.csproj`, not string
//! matching — that dependency-file generation is disabled for Common.
//!
//! See `docs/bugs/BUILD-GENERATEDEPSFILE-LOCK-BUG.md`.

#![expect(
    clippy::expect_used,
    reason = "test code — panics are the correct failure mode"
)]

use std::process::Command;

/// Absolute path to the real Common library project.
fn common_csproj() -> String {
    let manifest = env!("CARGO_MANIFEST_DIR");
    format!("{manifest}/sidecars/SharpLsp.Sidecar.Common/SharpLsp.Sidecar.Common.csproj")
}

/// Evaluate a single `MSBuild` property on a project, returning its trimmed value.
/// Uses `dotnet msbuild -getProperty:<name>`, which performs a genuine `MSBuild`
/// evaluation (imports + SDK targets) and prints only the resolved value.
fn evaluate_property(csproj: &str, property: &str) -> String {
    let output = Command::new("dotnet")
        .args([
            "msbuild",
            csproj,
            &format!("-getProperty:{property}"),
            "-v:q",
            "-nologo",
        ])
        .output()
        .expect("failed to run `dotnet msbuild -getProperty` — is the .NET SDK installed?");

    assert!(
        output.status.success(),
        "msbuild evaluation of {property} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("msbuild output is valid UTF-8")
        .trim()
        .to_owned()
}

/// [BUILD-DEPSFILE-LOCK] The Common library must NOT generate a `deps.json`.
///
/// Pre-fix this evaluates to `true` (the SDK default), so the lock-prone
/// `deps.json` is emitted and this test fails. Post-fix it evaluates to `false`.
#[test]
fn common_library_disables_dependency_file_generation() {
    let value = evaluate_property(&common_csproj(), "GenerateDependencyFile");

    assert_eq!(
        value, "false",
        "SharpLsp.Sidecar.Common is a referenced-only library and must set \
         <GenerateDependencyFile>false</GenerateDependencyFile> so it does not emit \
         an unused, lock-prone deps.json (GitHub #111). Evaluated to: {value:?}"
    );
}
