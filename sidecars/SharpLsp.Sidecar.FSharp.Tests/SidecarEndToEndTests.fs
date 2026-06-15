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

[<MessagePackObject>]
[<NoComparison; NoEquality>]
type InlayHintWire =
    { [<Key("Line")>] Line: int
      [<Key("Character")>] Character: int
      [<Key("Label")>] Label: string
      [<Key("Kind")>] Kind: int }

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
"""

/// Create a temp directory with a real .fsproj and F# source file.
let private createTestProject () =
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
  </ItemGroup>
</Project>""")
    File.WriteAllText(Path.Combine(dir, "Library.fs"), testSource)
    dir

/// Deserialize a MessagePack byte[] payload to the target type.
let private deserialize<'T> (payload: byte array) : 'T =
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
let private posPayload file line char =
    MessagePackSerializer.Serialize(
        { PositionRequest.FilePath = file; Line = line; Character = char })

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

    [<Fact>]
    member _.``code action resolve returns workspace edit for unknown id``() = task {
        let payload =
            MessagePackSerializer.Serialize({ CodeActionResolveRequest.Id = -1 })
        let! r = fixture.Send("codeAction/resolve", payload)
        Assert.Null(r.Error)
        let edit = deserialize<WorkspaceEditResult>(r.Payload)
        Assert.Empty(edit.DocumentChanges)
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
            let! _ = fixture.Send("workspace/open", MessagePackSerializer.Serialize(fixture.Dir))
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
