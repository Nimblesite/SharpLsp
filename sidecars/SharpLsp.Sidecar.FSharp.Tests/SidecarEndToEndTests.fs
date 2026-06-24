/// End-to-end tests for the F# sidecar over real IPC sockets.
/// Exercises the full stack: socket → FramedTransport → MessageRouter
/// → SidecarHost → FSharpSidecar → FSharpWorkspace → FCS → HoverBuilder.
module SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

open System
open System.IO
open System.Threading
open System.Threading.Tasks
open Xunit
open MessagePack
open SharpLsp.Sidecar.Common.Ipc
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp

// ── Wire mirrors for handler responses built from anonymous records ──
// The sidecar serializes anonymous records (formatting edits, inlay hints) as
// MessagePack maps keyed by field name. These string-keyed mirrors deserialize
// them by name.

[<MessagePackObject>]
[<NoComparison; NoEquality>]
type FormatEditWire =
    { [<Key("StartLine")>] StartLine: int
      [<Key("StartCharacter")>] StartCharacter: int
      [<Key("EndLine")>] EndLine: int
      [<Key("EndCharacter")>] EndCharacter: int
      [<Key("NewText")>] NewText: string }

// Inlay hints are now serialized as a POSITIONAL MessagePack record (keyed
// 0..3) so the Rust host's `SidecarInlayHint` ([line, character, label, kind])
// can deserialize them. Mirror that layout here.
[<MessagePackObject>]
[<NoComparison; NoEquality>]
type InlayHintWire =
    { [<Key(0)>] Line: int
      [<Key(1)>] Character: int
      [<Key(2)>] Label: string
      [<Key(3)>] Kind: int }

[<MessagePackObject>]
[<NoComparison; NoEquality>]
type SolutionProjectWire =
    { [<Key("path")>] Path: string }

[<MessagePackObject>]
[<NoComparison; NoEquality>]
type SolutionModelWire =
    { [<Key("projects")>] Projects: SolutionProjectWire array }

// ── Test source with known symbol positions (0-based) ───────────
//  6: let add ...                          → add at (6,4)
//  9: type Person = ...                    → Person at (9,5)
// 12: let createPerson ... : Person =      → createPerson at (12,4)
// 15: let result = add 1 2                 → add call at (15,13)
// 17: let person = createPerson "Alice" 30 → person at (17,4), createPerson at (17,13)
// 19: type IGreeter =                      → IGreeter at (19,5)
// 20:     abstract Greet : ...             → Greet at (20,13)
// 22: type SimpleGreeter() =
// 24:         member _.Greet(name) = ...    → Greet impl at (24,17)
// 27:     let greeter = SimpleGreeter()..  → greeter at (27,8)
// 28:     greeter.Greet "World"            → Greet call at (28,12)
let private testSource = """module TestProject.Library

/// <summary>Adds two numbers together.</summary>
/// <param name="a">The first number</param>
/// <param name="b">The second number</param>
/// <returns>The sum of a and b</returns>
let add (a: int) (b: int) = a + b

/// A simple record type.
type Person = { Name: string; Age: int }

/// Creates a new person.
let createPerson (name: string) (age: int) : Person =
    { Name = name; Age = age }

let result = add 1 2

let person = createPerson "Alice" 30

type IGreeter =
    abstract Greet : string -> string

type SimpleGreeter() =
    interface IGreeter with
        member _.Greet(name) = sprintf "Hello, %s!" name

let useGreeter () =
    let greeter = SimpleGreeter() :> IGreeter
    greeter.Greet "World"

// Appended AFTER all hard-coded e2e positions (≤ line 28) so it never shifts
// them. Enriches symbol kinds (DU, struct) and adds a pipeline, exercising the
// completion glyph arms, pipeline inlay hints, and type-hierarchy paths.
type Color =
    | Red
    | Green of int

[<Struct>]
type Point = { Px: int; Py: int }

let pipedSum = [ 1; 2; 3 ] |> List.sum

let colors = [ Red; Green 5 ]

/// A real CLR enum (drives the Enum symbol-kind / glyph arm).
type Direction =
    | North = 0
    | South = 1

/// A class with a constructor and a property (drives the Constructor / Property
/// symbol-kind + glyph arms).
type Counter(start: int) =
    let mutable count = start
    member _.Value = count
    member _.Bump() = count <- count + 1

let counter = Counter(0)
let heading = Direction.North
"""

