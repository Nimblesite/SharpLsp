namespace FSharpFixtures

/// Placeholder file kept LAST in compile order. The diagnostics e2e tests
/// overwrite this file on disk with erroneous F# to exercise the FCS
/// diagnostic pipeline, then restore this valid content in teardown.
/// Keep it self-contained: nothing here is referenced by other fixture files,
/// so an injected error cannot cascade into their analysis.
module DiagnosticsTarget =

    /// A trivially valid binding so the clean fixture compiles without warnings.
    let healthy : int = 42
