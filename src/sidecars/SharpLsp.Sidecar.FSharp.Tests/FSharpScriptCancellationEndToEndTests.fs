/// Real SDK, socket, SidecarHost and FCS: no replacement diagnostic backend.
/// Implements [DIAG-ANALYSIS-CANCELLATION], [DIAG-TRUTH-GUARANTEES], [SCRIPT-FSX-DIAGNOSTICS].
module SharpLsp.Sidecar.FSharp.Tests.FSharpScriptCancellationEndToEndTests

open System
open System.IO
open System.Threading.Tasks
open MessagePack
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp.Tests.FSharpDiagnosticsDocumentsTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpScriptDiagnosticsTests

let private saved = "// Real script input\n\nlet value: int = \"broken\"\n"
let private current = "// Real script input\n\nlet value: int = missing\n"
let private clean = "// Real script input\n\nlet value: int = 42\n"

let private assertCancelled id (response: Envelope) =
    Assert.Equal(Nullable(id), response.Id)
    Assert.False(String.IsNullOrWhiteSpace(response.Error))
    Assert.Empty(response.Payload)

/// The actual SDK interpreter independently establishes each source's compiler truth.
let private sdkTruth directory script expected = task {
    use child = NativeHeldSource.start "dotnet" ["fsi"; "--exec"; script]
    let output = child.StandardOutput.ReadToEndAsync()
    let errors = child.StandardError.ReadToEndAsync()
    do! child.WaitForExitAsync()
    let! stdout = output
    let! stderr = errors
    Assert.Equal((if Option.isSome expected then 1 else 0), child.ExitCode)
    expected |> Option.iter (fun code -> Assert.Contains(code, stdout + stderr, StringComparison.Ordinal))
    Assert.True(Directory.Exists(directory))
}

type ScriptCancellationTests(fixture: EngineDiagnosticsFixture) =
    let script = NativePaths.Resolve(fixture.Dir, "Held.fsx")
    interface IClassFixture<EngineDiagnosticsFixture>
    interface IAsyncLifetime with
        member _.InitializeAsync() = Task.CompletedTask
        member _.DisposeAsync() = restoreProject fixture [script]

    member private _.Oracles() = task {
        for source, expected in [saved, Some "FS0001"; current, Some "FS0039"; clean, None] do
            File.WriteAllText(script, source)
            do! sdkTruth fixture.Dir script expected
        File.WriteAllText(script, saved)
    }

    member private _.Truth(expected) = task {
        let! errors = assertErrors fixture script expected
        for diagnostic in errors do
            Assert.Equal(2, diagnostic.StartLine)
            Assert.Equal(2, diagnostic.EndLine)
            Assert.True(diagnostic.EndCharacter > diagnostic.StartCharacter)
    }

    member private this.Change(source, expected) = task {
        let! changed = fixture.DidChange(script, source)
        Assert.Null(changed.Error)
        do! this.Truth(expected)
    }

    member private _.CancelWhileHeld(held: NativeHeldSource.HeldSource) = task {
        let id, pending = fixture.Begin("workspace/diagnostics", MessagePackSerializer.Serialize(script))
        do! held.Opened.WaitAsync(TimeSpan.FromSeconds(20.0))
        Assert.True(held.IsHeld, "the actual script read is still held")
        do! fixture.Cancel(id)
        let! response = pending.WaitAsync(TimeSpan.FromSeconds(5.0))
        assertCancelled id response
        Assert.True(held.IsHeld, "cancellation cannot wait for obsolete script I/O")
    }

    member private _.CancelQueuedWhileHeld(held: NativeHeldSource.HeldSource) = task {
        let id, pending = fixture.Begin("workspace/diagnostics", MessagePackSerializer.Serialize(script))
        do! held.Opened.WaitAsync(TimeSpan.FromSeconds(20.0))
        let! queued = fixture.Enqueue("workspace/diagnostics", MessagePackSerializer.Serialize(script))
        do! fixture.Cancel(queued)
        Assert.False(pending.IsCompleted, "queued cancellation does not cancel the active compiler read")
        Assert.True(held.IsHeld)
        do! fixture.Cancel(id)
        let! activeReply = pending.WaitAsync(TimeSpan.FromSeconds(5.0))
        assertCancelled id activeReply
        let! queuedReply = fixture.Receive(queued).WaitAsync(TimeSpan.FromSeconds(5.0))
        assertCancelled queued queuedReply
        Assert.True(held.IsHeld, "both terminal replies precede release of obsolete source I/O")
    }

    member private this.AfterCancellation(held: NativeHeldSource.HeldSource) = task {
        do! this.Change(current, Some "FS0039")
        Assert.True(held.IsHeld, "fresh script errors must arrive before old I/O is released")
        do! this.Change(clean, None)
        Assert.True(held.IsHeld, "an unsaved repair does not release the saved source")
        do! held.Release()
        let! closed = fixture.DidClose(script)
        Assert.Null(closed.Error)
        Assert.Equal(saved, File.ReadAllText(script))
        do! this.Truth(Some "FS0001")
    }

    member private this.EditWhileHeld() = task {
        use! held = NativeHeldSource.create script saved
        do! this.CancelWhileHeld(held)
        do! this.AfterCancellation(held)
    }

    member private this.OpenScript() = task {
        do! this.Oracles()
        let! opened = fixture.SendFor("workspace/open", script)
        Assert.Null(opened.Error)
        do! this.Truth(Some "FS0001")
    }

    member private _.Alive() = task {
        let! ping = fixture.Send("ping", [||])
        Assert.Null(ping.Error)
        Assert.Equal("pong", SidecarEndToEndTests.deserialize<string>(ping.Payload))
    }

    [<Fact>]
    member this.``cancelled script source read releases current errors and repair over real compiler IPC``() = task {
        do! this.OpenScript()
        do! this.EditWhileHeld()
        do! this.Alive()
    }

    [<Fact>]
    member this.``queued cancellation cannot erase active compiler work or delay fresh script truth``() = task {
        do! this.OpenScript()
        use! held = NativeHeldSource.create script saved
        do! this.CancelQueuedWhileHeld(held)
        do! this.AfterCancellation(held)
        do! this.Alive()
    }