/// Create a temp directory with a real .fsproj and F# source file.
/// Public so the extra-coverage suite can build a real loaded workspace from it.
let createTestProject () =
    let dir = Path.Combine(Path.GetTempPath(), $"sharplsp-e2e-{Guid.NewGuid():N}")
    Directory.CreateDirectory(dir) |> ignore
    File.WriteAllText(
        Path.Combine(dir, "TestProject.fsproj"),
        """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Library.fs" />
    <Compile Include="Consumer.fs" />
    <Compile Include="Extra.fs" />
    <Compile Include="Dead.fs" />
    <Compile Include="Hints.fs" />
    <Compile Include="Simplify.fs" />
    <Compile Include="Interface.fs" />
  </ItemGroup>
</Project>""")
    File.WriteAllText(Path.Combine(dir, "Library.fs"), testSource)
    // A third file kept self-contained (no references to Library symbols, so it
    // never changes cross-file reference/rename counts). It carries:
    //   * an FS0020 (implicitly-ignored result) at line 4 → drives the
    //     code-action + code-action/resolve success path; and
    //   * an FSharpLint hint (`not (a = b)` → prefer `<>`) at line 7 → drives the
    //     lint branch of workspace/diagnostics.
    File.WriteAllText(
        Path.Combine(dir, "Extra.fs"),
        "module TestProject.Extra\n\n"
        + "let private compute () = 1 + 1\n\n"
        + "let ignoredResult () =\n"
        + "    compute ()\n"
        + "    ()\n\n"
        + "let lintHint x = not (x = 1)\n")
    // A second source file that references Library.add, so references/rename can
    // be exercised across file boundaries (proving they are project-wide).
    File.WriteAllText(
        Path.Combine(dir, "Consumer.fs"),
        "module TestProject.Consumer\n\nopen TestProject.Library\n\nlet consumeAdd () = add 100 200\n")
    // A self-contained file with deliberate dead code, driving the dead-code
    // analyzer ([FS-ANALYZER-DEADCODE]). It references no Library symbols, so it
    // never perturbs cross-file reference/rename counts:
    //   * sharedConst  — private, referenced by every fn below → ALIVE
    //   * deadPrivateFn — private, never used → Warning (always), Error (monorepo)
    //   * deadPublicFn  — public,  never used → skipped (default), Error (monorepo)
    //   * liveOne       — public,  used by liveResult → ALIVE
    //   * liveResult    — public,  never used → skipped (default), Error (monorepo)
    File.WriteAllText(
        Path.Combine(dir, "Dead.fs"),
        "module TestProject.Dead\n\n"
        + "let private sharedConst = 7\n\n"
        + "let private deadPrivateFn () = sharedConst + 1\n\n"
        + "let deadPublicFn () = sharedConst + 2\n\n"
        + "let liveOne () = sharedConst + 3\n\n"
        + "let liveResult = liveOne ()\n")
    // Drives the FSAC-parity file-local analyzers: an unused 'open' that nothing
    // references → [FS-ANALYZER-UNUSEDOPEN].
    File.WriteAllText(
        Path.Combine(dir, "Hints.fs"),
        "module TestProject.Hints\n\nopen System.Text\n\nlet hintValue = 1\n")
    // Drives the analyzer-backed code fixes ([FS-CODEFIX-SIMPLIFYNAME]): `open
    // System` is genuinely used (DateTime unqualified on line 4), so it is NOT a
    // remove-unused-open candidate, while `System.DateTime` on line 6 carries a
    // redundant qualifier → "Simplify name" to `DateTime`.
    File.WriteAllText(
        Path.Combine(dir, "Simplify.fs"),
        "module TestProject.Simplify\n\n"
        + "open System\n\n"
        + "let nowKind () : DateTime = DateTime.Now\n\n"
        + "let redundant = System.DateTime.MinValue\n")
    // Drives the interface-implementation stub code action
    // ([FS-CODEFIX-INTERFACESTUB]): `Square` declares `interface IShape` but
    // implements none of its members → "Implement interface" generates them.
    File.WriteAllText(
        Path.Combine(dir, "Interface.fs"),
        "module TestProject.Interface\n\n"
        + "type IShape =\n"
        + "    abstract member Area: unit -> float\n"
        + "    abstract member Name: string\n\n"
        + "type Square() =\n"
        + "    interface IShape\n")
    dir

/// Deserialize a MessagePack byte[] payload to the target type.
/// Public so the extra-coverage suite ([FSharpExtraCoverageTests]) can reuse it.
let deserialize<'T> (payload: byte array) : 'T =
    let buf : ReadOnlyMemory<byte> = ReadOnlyMemory<byte>(payload)
    MessagePackSerializer.Deserialize<'T>(buf, MessagePackSerializerOptions.Standard)

/// Send an IPC request envelope and return the response.
let private sendRequest (transport: FramedTransport) id meth payload : Task<Envelope> =
    task {
        let req = Envelope(Id = Nullable(uint32 id), Method = meth, Payload = payload)
        let bytes = MessagePackSerializer.Serialize(req)
        do! transport.WriteFrameAsync(bytes)
        let! raw = transport.ReadFrameAsync()
        match raw with
        | null -> return failwith "Connection closed"
        | bytes -> return deserialize<Envelope>(bytes)
    }

/// Build a serialized PositionRequest payload.
/// Public so the extra-coverage suite ([FSharpExtraCoverageTests]) can reuse it.
let posPayload file line char =
    MessagePackSerializer.Serialize(
        { PositionRequest.FilePath = file; Line = line; Character = char })

/// Serialize an `analyzers/configure` request payload.
let analyzerConfigPayload deadCode monorepo =
    MessagePackSerializer.Serialize(
        { AnalyzerConfigRequest.DeadCode = deadCode; Monorepo = monorepo })

/// Dead-code diagnostics whose message names `symbol`.
let deadCodeFor (symbol: string) (diags: DiagnosticResult array) =
    diags
    |> Array.filter (fun d -> d.Code = "SLSPF0101" && d.Message.Contains(symbol))

/// Shared fixture: starts FSharpSidecar over IPC, loads a real workspace.
type SidecarFixture() =
    let dir = createTestProject ()
    let sock = Path.Combine(Path.GetTempPath(), $"sharplsp-e2e-{Guid.NewGuid():N}.sock")
    let sidecar = new FSharpSidecar()
    let mutable transport: FramedTransport option = None
    let mutable nextId = 0
    // A single FramedTransport multiplexes every request from this shared
    // fixture. Write-frame/read-frame must be atomic per request or concurrent
    // callers interleave frames and mis-correlate responses, so all sends are
    // serialized through this gate.
    let sendGate = new System.Threading.SemaphoreSlim(1, 1)

    member _.Dir = dir
    member _.Src = Path.Combine(dir, "Library.fs")
    member _.Consumer = Path.Combine(dir, "Consumer.fs")
    member _.Dead = Path.Combine(dir, "Dead.fs")
    member _.Hints = Path.Combine(dir, "Hints.fs")
    member _.Simplify = Path.Combine(dir, "Simplify.fs")
    member _.Interface = Path.Combine(dir, "Interface.fs")
    member _.NextId() = Interlocked.Increment(&nextId)

    member this.Send(meth, payload) =
        task {
            do! sendGate.WaitAsync()
            try
                return! sendRequest transport.Value (this.NextId()) meth payload
            finally
                sendGate.Release() |> ignore
        }

    interface IAsyncLifetime with
        member this.InitializeAsync() = task {
            if File.Exists(sock) then File.Delete(sock)
            let _ = Task.Run(fun () -> sidecar.RunAsync(sock))

            let mutable ok = false
            for _ in 1..100 do
                if not ok then
                    do! Task.Delay(50)
                    let! result = IpcConnection.ConnectAsync(sock)
                    let stream =
                        result.Match((fun value -> Some value), (fun _ -> None))
                    match stream with
                    | Some value ->
                        transport <- Some(new FramedTransport(value))
                        ok <- true
                    | None -> ()
            if not ok then failwith "Cannot connect to F# sidecar"

            let! resp = this.Send("workspace/open", MessagePackSerializer.Serialize(dir))
            if not (isNull resp.Error) then failwith $"workspace/open: {resp.Error}"
        }

        member _.DisposeAsync() = task {
            match transport with
            | Some t -> do! t.DisposeAsync()
            | None -> ()
            do! (sidecar :> IAsyncDisposable).DisposeAsync()
            sendGate.Dispose()
            try Directory.Delete(dir, true) with _ -> ()
            try if File.Exists(sock) then File.Delete(sock) with _ -> ()
        }

