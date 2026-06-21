/// MessagePack wire-contract types and serialization helpers for the F#
/// sidecar. Positional [<Key(n)>] layouts mirror the Rust host's structs.
namespace SharpLsp.Sidecar.FSharp

open System
open System.Threading
open System.Threading.Tasks
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

// ── Completion Types (wire-compatible with the Rust host) ───────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CompletionItemResult =
    { [<Key(0)>] Label: string
      [<Key(1)>] Kind: string
      [<Key(2)>] Detail: string
      [<Key(3)>] InsertText: string
      [<Key(4)>] Index: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CompletionResolveResultWire =
    { [<Key(0)>] AdditionalEdits: TextEditResult array }

// ── Code Lens Types ─────────────────────────────────────────────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type FileRequest = { [<Key(0)>] FilePath: string }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CodeLensItemResult =
    { [<Key(0)>] Line: int
      [<Key(1)>] Character: int
      [<Key(2)>] Title: string }

// ── Hierarchy Types (call + type hierarchy share this layout) ───

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type HierarchyItemResult =
    { [<Key(0)>] Name: string
      [<Key(1)>] Kind: string
      [<Key(2)>] FilePath: string
      [<Key(3)>] Line: int
      [<Key(4)>] Character: int
      [<Key(5)>] EndLine: int
      [<Key(6)>] EndCharacter: int }

// ── Rename Types (wire-compatible with the Rust host) ───────────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type RenameRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Line: int
      [<Key(2)>] Character: int
      [<Key(3)>] NewName: string }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type PrepareRenameResultWire =
    { [<Key(0)>] CanRename: bool
      [<Key(1)>] StartLine: int
      [<Key(2)>] StartCharacter: int
      [<Key(3)>] EndLine: int
      [<Key(4)>] EndCharacter: int
      [<Key(5)>] Placeholder: string }

module internal Helpers =
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

    /// MessagePack nil (0xC0) — the "no value" response shared by optional results.
    let nilResult () : ByteResult =
        Outcome.Result<byte[], string>.Ok<byte[], string>([| 0xC0uy |])

    /// Map a hierarchy domain item to its wire shape (call + type hierarchy).
    let toHierItem (item: FSharpHierarchy.HierItem) : HierarchyItemResult =
        { Name = item.Name
          Kind = item.Kind
          FilePath = item.FilePath
          Line = item.Line
          Character = item.Character
          EndLine = item.EndLine
          EndCharacter = item.EndCharacter }

    /// Map a completion domain entry to its wire shape (None detail → nil).
    let toCompletionItem (entry: FSharpCompletion.CompletionEntry) : CompletionItemResult =
        { Label = entry.Label
          Kind = entry.Kind
          Detail = (match entry.Detail with Some value -> value | None -> Unchecked.defaultof<string>)
          InsertText = entry.InsertText
          Index = entry.Index }

    /// Group flat rename edits into a per-document workspace edit.
    let toWorkspaceEdit (edits: FSharpCodeActions.RawEdit list) : WorkspaceEditResult =
        let documentChanges =
            edits
            |> List.groupBy (fun (edit: FSharpCodeActions.RawEdit) -> edit.FilePath)
            |> List.map (fun (filePath, fileEdits) ->
                { FilePath = filePath
                  Edits =
                    fileEdits
                    |> List.map (fun edit ->
                        { StartLine = edit.StartLine
                          StartCharacter = edit.StartCharacter
                          EndLine = edit.EndLine
                          EndCharacter = edit.EndCharacter
                          NewText = edit.NewText })
                    |> Array.ofList })
            |> Array.ofList
        { DocumentChanges = documentChanges }
