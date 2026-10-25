/// End-to-end coverage for the engine-side pull-diagnostics plumbing:
///   * `workspace/diagnostics/documents` — the shared DiagnosticDocument[]
///     enumeration of the loaded workspace's source documents
///     ([DIAG-ARCHITECTURE-PULL-REFRESH]);
///   * `textDocument/didClose` — the editor buffer overlay is dropped so a
///     closed file reads from disk again ([HOVER-FSHARP-OVERLAY]);
///   * `diagnostics/configure` — the analyzer on/off gate that must never
///     suppress compiler diagnostics ([DIAG-CATEGORIES-ANALYZER]);
///   * parse-error truth for a real file the loaded project does not compile.
/// ALL real: a real sidecar process over IPC, a real .fsproj on disk, no mocks.
module SharpLsp.Sidecar.FSharp.Tests.FSharpDiagnosticsDocumentsTests

open System
open System.IO
open System.Threading
open System.Threading.Tasks
open MessagePack
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Ipc
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp

let private validSource =
    "module TestProject.Valid\n\nlet add (a: int) (b: int) = a + b\n"

let private extraSource =
    "module TestProject.Extra\n\nlet private compute () = 1 + 1\n\nlet ignoredResult () =\n    compute ()\n    ()\n"

let private hintsSource =
    "module TestProject.Hints\n\nopen System.Text\n\nlet hintValue = 1\n"

/// A file with a real F# syntax error that the loaded project does NOT compile.
let private orphanSource = "module TestProject.Orphan\n\nlet broken = (\n"

let private brokenOverlay = "module TestProject.Valid\n\nlet add (a: int) (b: string) = a + b\n"

let private createFixtureProject () =
    let dir = NativePaths.Temp($"sharplsp-engdiag-{Guid.NewGuid():N}")
    Directory.CreateDirectory(dir) |> ignore

    File.WriteAllText(
        NativePaths.Resolve(dir, "TestProject.fsproj"),
        """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Valid.fs" />
    <Compile Include="Extra.fs" />
    <Compile Include="Hints.fs" />
  </ItemGroup>
</Project>""")

    File.WriteAllText(NativePaths.Resolve(dir, "Valid.fs"), validSource)
    File.WriteAllText(NativePaths.Resolve(dir, "Extra.fs"), extraSource)
    File.WriteAllText(NativePaths.Resolve(dir, "Hints.fs"), hintsSource)
    // On disk but deliberately absent from the <Compile> list.
    File.WriteAllText(NativePaths.Resolve(dir, "Orphan.fs"), orphanSource)
    dir

let private deserialize<'T> (payload: byte array) : 'T =
    MessagePackSerializer.Deserialize<'T>(ReadOnlyMemory<byte>(payload), MessagePackSerializerOptions.Standard)