// ── IPC end-to-end tests ────────────────────────────────────────

type SidecarEndToEndTests(fixture: SidecarFixture) =
    interface IClassFixture<SidecarFixture>

    [<Fact>]
    member _.``ping returns pong``() = task {
        let! r = fixture.Send("ping", [||])
        Assert.Null(r.Error)
        Assert.Equal("pong", deserialize<string>(r.Payload))
    }

    [<Fact>]
    member _.``workspace status is loaded``() = task {
        let! r = fixture.Send("workspace/status", [||])
        Assert.Null(r.Error)
        Assert.Equal("loaded", deserialize<string>(r.Payload))
    }

    [<Fact>]
    member _.``workspace open accepts explicit slnx with fsproj``() = task {
        let slnxPath = Path.Combine(fixture.Dir, "TestProject.slnx")
        File.WriteAllText(
            slnxPath,
            """<Solution>
  <Project Path="TestProject.fsproj" />
</Solution>""")

        let! openResult =
            fixture.Send("workspace/open", MessagePackSerializer.Serialize(slnxPath))

        Assert.Null(openResult.Error)
        let! hoverResult = fixture.Send("textDocument/hover", posPayload fixture.Src 6 4)
        Assert.Null(hoverResult.Error)
        Assert.NotEqual<byte>([| 0xC0uy |], hoverResult.Payload)
    }

    [<Fact>]
    member _.``hover on documented function shows xml docs``() = task {
        let! r = fixture.Send("textDocument/hover", posPayload fixture.Src 6 4)
        Assert.Null(r.Error)
        Assert.NotEqual<byte>([| 0xC0uy |], r.Payload)
        let h = deserialize<HoverResult>(r.Payload)
        Assert.Contains("add", h.Contents)
        Assert.Contains("Adds two numbers", h.Contents)
        Assert.Contains("Parameters", h.Contents)
        Assert.True(h.StartLine.HasValue, "StartLine must be set")
        Assert.True(h.StartCharacter.HasValue, "StartCharacter must be set")
    }

    [<Fact>]
    member _.``hover on type shows type info``() = task {
        let! r = fixture.Send("textDocument/hover", posPayload fixture.Src 9 5)
        Assert.Null(r.Error)
        Assert.NotEqual<byte>([| 0xC0uy |], r.Payload)
        let h = deserialize<HoverResult>(r.Payload)
        Assert.Contains("Person", h.Contents)
    }

    [<Fact>]
    member _.``hover on createPerson shows xml docs``() = task {
        let! r = fixture.Send("textDocument/hover", posPayload fixture.Src 12 4)
        Assert.Null(r.Error)
        Assert.NotEqual<byte>([| 0xC0uy |], r.Payload)
        let h = deserialize<HoverResult>(r.Payload)
        Assert.Contains("createPerson", h.Contents)
        Assert.Contains("Creates a new person", h.Contents)
    }

    [<Fact>]
    member _.``hover on empty line returns nil``() = task {
        let! r = fixture.Send("textDocument/hover", posPayload fixture.Src 1 0)
        Assert.Null(r.Error)
        Assert.Equal<byte>([| 0xC0uy |], r.Payload)
    }

    [<Fact>]
    member _.``hover on out of bounds line returns nil``() = task {
        let! r = fixture.Send("textDocument/hover", posPayload fixture.Src 999 0)
        Assert.Null(r.Error)
        Assert.Equal<byte>([| 0xC0uy |], r.Payload)
    }

    [<Fact>]
    member _.``definition of add call resolves to definition``() = task {
        let! r = fixture.Send("textDocument/definition", posPayload fixture.Src 15 13)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(6, loc.Locations[0].Line)
        Assert.Contains("Library.fs", loc.Locations[0].FilePath)
    }

    [<Fact>]
    member _.``definition of createPerson call resolves``() = task {
        let! r = fixture.Send("textDocument/definition", posPayload fixture.Src 17 13)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(12, loc.Locations[0].Line)
    }

    [<Fact>]
    member _.``definition on empty line returns empty``() = task {
        let! r = fixture.Send("textDocument/definition", posPayload fixture.Src 1 0)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.Empty(loc.Locations)
    }

    [<Fact>]
    member _.``definition on type returns its own location``() = task {
        // 'Person' type at (9,5) - definition of itself
        let! r = fixture.Send("textDocument/definition", posPayload fixture.Src 9 5)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(9, loc.Locations[0].Line)
    }

    [<Fact>]
    member _.``typeDefinition of person resolves to Person``() = task {
        let! r = fixture.Send("textDocument/typeDefinition", posPayload fixture.Src 17 4)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(9, loc.Locations[0].Line)
    }

    [<Fact>]
    member _.``typeDefinition of greeter resolves to IGreeter``() = task {
        let! r = fixture.Send("textDocument/typeDefinition", posPayload fixture.Src 27 8)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(19, loc.Locations[0].Line)
    }

    [<Fact>]
    member _.``declaration of interface impl finds abstract member``() = task {
        let! r = fixture.Send("textDocument/declaration", posPayload fixture.Src 24 17)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(20, loc.Locations[0].Line)
    }

    [<Fact>]
    member _.``declaration of regular function returns itself``() = task {
        let! r = fixture.Send("textDocument/declaration", posPayload fixture.Src 6 4)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(6, loc.Locations[0].Line)
    }

    [<Fact>]
    member _.``declaration of type falls through to definition``() = task {
        let! r = fixture.Send("textDocument/declaration", posPayload fixture.Src 9 5)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(9, loc.Locations[0].Line)
    }

    [<Fact>]
    member _.``implementation returns symbol location``() = task {
        let! r = fixture.Send("textDocument/implementation", posPayload fixture.Src 6 4)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
        Assert.Equal(6, loc.Locations[0].Line)
    }

    [<Fact>]
    member _.``implementation on empty line returns empty``() = task {
        let! r = fixture.Send("textDocument/implementation", posPayload fixture.Src 1 0)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.Empty(loc.Locations)
    }

    [<Fact>]
    member _.``unknown method returns error``() = task {
        let! r = fixture.Send("bogus/method", [||])
        Assert.NotNull(r.Error)
        Assert.Contains("Unknown method", r.Error)
    }

    // ── Code Actions ────────────────────────────────────────────

    [<Fact>]
    member _.``code actions returns array for valid file``() = task {
        let payload =
            MessagePackSerializer.Serialize(
                { CodeActionRequest.FilePath = fixture.Src
                  StartLine = 6; StartCharacter = 0
                  EndLine = 6; EndCharacter = 10 })
        let! r = fixture.Send("textDocument/codeAction", payload)
        Assert.Null(r.Error)
        // Should return an array (possibly empty).
        let items = deserialize<CodeActionItemResult array>(r.Payload)
        Assert.NotNull(items)
    }

    // ── Analyzers: monorepo dead-code [FS-ANALYZER-DEADCODE] ─────

    [<Fact>]
    member _.``analyzers configure acknowledges the flags``() = task {
        let! r = fixture.Send("analyzers/configure", analyzerConfigPayload true false)
        Assert.Null(r.Error)
        Assert.Equal("ok", deserialize<string>(r.Payload))
    }

    [<Fact>]
    member _.``dead-code warns on unused private and ignores public off-monorepo``() = task {
        // Off-monorepo: public symbols are assumed external API and not flagged;
        // private dead code is still surfaced as a warning.
        let! cfg = fixture.Send("analyzers/configure", analyzerConfigPayload true false)
        Assert.Null(cfg.Error)
        let! r = fixture.Send("workspace/diagnostics", MessagePackSerializer.Serialize(fixture.Dead))
        Assert.Null(r.Error)
        let diags = deserialize<DiagnosticResult array>(r.Payload)

        let priv = deadCodeFor "deadPrivateFn" diags
        Assert.Equal(1, priv.Length)
        Assert.Equal("Warning", priv[0].Severity)
        Assert.Equal("SLSPF0101", priv[0].Code)
        Assert.Contains("never used", priv[0].Message)
        Assert.Contains("in the project", priv[0].Message)
        // The dead diagnostic points at the private binding's own declaration line.
        Assert.True(priv[0].StartLine >= 0)
        Assert.Contains("Dead.fs", priv[0].FilePath)

        // Public deadness is suppressed without monorepo opt-in.
        Assert.Empty(deadCodeFor "deadPublicFn" diags)
        Assert.Empty(deadCodeFor "liveResult" diags)
        // Live symbols are never flagged.
        Assert.Empty(deadCodeFor "liveOne" diags)
        Assert.Empty(deadCodeFor "sharedConst" diags)
    }

    [<Fact>]
    member _.``monorepo mode reports unused public symbols as errors``() = task {
        let! cfg = fixture.Send("analyzers/configure", analyzerConfigPayload true true)
        Assert.Null(cfg.Error)
        let! r = fixture.Send("workspace/diagnostics", MessagePackSerializer.Serialize(fixture.Dead))
        Assert.Null(r.Error)
        let diags = deserialize<DiagnosticResult array>(r.Payload)

        // Unused public symbol is genuinely dead when the monorepo is the world.
        let pub = deadCodeFor "deadPublicFn" diags
        Assert.Equal(1, pub.Length)
        Assert.Equal("Error", pub[0].Severity)
        Assert.Contains("public", pub[0].Message)
        Assert.Contains("monorepo", pub[0].Message)

        // Private deadness escalates to an error in monorepo mode.
        let priv = deadCodeFor "deadPrivateFn" diags
        Assert.Equal(1, priv.Length)
        Assert.Equal("Error", priv[0].Severity)

        // The orphaned public binding is dead as well.
        Assert.NotEmpty(deadCodeFor "liveResult" diags)
        // But referenced symbols are still never flagged.
        Assert.Empty(deadCodeFor "liveOne" diags)
        Assert.Empty(deadCodeFor "sharedConst" diags)
        // Restore default config so sibling diagnostics tests are unaffected.
        let! _ = fixture.Send("analyzers/configure", analyzerConfigPayload true false)
        ()
    }

    [<Fact>]
    member _.``disabling the analyzer suppresses every dead-code diagnostic``() = task {
        // dead_code = false must win even with monorepo = true.
        let! cfg = fixture.Send("analyzers/configure", analyzerConfigPayload false true)
        Assert.Null(cfg.Error)
        let! r = fixture.Send("workspace/diagnostics", MessagePackSerializer.Serialize(fixture.Dead))
        Assert.Null(r.Error)
        let diags = deserialize<DiagnosticResult array>(r.Payload)
        Assert.Empty(diags |> Array.filter (fun d -> d.Code = "SLSPF0101"))
        // Restore default config so sibling diagnostics tests are unaffected.
        let! _ = fixture.Send("analyzers/configure", analyzerConfigPayload true false)
        ()
    }

    [<Fact>]
    member _.``unused open analyzer flags a redundant open as a hint``() = task {
        // File-local analyzers are always on, independent of the dead-code gate.
        let! r = fixture.Send("workspace/diagnostics", MessagePackSerializer.Serialize(fixture.Hints))
        Assert.Null(r.Error)
        let diags = deserialize<DiagnosticResult array>(r.Payload)
        let opens = diags |> Array.filter (fun d -> d.Code = "SLSPF0102")
        Assert.NotEmpty(opens)
        let o = opens[0]
        Assert.Equal("Hint", o.Severity)
        Assert.Contains("open", o.Message)
        Assert.Contains("Hints.fs", o.FilePath)
        Assert.True(o.StartLine >= 0)
        Assert.True(o.EndCharacter >= o.StartCharacter)
    }

    [<Fact>]
    member _.``code action resolve returns workspace edit for unknown id``() = task {
        let payload =
            MessagePackSerializer.Serialize({ CodeActionResolveRequest.Id = -1 })
        let! r = fixture.Send("codeAction/resolve", payload)
        Assert.Null(r.Error)
        let edit = deserialize<WorkspaceEditResult>(r.Payload)
        Assert.Empty(edit.DocumentChanges)
    }

    // ── Analyzer-driven code fixes (FSAC parity) ────────────────

    [<Fact>]
    member _.``code action offers remove-unused-open and deletes the open line``() = task {
        // Hints.fs line 2 (0-based) is `open System.Text`, which nothing uses.
        let payload =
            MessagePackSerializer.Serialize(
                { CodeActionRequest.FilePath = fixture.Hints
                  StartLine = 2; StartCharacter = 0
                  EndLine = 2; EndCharacter = 16 })
        let! r = fixture.Send("textDocument/codeAction", payload)
        Assert.Null(r.Error)
        let actions = deserialize<CodeActionItemResult array>(r.Payload)
        let remove = actions |> Array.filter (fun a -> a.Title = "Remove unused open")
        Assert.NotEmpty(remove)
        Assert.Equal("quickfix", remove[0].Kind)

        // Resolving the action deletes the whole `open` line: (2,0) → (3,0) = "".
        let resolvePayload =
            MessagePackSerializer.Serialize({ CodeActionResolveRequest.Id = remove[0].Id })
        let! rr = fixture.Send("codeAction/resolve", resolvePayload)
        Assert.Null(rr.Error)
        let edit = deserialize<WorkspaceEditResult>(rr.Payload)
        Assert.Equal(1, edit.DocumentChanges.Length)
        let dc = edit.DocumentChanges[0]
        Assert.Contains("Hints.fs", dc.FilePath)
        Assert.Equal(1, dc.Edits.Length)
        let e = dc.Edits[0]
        Assert.Equal(2, e.StartLine)
        Assert.Equal(0, e.StartCharacter)
        Assert.Equal(3, e.EndLine)
        Assert.Equal(0, e.EndCharacter)
        Assert.Equal("", e.NewText)
    }

    [<Fact>]
    member _.``code action offers simplify-name on a redundant qualifier``() = task {
        // Simplify.fs line 6 (0-based): `let redundant = System.DateTime.MinValue`
        // — `System.` is redundant because `open System` is in scope.
        let payload =
            MessagePackSerializer.Serialize(
                { CodeActionRequest.FilePath = fixture.Simplify
                  StartLine = 6; StartCharacter = 0
                  EndLine = 6; EndCharacter = 40 })
        let! r = fixture.Send("textDocument/codeAction", payload)
        Assert.Null(r.Error)
        let actions = deserialize<CodeActionItemResult array>(r.Payload)
        let simplify = actions |> Array.filter (fun a -> a.Title = "Simplify name")
        Assert.NotEmpty(simplify)
        Assert.Equal("quickfix", simplify[0].Kind)

        // Resolving deletes the redundant `System.` qualifier prefix.
        let resolvePayload =
            MessagePackSerializer.Serialize({ CodeActionResolveRequest.Id = simplify[0].Id })
        let! rr = fixture.Send("codeAction/resolve", resolvePayload)
        Assert.Null(rr.Error)
        let edit = deserialize<WorkspaceEditResult>(rr.Payload)
        Assert.Equal(1, edit.DocumentChanges.Length)
        let dc = edit.DocumentChanges[0]
        Assert.Contains("Simplify.fs", dc.FilePath)
        Assert.Equal(1, dc.Edits.Length)
        let e = dc.Edits[0]
        Assert.Equal(6, e.StartLine)
        Assert.Equal(6, e.EndLine)
        // Applying the edit to the source line yields the simplified form.
        let original = "let redundant = System.DateTime.MinValue"
        let applied =
            original.Substring(0, e.StartCharacter) + e.NewText + original.Substring(e.EndCharacter)
        Assert.Equal("let redundant = DateTime.MinValue", applied)
    }

    [<Fact>]
    member _.``code action offers implement-interface stub for an unimplemented interface``() = task {
        // Interface.fs line 7 (0-based) is `    interface IShape` with no members;
        // `Square` implements none of IShape's members.
        let payload =
            MessagePackSerializer.Serialize(
                { CodeActionRequest.FilePath = fixture.Interface
                  StartLine = 7; StartCharacter = 14
                  EndLine = 7; EndCharacter = 20 })
        let! r = fixture.Send("textDocument/codeAction", payload)
        Assert.Null(r.Error)
        let actions = deserialize<CodeActionItemResult array>(r.Payload)
        let impl = actions |> Array.filter (fun a -> a.Title = "Implement interface")
        Assert.NotEmpty(impl)
        Assert.Equal("quickfix", impl[0].Kind)

        // Resolving generates stubs for both unimplemented members (Area, Name).
        let resolvePayload =
            MessagePackSerializer.Serialize({ CodeActionResolveRequest.Id = impl[0].Id })
        let! rr = fixture.Send("codeAction/resolve", resolvePayload)
        Assert.Null(rr.Error)
        let edit = deserialize<WorkspaceEditResult>(rr.Payload)
        Assert.Equal(1, edit.DocumentChanges.Length)
        let dc = edit.DocumentChanges[0]
        Assert.Contains("Interface.fs", dc.FilePath)
        Assert.Equal(1, dc.Edits.Length)
        let e = dc.Edits[0]
        Assert.Contains("member", e.NewText)
        Assert.Contains("Area", e.NewText)
        Assert.Contains("Name", e.NewText)
    }

    // ── Diagnostics ─────────────────────────────────────────────

    [<Fact>]
    member _.``diagnostics returns array for valid file``() = task {
        let payload = MessagePackSerializer.Serialize(fixture.Src)
        let! r = fixture.Send("workspace/diagnostics", payload)
        Assert.Null(r.Error)
        let diags = deserialize<DiagnosticResult array>(r.Payload)
        Assert.NotNull(diags)
    }

    // ── Formatting Preview ──────────────────────────────────────

    [<Fact>]
    member _.``formatting preview returns original and formatted``() = task {
        let! r = fixture.Send("textDocument/formattingPreview", posPayload fixture.Src 0 0)
        Assert.Null(r.Error)
        // Should return a FormattingPreviewResult (not nil).
        if r.Payload <> [| 0xC0uy |] then
            let preview = deserialize<FormattingPreviewResult>(r.Payload)
            Assert.NotEmpty(preview.Original)
            Assert.NotEmpty(preview.Formatted)
    }

    // ── References ──────────────────────────────────────────────

    [<Fact>]
    member _.``references finds usages of add``() = task {
        let payload =
            MessagePackSerializer.Serialize(
                { ReferencesRequest.FilePath = fixture.Src
                  Line = 6; Character = 4
                  IncludeDeclaration = true })
        let! r = fixture.Send("textDocument/references", payload)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.NotEmpty(loc.Locations)
    }

    // ── Document Highlights ────────────────────────────────────

    [<Fact>]
    member _.``document highlight finds occurrences``() = task {
        let! r = fixture.Send("textDocument/documentHighlight", posPayload fixture.Src 6 4)
        Assert.Null(r.Error)
        let hl = deserialize<DocumentHighlightListResult>(r.Payload)
        Assert.NotEmpty(hl.Highlights)
    }

    // ── Semantic Tokens ────────────────────────────────────────

    [<Fact>]
    member _.``semantic tokens full returns data``() = task {
        let! r = fixture.Send("textDocument/semanticTokens/full", posPayload fixture.Src 0 0)
        Assert.Null(r.Error)
        let tokens = deserialize<SemanticTokensResult>(r.Payload)
        Assert.NotEmpty(tokens.Data)
    }

    // ── Inlay Hints ────────────────────────────────────────────

    [<Fact>]
    member _.``inlay hints returns hints for range``() = task {
        let payload =
            MessagePackSerializer.Serialize(
                { InlayHintRequest.FilePath = fixture.Src
                  StartLine = 0; EndLine = 30 })
        let! r = fixture.Send("textDocument/inlayHint", payload)
        Assert.Null(r.Error)
    }

    [<Fact>]
    member _.``inlay hints returns hint array with labels``() = task {
        // The fixture source has typed bindings and parameter applications, so
        // the inlay-hint handler must serialize a non-empty array of records
        // each carrying a 0-based Line, a Character, a Label, and a Kind.
        let payload =
            MessagePackSerializer.Serialize(
                { InlayHintRequest.FilePath = fixture.Src
                  StartLine = 0; EndLine = 30 })
        let! r = fixture.Send("textDocument/inlayHint", payload)
        Assert.Null(r.Error)
        let hints = deserialize<InlayHintWire array>(r.Payload)
        Assert.NotNull(hints)
        Assert.NotEmpty(hints)
        for h in hints do
            Assert.False(String.IsNullOrEmpty(h.Label))
            Assert.True(h.Kind = 1 || h.Kind = 2)
            Assert.True(h.Line >= 0)
    }

    // ── Formatting (Fantomas) ───────────────────────────────────

    [<Fact>]
    member _.``formatting returns whole-document edit array``() = task {
        // The fixture file is canonically formatted, so Fantomas yields no edit;
        // either way the handler must serialize a (possibly empty) edit array.
        let! r = fixture.Send("textDocument/formatting", posPayload fixture.Src 0 0)
        Assert.Null(r.Error)
        let edits = deserialize<FormatEditWire array>(r.Payload)
        Assert.NotNull(edits)
    }

    [<Fact>]
    member _.``formatting reformats a poorly-spaced file``() = task {
        // Write a badly-formatted file and request whole-document formatting;
        // Fantomas must return exactly one whole-file replacement edit.
        let bad = Path.Combine(fixture.Dir, "Bad.fs")
        File.WriteAllText(bad, "module Bad\nlet    x=1\nlet  y   =   2\n")
        try
            let! r = fixture.Send("textDocument/formatting", posPayload bad 0 0)
            Assert.Null(r.Error)
            let edits = deserialize<FormatEditWire array>(r.Payload)
            Assert.Single(edits) |> ignore
            Assert.Equal(0, edits[0].StartLine)
            Assert.Equal(0, edits[0].StartCharacter)
            Assert.Contains("let x = 1", edits[0].NewText)
        finally
            try File.Delete(bad) with _ -> ()
    }

    [<Fact>]
    member _.``range formatting reformats a single line``() = task {
        let bad = Path.Combine(fixture.Dir, "Range.fs")
        File.WriteAllText(bad, "module Range\nlet   z   =   7\nlet w = 8\n")
        try
            let payload =
                MessagePackSerializer.Serialize(
                    { RangeRequest.FilePath = bad
                      StartLine = 1; StartCharacter = 0
                      EndLine = 1; EndCharacter = 16 })
            let! r = fixture.Send("textDocument/rangeFormatting", payload)
            Assert.Null(r.Error)
            let edits = deserialize<FormatEditWire array>(r.Payload)
            Assert.NotNull(edits)
            for e in edits do
                Assert.Equal(1, e.StartLine)
                Assert.Contains("z", e.NewText)
        finally
            try File.Delete(bad) with _ -> ()
    }

    // ── Semantic Tokens (full + range) ──────────────────────────

    [<Fact>]
    member _.``semantic tokens range returns delta-encoded subset``() = task {
        let payload =
            MessagePackSerializer.Serialize(
                { RangeRequest.FilePath = fixture.Src
                  StartLine = 0; StartCharacter = 0
                  EndLine = 6; EndCharacter = 0 })
        let! r = fixture.Send("textDocument/semanticTokens/range", payload)
        Assert.Null(r.Error)
        let ranged = deserialize<SemanticTokensResult>(r.Payload)
        Assert.NotNull(ranged.Data)
        // Token data is a flat array of 5-int groups.
        Assert.Equal(0, ranged.Data.Length % 5)
        // Full document has at least as many tokens as the restricted range.
        let! full = fixture.Send("textDocument/semanticTokens/full", posPayload fixture.Src 0 0)
        let fullTokens = deserialize<SemanticTokensResult>(full.Payload)
        Assert.True(ranged.Data.Length <= fullTokens.Data.Length)
    }

    // ── References (exclude declaration) ────────────────────────

    [<Fact>]
    member _.``references excludes declaration when not requested``() = task {
        let withDecl =
            MessagePackSerializer.Serialize(
                { ReferencesRequest.FilePath = fixture.Src
                  Line = 6; Character = 4
                  IncludeDeclaration = true })
        let! r1 = fixture.Send("textDocument/references", withDecl)
        let l1 = deserialize<LocationListResult>(r1.Payload)
        let noDecl =
            MessagePackSerializer.Serialize(
                { ReferencesRequest.FilePath = fixture.Src
                  Line = 6; Character = 4
                  IncludeDeclaration = false })
        let! r2 = fixture.Send("textDocument/references", noDecl)
        let l2 = deserialize<LocationListResult>(r2.Payload)
        // Dropping the declaration removes at least one occurrence.
        Assert.True(l2.Locations.Length < l1.Locations.Length)
    }

    // ── Diagnostics with real compiler errors ───────────────────

    [<Fact>]
    member _.``diagnostics surfaces a real FCS error``() = task {
        // Open a throwaway project whose single source file references an
        // undefined name; the diagnostics handler must map the FCS error into a
        // wire DiagnosticResult. The fixture workspace is restored afterwards so
        // sibling tests keep seeing the canonical project.
        let badDir = Path.Combine(Path.GetTempPath(), $"sharplsp-diag-{Guid.NewGuid():N}")
        Directory.CreateDirectory(badDir) |> ignore
        let badSrc = Path.Combine(badDir, "Broken.fs")
        File.WriteAllText(
            Path.Combine(badDir, "Broken.fsproj"),
            """<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <DisableImplicitFSharpCoreReference>true</DisableImplicitFSharpCoreReference>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Broken.fs" />
  </ItemGroup>
</Project>""")
        File.WriteAllText(badSrc, "module Broken\nlet x = NoSuchSymbol 1\n")
        try
            let! openResp = fixture.Send("workspace/open", MessagePackSerializer.Serialize(badDir))
            Assert.Null(openResp.Error)
            let payload = MessagePackSerializer.Serialize(badSrc)
            let! r = fixture.Send("workspace/diagnostics", payload)
            Assert.Null(r.Error)
            let diags = deserialize<DiagnosticResult array>(r.Payload)
            Assert.NotNull(diags)
            Assert.NotEmpty(diags)
            // Every diagnostic carries the file, a message, an FS-prefixed code,
            // and non-negative 0-based positions.
            for d in diags do
                Assert.Equal(badSrc, d.FilePath)
                Assert.False(String.IsNullOrEmpty(d.Message))
                Assert.StartsWith("FS", d.Code)
                Assert.True(d.StartLine >= 0)
            // At least one Error-severity diagnostic for the undefined symbol.
            Assert.Contains(diags, fun d -> d.Severity = "Error")
        finally
            // Restore the shared fixture workspace for the remaining tests.
            // A `finally` block is not part of the surrounding `task { }`
            // computation expression, so `let!` is invalid here (FS0750 on the
            // F# 10.0.3xx compiler). Await the restore synchronously instead.
            fixture
                .Send("workspace/open", MessagePackSerializer.Serialize(fixture.Dir))
                .GetAwaiter()
                .GetResult()
            |> ignore
            try Directory.Delete(badDir, true) with _ -> ()
    }

    // ── solution/read over IPC ──────────────────────────────────

    [<Fact>]
    member _.``solution read returns the project model for a real slnx``() = task {
        // The solution/read handler parses a real .slnx and returns its model.
        let slnx = Path.Combine(fixture.Dir, "Read.slnx")
        File.WriteAllText(
            slnx,
            """<Solution>
  <Project Path="TestProject.fsproj" />
</Solution>""")
        try
            let payload = MessagePackSerializer.Serialize(slnx)
            let! r = fixture.Send("solution/read", payload)
            Assert.Null(r.Error)
            // The payload deserializes into a model whose Projects include the
            // referenced .fsproj.
            let model = deserialize<SolutionModelWire>(r.Payload)
            Assert.NotNull(model.Projects)
            Assert.Contains(model.Projects, fun p -> p.Path.EndsWith("TestProject.fsproj"))
        finally
            try File.Delete(slnx) with _ -> ()
    }

    [<Fact>]
    member _.``solution read returns an error for a missing file``() = task {
        let missing = Path.Combine(fixture.Dir, "DoesNotExist.slnx")
        let payload = MessagePackSerializer.Serialize(missing)
        let! r = fixture.Send("solution/read", payload)
        // The reader reports an error which the handler surfaces on the envelope.
        Assert.NotNull(r.Error)
    }

    // ── Completion [FS-COMPLETION] ──────────────────────────────

    [<Fact>]
    member _.``completion after dot lists the member``() = task {
        // `greeter.Greet "World"` at line 28; completion just after the dot must
        // surface the IGreeter member `Greet`.
        let! r = fixture.Send("textDocument/completion", posPayload fixture.Src 28 12)
        Assert.Null(r.Error)
        let items = deserialize<CompletionItemResult array>(r.Payload)
        Assert.NotEmpty(items)
        Assert.Contains(items, fun i -> i.Label = "Greet")
    }

    [<Fact>]
    member _.``completion items carry a kind and index``() = task {
        let! r = fixture.Send("textDocument/completion", posPayload fixture.Src 28 12)
        Assert.Null(r.Error)
        let items = deserialize<CompletionItemResult array>(r.Payload)
        Assert.NotEmpty(items)
        for i in items do
            Assert.False(String.IsNullOrEmpty(i.Kind))
            Assert.True(i.Index >= 0)
    }

    [<Fact>]
    member _.``completion resolve returns empty additional edits``() = task {
        let payload =
            MessagePackSerializer.Serialize(
                { PositionRequest.FilePath = fixture.Src; Line = 0; Character = 0 })
        let! r = fixture.Send("completionItem/resolve", payload)
        Assert.Null(r.Error)
        let result = deserialize<CompletionResolveResultWire>(r.Payload)
        Assert.Empty(result.AdditionalEdits)
    }

    // ── References are project-wide [FS-REFS-PROJECT] ───────────

    [<Fact>]
    member _.``references span multiple files``() = task {
        // `add` is defined in Library.fs and used in both Library.fs and
        // Consumer.fs, so project-wide references must include both files.
        let payload =
            MessagePackSerializer.Serialize(
                { ReferencesRequest.FilePath = fixture.Src
                  Line = 6; Character = 4
                  IncludeDeclaration = true })
        let! r = fixture.Send("textDocument/references", payload)
        Assert.Null(r.Error)
        let loc = deserialize<LocationListResult>(r.Payload)
        Assert.Contains(loc.Locations, fun l -> l.FilePath.EndsWith("Consumer.fs"))
        Assert.Contains(loc.Locations, fun l -> l.FilePath.EndsWith("Library.fs"))
    }

    // ── Rename [FS-RENAME-PREPARE] / [FS-RENAME-APPLY] ──────────

    [<Fact>]
    member _.``prepare rename allows a project symbol``() = task {
        let! r = fixture.Send("textDocument/prepareRename", posPayload fixture.Src 6 4)
        Assert.Null(r.Error)
        let result = deserialize<PrepareRenameResultWire>(r.Payload)
        Assert.True(result.CanRename)
        Assert.Equal("add", result.Placeholder)
    }

    [<Fact>]
    member _.``rename rewrites every occurrence across files``() = task {
        let payload =
            MessagePackSerializer.Serialize(
                { RenameRequest.FilePath = fixture.Src
                  Line = 6; Character = 4
                  NewName = "sum" })
        let! r = fixture.Send("textDocument/rename", payload)
        Assert.Null(r.Error)
        let edit = deserialize<WorkspaceEditResult>(r.Payload)
        Assert.NotEmpty(edit.DocumentChanges)
        // The definition (Library.fs) and the cross-file use (Consumer.fs) both edit.
        Assert.Contains(edit.DocumentChanges, fun d -> d.FilePath.EndsWith("Consumer.fs"))
        Assert.Contains(edit.DocumentChanges, fun d -> d.FilePath.EndsWith("Library.fs"))
        let allEdits = edit.DocumentChanges |> Array.collect (fun d -> d.Edits)
        Assert.NotEmpty(allEdits)
        for e in allEdits do
            Assert.Equal("sum", e.NewText)
    }

    // ── Code Lens [FS-CODELENS] ─────────────────────────────────

    [<Fact>]
    member _.``code lens reports reference counts``() = task {
        let payload = MessagePackSerializer.Serialize({ FileRequest.FilePath = fixture.Src })
        let! r = fixture.Send("textDocument/codeLens", payload)
        Assert.Null(r.Error)
        let lenses = deserialize<CodeLensItemResult array>(r.Payload)
        Assert.NotEmpty(lenses)
        // Every lens title is an "N reference(s)" string and `add` (line 6) has one.
        for l in lenses do
            Assert.Contains("reference", l.Title)
        Assert.Contains(lenses, fun l -> l.Line = 6)
    }

    // ── Document Symbols [FS-DOCSYMBOL] ─────────────────────────

    [<Fact>]
    member _.``document symbols list types and nested members``() = task {
        let payload = MessagePackSerializer.Serialize({ FileRequest.FilePath = fixture.Src })
        let! r = fixture.Send("textDocument/documentSymbol", payload)
        Assert.Null(r.Error)
        let symbols = deserialize<DocumentSymbolResult array>(r.Payload)
        Assert.NotEmpty(symbols)
        // `Counter` (line 22+) is a class with `Value`/`Bump` members; its presence
        // with nested children proves the recursive wire mapping ran.
        Assert.Contains(symbols, fun s -> s.Name = "Counter")
        Assert.Contains(symbols, fun s -> s.Children.Length > 0)
    }

    // ── Signature Help [FS-SIGHELP] ─────────────────────────────

    [<Fact>]
    member _.``signature help surfaces a constructor overload``() = task {
        // `let counter = Counter(0)` — caret just inside the constructor parens.
        let lines = File.ReadAllText(fixture.Src).Replace("\r\n", "\n").Split('\n')
        let lineIdx = lines |> Array.findIndex (fun l -> l.Contains "Counter(0)")
        let col = lines[lineIdx].IndexOf("Counter(") + "Counter(".Length
        let! r = fixture.Send("textDocument/signatureHelp", posPayload fixture.Src lineIdx col)
        Assert.Null(r.Error)
        Assert.NotEqual<byte>([| 0xC0uy |], r.Payload)
        let help = deserialize<SignatureHelpResult>(r.Payload)
        Assert.NotEmpty(help.Signatures)
    }

    // ── Call Hierarchy [FS-CALLHIER-*] ──────────────────────────

    [<Fact>]
    member _.``prepare call hierarchy returns the function``() = task {
        let! r = fixture.Send("textDocument/prepareCallHierarchy", posPayload fixture.Src 6 4)
        Assert.Null(r.Error)
        Assert.NotEqual<byte>([| 0xC0uy |], r.Payload)
        let item = deserialize<HierarchyItemResult>(r.Payload)
        Assert.Equal("add", item.Name)
    }

    [<Fact>]
    member _.``incoming calls find the caller``() = task {
        // `add` is called from the `result` binding (Library) and `consumeAdd`
        // (Consumer); both enclosing declarations are incoming callers.
        let! r = fixture.Send("callHierarchy/incomingCalls", posPayload fixture.Src 6 4)
        Assert.Null(r.Error)
        let items = deserialize<HierarchyItemResult array>(r.Payload)
        Assert.NotEmpty(items)
        Assert.Contains(items, fun i -> i.Name = "consumeAdd")
    }

    [<Fact>]
    member _.``outgoing calls find the callee``() = task {
        // `useGreeter` (line 26) calls `Greet`.
        let! r = fixture.Send("callHierarchy/outgoingCalls", posPayload fixture.Src 26 4)
        Assert.Null(r.Error)
        let items = deserialize<HierarchyItemResult array>(r.Payload)
        Assert.NotEmpty(items)
        Assert.Contains(items, fun i -> i.Name = "Greet")
    }

    // ── Type Hierarchy [FS-TYPEHIER-*] ──────────────────────────

    [<Fact>]
    member _.``prepare type hierarchy returns the type``() = task {
        let! r = fixture.Send("textDocument/prepareTypeHierarchy", posPayload fixture.Src 22 5)
        Assert.Null(r.Error)
        Assert.NotEqual<byte>([| 0xC0uy |], r.Payload)
        let item = deserialize<HierarchyItemResult>(r.Payload)
        Assert.Equal("SimpleGreeter", item.Name)
    }

    [<Fact>]
    member _.``supertypes include the implemented interface``() = task {
        let! r = fixture.Send("typeHierarchy/supertypes", posPayload fixture.Src 22 5)
        Assert.Null(r.Error)
        let items = deserialize<HierarchyItemResult array>(r.Payload)
        Assert.Contains(items, fun i -> i.Name = "IGreeter")
    }

    [<Fact>]
    member _.``subtypes include the implementing type``() = task {
        let! r = fixture.Send("typeHierarchy/subtypes", posPayload fixture.Src 19 5)
        Assert.Null(r.Error)
        let items = deserialize<HierarchyItemResult array>(r.Payload)
        Assert.Contains(items, fun i -> i.Name = "SimpleGreeter")
    }

