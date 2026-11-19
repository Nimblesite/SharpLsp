/// A script's `#r "nuget: …"` restore runs off the request path: the script is checked
/// without its packages and says so, then binds them once they land. [SCRIPT-FSX-NUGET]
module SharpLsp.Sidecar.FSharp.Tests.FSharpScriptPackageTests

open System
open System.Diagnostics
open System.IO
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.Tests.FSharpDiagnosticsDocumentsTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpScriptDiagnosticsTests

/// The notice a script carries while its packages are being restored.
[<Literal>]
let private Pending = "SLSPF0002"

/// A script referencing `version` of the package and calling `call` on it.
let private script (version: string) (call: string) =
    $"#r \"nuget: Newtonsoft.Json, {version}\"\nopen Newtonsoft.Json\nlet text = JsonConvert.{call} 1\n"

type ScriptPackageTests(fixture: EngineDiagnosticsFixture) =
    let path = NativePaths.Resolve(fixture.Dir, "Packages.fsx")
    let other = NativePaths.Resolve(fixture.Dir, "OtherPackages.fsx")

    interface IClassFixture<EngineDiagnosticsFixture>

    member private _.Change(source: string) = task {
        let! response = fixture.DidChange(path, source)
        Assert.Null(response.Error)
    }

    /// The first answer for a script never asked about before: the notice alone, with no
    /// phantom error for the namespace its package will bring.
    member private _.FirstAnswerIsTheNotice(script: string) = task {
        let! first = fixture.Diagnostics(script)
        let notice = Assert.Single(first)
        Assert.Equal(Pending, notice.Code)
        Assert.Equal("Info", notice.Severity)
        Assert.True(NativePaths.AreEqual(script, notice.FilePath))
        Assert.Equal((0, 0), (notice.StartLine, notice.StartCharacter))
        Assert.Contains("restored", notice.Message)
    }

    /// The script's diagnostics once its packages have landed.
    member private _.Restored(script: string) = task {
        let elapsed = Stopwatch.StartNew()
        let mutable current = [||]
        let mutable waiting = true
        while waiting do
            let! diagnostics = fixture.Diagnostics(script)
            current <- diagnostics
            waiting <- diagnostics |> Array.exists (fun item -> item.Code = Pending)
            Assert.True(elapsed.Elapsed < TimeSpan.FromMinutes 4.0, "the packages never landed")
            if waiting then do! Threading.Tasks.Task.Delay 200
        Assert.DoesNotContain(current, fun item -> item.Severity = "Error")
        return current
    }

    [<Fact>]
    member this.``A script is checked without its packages until they are restored``() = task {
        // 1. The first answer does not wait for the restore, which starts with it.
        File.WriteAllText(path, script "13.0.3" "SerializeObject")
        do! this.FirstAnswerIsTheNotice(path)

        // 2. Once the packages land the notice is gone and the script compiles.
        let! restored = this.Restored(path)
        Assert.DoesNotContain(restored, fun item -> item.Code = Pending)

        // 3. The reference is real: a member the package does not declare is an error, and
        //    an edit of the code alone never restores again.
        do! this.Change(script "13.0.3" "NoSuchMember")
        let! broken = fixture.Diagnostics(path)
        Assert.DoesNotContain(broken, fun item -> item.Code = Pending)
        let! errors = assertErrors fixture path (Some "FS0039")
        Assert.Equal(2, (Assert.Single errors).StartLine)
        do! this.Change(script "13.0.3" "SerializeObject")
        let! mended = fixture.Diagnostics(path)
        Assert.Empty(mended |> Array.filter (fun item -> item.Severity = "Error" || item.Code = Pending))

        // 4. A directive edit is another restore, and the script binds the new version.
        do! this.Change(script "13.0.2" "SerializeObject")
        let! _ = this.Restored(path)

        // 5. Another script is its own restore: pending first, then bound.
        File.WriteAllText(other, script "13.0.1" "SerializeObject")
        do! this.FirstAnswerIsTheNotice(other)
        let! _ = this.Restored(other)

        do! restoreProject fixture [ path ]
    }

/// Typing a package name is a directive edit per keystroke: each later directive set
/// supersedes the earlier ones, whose restores are cancelled rather than left running
/// side by side, and only the surviving one reports itself resolved. [SCRIPT-FSX-NUGET]
[<Fact>]
let ``A directive edit cancels the restore it supersedes`` () = task {
    let checker = FSharp.Compiler.CodeAnalysis.FSharpChecker.Create()
    let path = NativePaths.Resolve(Path.GetTempPath(), $"supersede-{Guid.NewGuid():N}.fsx")
    let mutable running = 0
    let mutable fired = 0
    let last = Threading.Tasks.TaskCompletionSource()
    use _resolved = SharpLsp.Sidecar.FSharp.FSharpScriptPackages.Resolved.Subscribe(fun _ -> Threading.Interlocked.Increment(&fired) |> ignore)
    let resolve (final: bool) (token: Threading.CancellationToken) : Threading.Tasks.Task = task {
        Threading.Interlocked.Increment(&running) |> ignore
        if final then last.TrySetResult() |> ignore
        try
            try do! Threading.Tasks.Task.Delay(Threading.Timeout.Infinite, token)
            with :? OperationCanceledException -> ()
        finally Threading.Interlocked.Decrement(&running) |> ignore
    }
    let names = [ "N"; "Ne"; "Newtonsoft" ]
    for name in names do
        let! plan = SharpLsp.Sidecar.FSharp.FSharpScriptPackages.plan checker path $"#r \"nuget: {name}\"\n" (resolve (name = List.last names))
        Assert.True(plan.IsWithoutPackages, $"{name}: checked without its packages while they restore")
    let! started = Threading.Tasks.Task.WhenAny(last.Task, Threading.Tasks.Task.Delay 10000)
    Assert.Same(last.Task, started)
    do! Threading.Tasks.Task.Delay 300
    Assert.Equal(1, running)
    Assert.Equal(0, fired)
}