/// A fresh real sidecar over IPC with the fixture project loaded.
type EngineDiagnosticsFixture() =
    let dir = createFixtureProject ()
    let sock = NativePaths.Temp($"sharplsp-engdiag-{Guid.NewGuid():N}.sock")
    let sidecar = new FSharpSidecar()
    let mutable transport: FramedTransport option = None
    let mutable nextId = 0
    let notifications = ResizeArray<Envelope>()

    member _.Dir = dir
    member _.Project = NativePaths.Resolve(dir, "TestProject.fsproj")
    member _.Valid = NativePaths.Resolve(dir, "Valid.fs")
    member _.Extra = NativePaths.Resolve(dir, "Extra.fs")
    member _.Hints = NativePaths.Resolve(dir, "Hints.fs")
    member _.Orphan = NativePaths.Resolve(dir, "Orphan.fs")
    member _.Notifications = notifications.ToArray()

    member private _.ReadEnvelope(transport: FramedTransport, ct: CancellationToken) : Task<Envelope> = task {
        let! raw = transport.ReadFrameAsync(ct)
        match raw with
        | null -> return failwith "Connection closed"
        | bytes -> return deserialize<Envelope>(bytes)
    }

    member private _.RecordNotification(response: Envelope) =
        Assert.False(response.Id.HasValue)
        Assert.NotNull(response.Method)
        notifications.Add(response)

    member private this.ReadResponse(transport: FramedTransport, id: uint32) : Task<Envelope> = task {
        let! response = this.ReadEnvelope(transport, CancellationToken.None)
        if response.Id.HasValue then
            Assert.Equal(id, response.Id.Value)
            return response
        else
            this.RecordNotification(response)
            return! this.ReadResponse(transport, id)
    }

    member this.AwaitNotification(method: string, after: int, ct: CancellationToken) : Task<Envelope> = task {
        match notifications |> Seq.skip after |> Seq.tryFind (fun item -> item.Method = method) with
        | Some response -> return response
        | None ->
            match transport with
            | None -> return failwith "sidecar transport is not connected"
            | Some connected ->
                let! response = this.ReadEnvelope(connected, ct)
                this.RecordNotification(response)
                return! this.AwaitNotification(method, after, ct)
    }

    member private _.Request(meth, payload) =
        Envelope(Id = Nullable(uint32 (Interlocked.Increment(&nextId))), Method = meth, Payload = payload)

    member private _.WriteEnvelope(envelope: Envelope) : Task = task {
        match transport with
        | None -> return failwith "sidecar transport is not connected"
        | Some connected -> do! connected.WriteFrameAsync(MessagePackSerializer.Serialize(envelope))
    }

    /// Only one response reader runs, even when several real compiler requests are queued.
    member this.Receive(id: uint32) : Task<Envelope> =
        match transport with
        | None -> Task.FromException<Envelope>(InvalidOperationException("sidecar transport is not connected"))
        | Some connected -> this.ReadResponse(connected, id)

    /// Preserve the real socket request identity while its compiler work is in flight.
    member this.Begin(meth: string, payload: byte array) : uint32 * Task<Envelope> =
        let request = this.Request(meth, payload)
        let response = task {
            do! this.WriteEnvelope(request)
            return! this.Receive(request.Id.Value)
        }
        request.Id.Value, response

    /// Queue actual IPC without racing another reader on the native stream.
    member this.Enqueue(meth: string, payload: byte array) : Task<uint32> = task {
        let request = this.Request(meth, payload)
        do! this.WriteEnvelope(request)
        return request.Id.Value
    }

    member this.Send(meth: string, payload: byte array) : Task<Envelope> =
        this.Begin(meth, payload) |> snd

    /// Standard cancellation traverses SidecarHost's actual socket reader and request pump.
    member this.Cancel(id: uint32) : Task =
        this.WriteEnvelope(Envelope(Method = "$/cancelRequest", Payload = MessagePackSerializer.Serialize(id)))

    member this.SendFor(meth: string, path: string) : Task<Envelope> =
        this.Send(meth, MessagePackSerializer.Serialize(path))

    member this.DidChange(path: string, text: string) : Task<Envelope> =
        this.Send("textDocument/didChange", MessagePackSerializer.Serialize({ DidChangeRequest.FilePath = path; NewText = text }))

    member this.DidClose(path: string) : Task<Envelope> =
        this.Send("textDocument/didClose", MessagePackSerializer.Serialize({ DidChangeRequest.FilePath = path; NewText = "" }))

    interface IAsyncLifetime with
        member this.InitializeAsync() = task {
            if File.Exists(sock) then File.Delete(sock)
            let _ = Task.Run(fun () -> sidecar.RunAsync(sock))
            let mutable connected = false

            for _ in 1..100 do
                if not connected then
                    do! Task.Delay(50)
                    let! result = IpcConnection.ConnectAsync(sock)
                    let stream = result.Match((fun value -> Some value), (fun _ -> None))

                    match stream with
                    | Some value ->
                        transport <- Some(new FramedTransport(value))
                        connected <- true
                    | None -> ()

            if not connected then failwith "Cannot connect to F# sidecar"

            let! opened = this.Send("workspace/open", MessagePackSerializer.Serialize(this.Project))
            if not (isNull opened.Error) then failwith $"workspace/open: {opened.Error}"
        }

        member _.DisposeAsync() = task {
            match transport with
            | Some t -> do! t.DisposeAsync()
            | None -> ()

            do! (sidecar :> IAsyncDisposable).DisposeAsync()
            try Directory.Delete(dir, true) with _ -> ()
            try File.Delete(sock) with _ -> ()
        }

    member this.Diagnostics(path: string, ?project: bool) : Task<DiagnosticResult array> =
        task {
            let method = if defaultArg project false then "workspace/diagnostics/project" else "workspace/diagnostics"
            let! response = this.SendFor(method, path)
            Assert.Null(response.Error)
            return deserialize<DiagnosticResult array>(response.Payload)
        }

    member this.Documents(?projects: bool) : Task<DiagnosticDocument array> =
        task {
            let method = if defaultArg projects false then "workspace/diagnostics/projects" else "workspace/diagnostics/documents"
            let! response = this.Send(method, [||])
            Assert.Null(response.Error)
            return deserialize<DiagnosticDocument array>(response.Payload)
        }