// ── Workspace-level tests (real FCS, no IPC) ────────────────────

[<Fact>]
let ``workspace returns None for all queries when not loaded`` () = task {
    let st = FSharpWorkspace.create ()
    let! h = FSharpWorkspace.getHover st "/x.fs" 0 0
    Assert.True(h.IsNone)
    let! d = FSharpWorkspace.getDefinition st "/x.fs" 0 0
    Assert.True(d.IsNone)
    let! t = FSharpWorkspace.getTypeDefinition st "/x.fs" 0 0
    Assert.True(t.IsNone)
    let! dc = FSharpWorkspace.getDeclaration st "/x.fs" 0 0
    Assert.True(dc.IsNone)
    let! im = FSharpWorkspace.getImplementations st "/x.fs" 0 0
    Assert.Empty(im)
}

[<Fact>]
let ``loadProject with missing fsproj returns error`` () = task {
    let st = FSharpWorkspace.create ()
    let empty = Path.Combine(Path.GetTempPath(), $"sharplsp-empty-{Guid.NewGuid():N}")
    Directory.CreateDirectory(empty) |> ignore
    try
        let! r = FSharpWorkspace.loadProject st empty
        match r with
        | Error msg -> Assert.Contains("No .fsproj", msg)
        | Ok () -> Assert.Fail("Should fail for missing .fsproj")
    finally
        try Directory.Delete(empty, true) with _ -> ()
}
