/// A script is checked under the arguments `dotnet fsi` would be started with: the
/// host's `fsharp.script_arguments`. [SCRIPT-FSX-ARGUMENTS]
module SharpLsp.Sidecar.FSharp.Tests.FSharpScriptArgumentTests

open System.IO
open MessagePack
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp.Tests.FSharpDiagnosticsDocumentsTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpScriptDiagnosticsTests

/// Compiles only where `FROM_ARGUMENTS` is defined, and matches incompletely (FS0025).
let private source =
    "#if FROM_ARGUMENTS\nlet answer = 42\n#else\nlet answer: int = \"not a number\"\n#endif\n"
    + "let describe (value: int option) =\n    match value with\n    | Some found -> found\n"

type ScriptArgumentTests(fixture: EngineDiagnosticsFixture) =
    let path = NativePaths.Resolve(fixture.Dir, "Arguments.fsx")

    interface IClassFixture<EngineDiagnosticsFixture>

    /// Send the host's configuration with `arguments` for scripts.
    member private _.Configure(arguments: string array) = task {
        let configuration =
            DiagnosticsConfiguration(AnalyzersEnabled = true, RefreshSupported = false, ScriptArguments = arguments)
        let! response = fixture.Send("diagnostics/configure", MessagePackSerializer.Serialize configuration)
        Assert.Null(response.Error)
    }

    /// The codes the script reports, compiler findings only.
    member private _.Codes() = task {
        let! diagnostics = fixture.Diagnostics(path)
        return diagnostics |> Array.map _.Code |> Array.filter (fun code -> code.StartsWith "FS") |> Array.sort
    }

    [<Fact>]
    member this.``A script is checked under the configured arguments``() = task {
        File.WriteAllText(path, source)

        // 1. No arguments: the symbol is undefined, so the other branch is checked.
        do! this.Configure([||])
        let! plain = this.Codes()
        Assert.Equal<string array>([| "FS0001"; "FS0025" |], plain)

        // 2. A define selects the branch that compiles; the warning still stands.
        do! this.Configure([| "--define:FROM_ARGUMENTS" |])
        let! defined = this.Codes()
        Assert.Equal<string array>([| "FS0025" |], defined)

        // 3. Several arguments apply together: the warning is switched off too.
        do! this.Configure([| "--define:FROM_ARGUMENTS"; "--nowarn:25" |])
        let! quiet = this.Codes()
        Assert.Empty(quiet)

        // 4. A warning raised to an error is an error, at its own place.
        do! this.Configure([| "--define:FROM_ARGUMENTS"; "--warnaserror:25" |])
        let! raised = fixture.Diagnostics(path)
        let incomplete = Assert.Single(raised, fun item -> item.Code = "FS0025")
        Assert.Equal("Error", incomplete.Severity)
        Assert.Equal(6, incomplete.StartLine)

        // 5. Taking the arguments away restores the first answer: nothing is kept.
        do! this.Configure([||])
        let! restored = this.Codes()
        Assert.Equal<string array>(plain, restored)

        do! restoreProject fixture [ path ]
    }
