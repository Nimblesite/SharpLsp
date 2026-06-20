/// F# sidecar: hosts FSharp.Compiler.Service.
/// Registers handlers for workspace loading, hover, etc.
namespace SharpLsp.Sidecar.FSharp

open System
open System.Threading
open System.Threading.Tasks
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Solutions
open MessagePack

type ByteResult = Outcome.Result<byte[], string>

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type PositionRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Line: int
      [<Key(2)>] Character: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type HoverResult =
    { [<Key(0)>] Contents: string
      [<Key(1)>] StartLine: Nullable<int>
      [<Key(2)>] StartCharacter: Nullable<int>
      [<Key(3)>] EndLine: Nullable<int>
      [<Key(4)>] EndCharacter: Nullable<int> }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type LocationResult =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Line: int
      [<Key(2)>] Character: int
      [<Key(3)>] EndLine: int
      [<Key(4)>] EndCharacter: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type LocationListResult =
    { [<Key(0)>] Locations: LocationResult array }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type ReferencesRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Line: int
      [<Key(2)>] Character: int
      [<Key(3)>] IncludeDeclaration: bool }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type DocumentHighlightResult =
    { [<Key(0)>] StartLine: int
      [<Key(1)>] StartCharacter: int
      [<Key(2)>] EndLine: int
      [<Key(3)>] EndCharacter: int
      [<Key(4)>] Kind: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type DocumentHighlightListResult =
    { [<Key(0)>] Highlights: DocumentHighlightResult array }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type InlayHintRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] StartLine: int
      [<Key(2)>] EndLine: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type RangeRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] StartLine: int
      [<Key(2)>] StartCharacter: int
      [<Key(3)>] EndLine: int
      [<Key(4)>] EndCharacter: int }

// ── Code Action Types (wire-compatible with C# sidecar) ─────────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CodeActionRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] StartLine: int
      [<Key(2)>] StartCharacter: int
      [<Key(3)>] EndLine: int
      [<Key(4)>] EndCharacter: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CodeActionItemResult =
    { [<Key(0)>] Id: int
      [<Key(1)>] Title: string
      [<Key(2)>] Kind: string
      [<Key(3)>] IsPreferred: bool }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CodeActionResolveRequest =
    { [<Key(0)>] Id: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type TextEditResult =
    { [<Key(0)>] StartLine: int
      [<Key(1)>] StartCharacter: int
      [<Key(2)>] EndLine: int
      [<Key(3)>] EndCharacter: int
      [<Key(4)>] NewText: string }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type DocumentEditResult =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Edits: TextEditResult array }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type WorkspaceEditResult =
    { [<Key(0)>] DocumentChanges: DocumentEditResult array }

// ── Diagnostics Types (wire-compatible with C# sidecar) ─────────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type DiagnosticResult =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] StartLine: int
      [<Key(2)>] StartCharacter: int
      [<Key(3)>] EndLine: int
      [<Key(4)>] EndCharacter: int
      [<Key(5)>] Message: string
      [<Key(6)>] Severity: string
      [<Key(7)>] Code: string }

// ── Formatting Preview Types ────────────────────────────────────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type FormattingPreviewResult =
    { [<Key(0)>] Original: string
      [<Key(1)>] Formatted: string }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type SemanticTokensResult =
    { [<Key(0)>] Data: int array }

// Implements [PKG-UNUSED-DETECT-FS] — wire-compatible with the C# sidecar's
// ReferenceUsageResult (positional MessagePack keys).
[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type ReferenceUsageResult =
    { [<Key(0)>] UsedPaths: string array
      [<Key(1)>] AllPaths: string array
      [<Key(2)>] PackagesRoot: string }

module private Helpers =
    /// Convert a FSharpWorkspace.DefinitionLocation to a LocationResult.
    let toLocationResult (loc: FSharpWorkspace.DefinitionLocation) : LocationResult =
        { FilePath = loc.FilePath
          Line = loc.Line
          Character = loc.Character
          EndLine = loc.EndLine
          EndCharacter = loc.EndCharacter }

    /// Serialize a value to a successful ByteResult.
    let serializeOk<'T> (value: 'T) (ct: CancellationToken) : ByteResult =
        let bytes = MessagePackSerializer.Serialize(value, cancellationToken = ct)
        Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult

    /// Build a location handler for workspace methods returning a single optional location.
    let locationOptionHandler
        (workspace: FSharpWorkspace.FSharpWorkspaceState)
        (getLocation: FSharpWorkspace.FSharpWorkspaceState -> string -> int -> int -> Task<FSharpWorkspace.DefinitionLocation option>)
        : Func<byte[], CancellationToken, Task<ByteResult>> =
        Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! result = getLocation workspace request.FilePath request.Line request.Character
                    match result with
                    | Some loc ->
                        return serializeOk { Locations = [| toLocationResult loc |] } ct
                    | None ->
                        return serializeOk { Locations = [||] } ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            })

    /// Build a location handler for workspace methods returning a list of locations.
    let locationListHandler
        (workspace: FSharpWorkspace.FSharpWorkspaceState)
        (getLocations: FSharpWorkspace.FSharpWorkspaceState -> string -> int -> int -> Task<FSharpWorkspace.DefinitionLocation list>)
        : Func<byte[], CancellationToken, Task<ByteResult>> =
        Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! results = getLocations workspace request.FilePath request.Line request.Character
                    let locations = results |> List.map toLocationResult |> Array.ofList
                    return serializeOk { Locations = locations } ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            })

