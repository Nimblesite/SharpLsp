/// Real compiler IPC must retain current compiler errors through lint failure and recovery.
/// Implements [DIAG-CATEGORIES-ANALYZER] and [DIAG-TRUTH-GUARANTEES] (GitHub #469).
module SharpLsp.Sidecar.FSharp.Tests.FSharpLintDiagnosticsTests

open System.IO
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.Tests.FSharpDiagnosticsDocumentsTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpScriptDiagnosticsTests

type LintFailureDiagnosticsTests(fixture: EngineDiagnosticsFixture) =
    let config = NativePaths.Resolve(fixture.Dir, "fsharplint.json")
    let broken = "module TestProject.Valid\nlet answer: int = \"broken\"\nlet negate value = not (value = 1)\n"
    let clean = "module TestProject.Valid\nlet answer: int = 42\nlet negate value = value <> 1\n"
    let valid = """{"hints":{"add":["not (a = b) ===> a <> b"]}}"""

    interface IClassFixture<EngineDiagnosticsFixture>

    member private _.Change(source) = task {
        let! response = fixture.DidChange(fixture.Valid, source)
        Assert.Null(response.Error)
    }

    member private _.Failure(expected) = task {
        let! diagnostics = fixture.Diagnostics(fixture.Valid)
        let failures = diagnostics |> Array.filter (fun item -> item.Code = "SLSPF0104")
        if expected then
            let failure = Assert.Single(failures)
            Assert.Equal("Warning", failure.Severity)
            Assert.True(NativePaths.AreEqual(fixture.Valid, failure.FilePath))
            Assert.Equal((0, 0, 0, 0), (failure.StartLine, failure.StartCharacter, failure.EndLine, failure.EndCharacter))
            Assert.Contains("did not complete", failure.Message)
        else
            Assert.Empty(failures)
        return diagnostics
    }

    member private _.Compiler(code) = task {
        let! errors = assertErrors fixture fixture.Valid code
        for error in errors do
            Assert.Equal(1, error.StartLine)
            // F# compiler messages have no guaranteed stable page; a dead link is
            // worse than none ([DIAG-CATEGORIES-ANALYZER]).
            Assert.Equal("", error.HelpLink)
    }

    [<Theory>]
    [<InlineData("{")>]
    [<InlineData("""{"hints":{"add":["not a valid hint?"]}}""")>]
    member this.``invalid lint config preserves fresh compiler truth and recovers in the same IPC session``(invalid: string) = task {
        File.WriteAllText(config, invalid)
        do! this.Change(broken)
        let! _ = this.Failure(true)
        do! this.Compiler(Some "FS0001")
        File.WriteAllText(config, valid)
        let! recovered = this.Failure(false)
        let hint = Assert.Single(recovered |> Array.filter (fun item -> item.Code = "FL0065"))
        Assert.Equal("Warning", hint.Severity)
        Assert.Equal(2, hint.StartLine)
        Assert.Equal("https://fsprojects.github.io/FSharpLint/how-tos/rules/FL0065.html", hint.HelpLink)
        do! this.Compiler(Some "FS0001")
        do! this.Change(clean)
        do! this.Compiler(None)
        File.WriteAllText(config, invalid)
        let! _ = this.Failure(true)
        do! this.Compiler(None)
    }