/// A sidecar that never opened a workspace.
type EngineDiagnosticsTests(fixture: EngineDiagnosticsFixture) =
    interface IClassFixture<EngineDiagnosticsFixture>

    // Implements [DIAG-IPC-WORKSPACE-PULL]: F# exposes only lazy compiler pulls.
    [<Fact>]
    member _.``bulk diagnostics is unavailable and lazy pulls remain available``() =
        task {
            let payload = MessagePackSerializer.Serialize([| Array.empty<string> |])
            let! bulk = fixture.Send("workspace/diagnostics/all", payload)
            Assert.NotNull(bulk.Error)
            Assert.Contains("Unknown method", bulk.Error, StringComparison.Ordinal)
            let! documents = fixture.Documents()
            Assert.Contains(documents, fun document -> NativePaths.AreEqual(document.FilePath, fixture.Valid))
            let! diagnostics = fixture.Diagnostics(fixture.Valid)
            Assert.DoesNotContain(diagnostics, fun diagnostic -> diagnostic.Severity = "Error")
        }

    [<Fact>]
    member _.``workspace diagnostics documents lists every project source file once``() =
        task {
            let! documents = fixture.Documents()
            let paths = documents |> Array.map (fun d -> d.FilePath)

            Assert.Contains<string>(fixture.Valid, paths)
            Assert.Contains<string>(fixture.Extra, paths)
            Assert.Contains<string>(fixture.Hints, paths)
            // Not part of the loaded workspace's source set.
            Assert.DoesNotContain<string>(fixture.Orphan, paths)
            Assert.Equal(paths.Length, paths |> Array.distinct |> Array.length)
        }

    [<Fact>]
    member _.``workspace diagnostics documents carries the owning project metadata``() =
        task {
            let! documents = fixture.Documents()
            Assert.NotEmpty(documents)

            for document in documents do
                Assert.Equal("TestProject", document.ProjectName)
                Assert.Equal<string>(fixture.Project, document.ProjectPath)
        }

    [<Fact>]
    member _.``textDocument didClose drops the buffer so the file reads from disk``() =
        task {
            // The editor buffer carries a type error the on-disk file does not.
            let! changed = fixture.DidChange(fixture.Valid, brokenOverlay)
            Assert.Null(changed.Error)
            let! broken = fixture.Diagnostics(fixture.Valid)
            Assert.Contains(broken, fun d -> d.Severity = "Error")

            // didClose hands the file back to disk: the overlay must go.
            let! closed = fixture.DidClose(fixture.Valid)
            Assert.Null(closed.Error)

            let! cleaned = fixture.Diagnostics(fixture.Valid)
            Assert.DoesNotContain(cleaned, fun d -> d.Severity = "Error")
        }

    [<Fact>]
    member _.``diagnostics configure off keeps compiler diagnostics and drops analyzer hints``() =
        task {
            let! before = fixture.Diagnostics(fixture.Hints)
            Assert.Contains(before, fun d -> d.Code = "SLSPF0102")

            let payload =
                MessagePackSerializer.Serialize(
                    DiagnosticsConfiguration(AnalyzersEnabled = false)
                )

            let! configured = fixture.Send("diagnostics/configure", payload)
            Assert.Null(configured.Error)

            let! hintsAfter = fixture.Diagnostics(fixture.Hints)
            Assert.DoesNotContain(hintsAfter, fun d -> d.Code = "SLSPF0102")

            // The compiler's FS0020 warning on Extra.fs must survive the opt-out.
            let! extraAfter = fixture.Diagnostics(fixture.Extra)
            Assert.Contains(extraAfter, fun d -> d.Code = "FS0020")

            // Restore the default so sibling tests in this fixture see analyzers on.
            let restore =
                MessagePackSerializer.Serialize(
                    DiagnosticsConfiguration(AnalyzersEnabled = true)
                )

            let! restored = fixture.Send("diagnostics/configure", restore)
            Assert.Null(restored.Error)
        }

    [<Fact>]
    member _.``analyzer hints are on by default and compiler errors still surface``() =
        task {
            let! hints = fixture.Diagnostics(fixture.Hints)
            Assert.Contains(hints, fun d -> d.Code = "SLSPF0102")
        }

/// A sidecar that never opened a workspace: its own process, socket and fixture.
type UnloadedDocumentsTests() =
    let dir = createFixtureProject ()
    let sock = NativePaths.Temp($"sharplsp-engdiag-{Guid.NewGuid():N}.sock")
    let sidecar = new FSharpSidecar()
    let mutable transport: FramedTransport option = None

    interface IAsyncLifetime with
        member _.InitializeAsync() =
            task {
                if File.Exists(sock) then File.Delete(sock)
                let _ = Task.Run(fun () -> sidecar.RunAsync(sock))
                let mutable connected = false

                for _ in 1..100 do
                    if not connected then
                        do! Task.Delay(50)
                        let! result = IpcConnection.ConnectAsync(sock)
                        let stream = result.Match((fun value -> Some value), (fun _ -> None))

                        match stream with
                        | Some value ->
                            transport <- Some(new FramedTransport(value))
                            connected <- true
                        | None -> ()

                if not connected then failwith "Cannot connect to F# sidecar"
            }

        member _.DisposeAsync() =
            task {
                match transport with
                | Some t -> do! t.DisposeAsync()
                | None -> ()

                do! (sidecar :> IAsyncDisposable).DisposeAsync()
                try Directory.Delete(dir, true) with _ -> ()
                try File.Delete(sock) with _ -> ()
            }

    [<Fact>]
    member _.``workspace diagnostics documents answers empty before a workspace loads``() =
        task {
            match transport with
            | None -> return failwith "sidecar transport is not connected"
            | Some t ->
                let request =
                    Envelope(Id = Nullable(uint32 1), Method = "workspace/diagnostics/documents", Payload = [||])

                do! t.WriteFrameAsync(MessagePackSerializer.Serialize(request))
                let! raw = t.ReadFrameAsync()

                match raw with
                | null -> return failwith "Connection closed"
                | bytes ->
                    let response = deserialize<Envelope>(bytes)
                    Assert.Null(response.Error)
                    let documents = deserialize<DiagnosticDocument array>(response.Payload)
                    Assert.Empty(documents)
                    return ()
        }