type FSharpSidecar() =
    inherit SidecarHost("fsharp")

    let workspace = FSharpWorkspace.create ()
    let codeFixState = FSharpCodeFixes.createState ()

    do
        base.Register("workspace/open", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let! result = FSharpWorkspace.loadProjectWithCancellation workspace path ct
                    match result with
                    | Ok () ->
                        return Helpers.serializeOk "ok" ct
                    | Error msg ->
                        return ByteResult.Failure(msg)
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("solution/read", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let! result = SolutionFileReader.ReadAsync(path, ct)
                    if result.IsError then
                        return ByteResult.Failure(result.Match((fun _ -> String.Empty), (fun err -> err)))
                    else
                        let model = result.Match((fun value -> value), (fun err -> invalidOp err))
                        return Helpers.serializeOk model ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("workspace/status", Func<byte[], CancellationToken, Task<ByteResult>>(fun _payload ct ->
            try
                let status = if workspace.IsLoaded then "loaded" else "not_loaded"
                Task.FromResult<ByteResult>(Helpers.serializeOk status ct)
            with ex ->
                Task.FromResult<ByteResult>(ByteResult.Failure(ex.Message))))

        base.Register("textDocument/hover", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! hover = FSharpWorkspace.getHover workspace request.FilePath request.Line request.Character
                    match hover with
                    | Some (markdown, sl, sc, el, ec) ->
                        let result =
                            { Contents = markdown
                              StartLine = Nullable sl
                              StartCharacter = Nullable sc
                              EndLine = Nullable el
                              EndCharacter = Nullable ec }
                        return Helpers.serializeOk result ct
                    | None ->
                        // Return MessagePack nil (0xC0) for no hover result.
                        let bytes = [| 0xC0uy |]
                        return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Unused-package detection [PKG-UNUSED-DETECT-FS].
        base.Register("project/unusedPackages", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let projectPath = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let! usage = FSharpPackages.getReferenceUsage workspace projectPath
                    let result =
                        { UsedPaths = usage.Used
                          AllPaths = usage.All
                          PackagesRoot = usage.Root }
                    return Helpers.serializeOk result ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("textDocument/definition", Helpers.locationOptionHandler workspace FSharpWorkspace.getDefinition)
        base.Register("textDocument/typeDefinition", Helpers.locationOptionHandler workspace FSharpWorkspace.getTypeDefinition)
        base.Register("textDocument/declaration", Helpers.locationOptionHandler workspace FSharpWorkspace.getDeclaration)
        base.Register("textDocument/implementation", Helpers.locationListHandler workspace FSharpWorkspace.getImplementations)

        // References
        base.Register("textDocument/references", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<ReferencesRequest>(payload, cancellationToken = ct)
                    let! results =
                        FSharpReferences.getReferences
                            workspace request.FilePath request.Line
                            request.Character request.IncludeDeclaration
                    let locations =
                        results
                        |> List.map Helpers.toLocationResult
                        |> Array.ofList
                    return Helpers.serializeOk { Locations = locations } ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Document highlights
        base.Register("textDocument/documentHighlight", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! results =
                        FSharpReferences.getDocumentHighlights
                            workspace request.FilePath request.Line request.Character
                    let highlights =
                        results
                        |> List.map (fun h ->
                            { DocumentHighlightResult.StartLine = h.StartLine
                              StartCharacter = h.StartCharacter
                              EndLine = h.EndLine
                              EndCharacter = h.EndCharacter
                              Kind = h.Kind })
                        |> Array.ofList
                    return Helpers.serializeOk { Highlights = highlights } ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Formatting via Fantomas
        base.Register("textDocument/formatting", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! edits = FSharpFeatures.formatDocument request.FilePath
                    let bytes = MessagePackSerializer.Serialize(edits, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Range formatting via Fantomas
        base.Register("textDocument/rangeFormatting", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<RangeRequest>(payload, cancellationToken = ct)
                    let! edits = FSharpFeatures.formatRange request.FilePath request.StartLine request.StartCharacter request.EndLine request.EndCharacter
                    let bytes = MessagePackSerializer.Serialize(edits, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Semantic tokens
        base.Register("textDocument/semanticTokens/full", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! data = FSharpFeatures.getSemanticTokens workspace request.FilePath
                    let bytes = MessagePackSerializer.Serialize({ Data = data }, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Semantic tokens range
        base.Register("textDocument/semanticTokens/range", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<RangeRequest>(payload, cancellationToken = ct)
                    let! data = FSharpFeatures.getSemanticTokensRange workspace request.FilePath request.StartLine request.EndLine
                    let bytes = MessagePackSerializer.Serialize({ Data = data }, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Code actions (F# code fixes via FCS diagnostics)
        base.Register("textDocument/codeAction", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<CodeActionRequest>(payload, cancellationToken = ct)
                    let! actions =
                        FSharpCodeFixes.getCodeActions
                            codeFixState workspace
                            request.FilePath
                            request.StartLine request.StartCharacter
                            request.EndLine request.EndCharacter
                    let results =
                        actions
                        |> List.map (fun a ->
                            { Id = a.Id; Title = a.Title
                              Kind = a.Kind; IsPreferred = a.IsPreferred })
                        |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Code action resolve
        base.Register("codeAction/resolve", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            try
                let request = MessagePackSerializer.Deserialize<CodeActionResolveRequest>(payload, cancellationToken = ct)
                match FSharpCodeFixes.resolveCodeAction codeFixState request.Id with
                | Some edit ->
                    let result =
                        { DocumentChanges =
                            edit.DocumentChanges
                            |> List.map (fun dc ->
                                { FilePath = dc.FilePath
                                  Edits =
                                    dc.Edits
                                    |> List.map (fun e ->
                                        { StartLine = e.StartLine
                                          StartCharacter = e.StartCharacter
                                          EndLine = e.EndLine
                                          EndCharacter = e.EndCharacter
                                          NewText = e.NewText })
                                    |> Array.ofList })
                            |> Array.ofList }
                    Task.FromResult<ByteResult>(Helpers.serializeOk result ct)
                | None ->
                    let empty = { DocumentChanges = [||] }
                    Task.FromResult<ByteResult>(Helpers.serializeOk empty ct)
            with ex ->
                Task.FromResult<ByteResult>(ByteResult.Failure(ex.Message))))

        // Inlay hints
        base.Register("textDocument/inlayHint", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<InlayHintRequest>(payload, cancellationToken = ct)
                    let! hints = FSharpFeatures.getInlayHints workspace request.FilePath request.StartLine request.EndLine
                    let bytes = MessagePackSerializer.Serialize(hints |> List.toArray, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Diagnostics (FCS compiler errors + FSharpLint warnings)
        base.Register("workspace/diagnostics", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let filePath = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let mutable results = ResizeArray<DiagnosticResult>()
                    // FCS compiler diagnostics.
                    if workspace.IsLoaded then
                        let source = System.IO.File.ReadAllText(filePath)
                        let sourceText = FSharp.Compiler.Text.SourceText.ofString source
                        let! _parse, checkAnswer =
                            workspace.Checker.ParseAndCheckFileInProject(
                                filePath, 0, sourceText, workspace.ProjectOptions.Value)
                        match checkAnswer with
                        | FSharp.Compiler.CodeAnalysis.FSharpCheckFileAnswer.Succeeded check ->
                            for d in check.Diagnostics do
                                let severity =
                                    match d.Severity with
                                    | FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Error -> "Error"
                                    | FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Warning -> "Warning"
                                    | FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Info -> "Info"
                                    | _ -> "Hint"
                                let r = d.Range
                                results.Add(
                                    { FilePath = filePath
                                      StartLine = r.StartLine - 1
                                      StartCharacter = r.StartColumn
                                      EndLine = r.EndLine - 1
                                      EndCharacter = r.EndColumn
                                      Message = d.Message
                                      Severity = severity
                                      Code = $"FS{d.ErrorNumber:D4}" })
                        | FSharp.Compiler.CodeAnalysis.FSharpCheckFileAnswer.Aborted -> ()
                    // FSharpLint diagnostics.
                    let lintDiags = FSharpLinting.lintFile filePath
                    for ld in lintDiags do
                        results.Add(
                            { FilePath = ld.FilePath
                              StartLine = ld.StartLine
                              StartCharacter = ld.StartCharacter
                              EndLine = ld.EndLine
                              EndCharacter = ld.EndCharacter
                              Message = ld.Message
                              Severity = ld.Severity
                              Code = ld.Code })
                    return Helpers.serializeOk (results.ToArray()) ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Formatting preview (Fantomas diff)
        base.Register("textDocument/formattingPreview", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! preview = FSharpFeatures.formatPreview request.FilePath
                    match preview with
                    | Some result ->
                        return Helpers.serializeOk { Original = result.Original; Formatted = result.Formatted } ct
                    | None ->
                        let bytes = [| 0xC0uy |]
                        return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))
