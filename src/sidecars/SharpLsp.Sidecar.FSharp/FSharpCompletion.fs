/// Code completion for the F# sidecar via FCS GetDeclarationListInfo.
/// Completion and resolve portion of [SHARPLSP-FEATURES-INTELLIGENCE].
module SharpLsp.Sidecar.FSharp.FSharpCompletion

open System.Collections.Concurrent
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Tokenization
open SharpLsp.Sidecar.Common
open Serilog

/// A completion item in the sidecar's neutral domain shape. The handler maps
/// this to the MessagePack wire type (see FSharpSidecar.CompletionItemResult),
/// which is positionally compatible with the Rust host's SidecarCompletionItem.
type CompletionEntry =
    { Label: string
      Kind: string
      Detail: string option
      InsertText: string
      Index: int
      /// 0-based line/character span the accepted item REPLACES, so it is not
      /// appended to the identifier at the caret (`product.PricePrice`). #178.
      EditStartLine: int
      EditStartCharacter: int
      EditEndLine: int
      EditEndCharacter: int }

/// Map an FCS glyph to the kind strings the Rust host's `map_completion_kind`
/// understands (see src/sharplsp/src/semantic.rs). Anything unmapped falls back to "Keyword".
let private glyphToKind (glyph: FSharpGlyph) : string =
    match glyph with
    | FSharpGlyph.Class
    | FSharpGlyph.Typedef
    | FSharpGlyph.Type
    | FSharpGlyph.Exception -> "Class"
    | FSharpGlyph.Struct -> "Struct"
    | FSharpGlyph.Interface -> "Interface"
    | FSharpGlyph.Enum -> "Enum"
    | FSharpGlyph.EnumMember -> "EnumMember"
    | FSharpGlyph.Union -> "EnumMember"
    | FSharpGlyph.Delegate -> "Delegate"
    | FSharpGlyph.Module
    | FSharpGlyph.NameSpace -> "Namespace"
    | FSharpGlyph.Method
    | FSharpGlyph.OverridenMethod
    | FSharpGlyph.ExtensionMethod -> "Method"
    | FSharpGlyph.Property -> "Property"
    | FSharpGlyph.Field -> "Field"
    | FSharpGlyph.Event -> "Event"
    | FSharpGlyph.Constant -> "Constant"
    | FSharpGlyph.Variable -> "Local"
    | FSharpGlyph.TypeParameter -> "TypeParameter"
    | _ -> "Keyword"

/// Build the detail hint, mirroring C#'s "(import) <ns>" for unopened
/// namespaces — F# surfaces "(open <ns>)" via DeclarationListItem.NamespaceToOpen.
let private detailFor (item: DeclarationListItem) : string option =
    match item.NamespaceToOpen with
    | Some ns when not (System.String.IsNullOrEmpty ns) -> Some $"(open {ns})"
    | _ -> None

/// F# identifier-continuation characters, used to grow the replacement span over
/// any member name already present after the caret (mirrors the compiler lexer).
let private isIdentifierPart (c: char) =
    System.Char.IsLetterOrDigit c || c = '_' || c = '\''

/// 0-based line/character span the accepted item must REPLACE: the typed partial
/// identifier to the LEFT of the caret plus any identifier characters that already
/// follow it on the same line. Prevents `product.PricePrice` (GitHub #178).
/// Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
let private editSpanFor (lineText: string) (line: int) (character: int) (partialIdent: string) =
    let startCharacter = max 0 (character - partialIdent.Length)
    let mutable endCharacter = min character lineText.Length
    while endCharacter < lineText.Length && isIdentifierPart lineText[endCharacter] do
        endCharacter <- endCharacter + 1
    (line, startCharacter, line, endCharacter)

/// Convert one FCS declaration item to a domain completion entry, stamping the
/// shared replacement span so acceptance replaces (not appends) the identifier.
let private toEntry
    (spanLine: int, spanStart: int, spanEndLine: int, spanEnd: int)
    (index: int)
    (item: DeclarationListItem)
    : CompletionEntry =
    { Label = item.NameInList
      Kind = glyphToKind item.Glyph
      Detail = detailFor item
      InsertText = item.NameInCode
      Index = index
      EditStartLine = spanLine
      EditStartCharacter = spanStart
      EditEndLine = spanEndLine
      EditEndCharacter = spanEnd }

/// The namespace each item of a file's last completion must open, by item index, and
/// the 0-based line the completion was asked on: what resolving an item turns into
/// its `open`. [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-OPEN]
[<NoComparison; NoEquality>]
type private PendingOpens = { Line: int; Namespaces: Map<int, string> }

/// The last completion's pending opens, by file.
let private pendingOpens = ConcurrentDictionary<string, PendingOpens>(NativePaths.Comparer)

/// The namespace each listed item from an unopened namespace needs, by its index.
let private namespacesToOpen (listed: (int * DeclarationListItem) array) : Map<int, string> =
    listed
    |> Array.choose (fun (index, item) -> item.NamespaceToOpen |> Option.map (fun ns -> index, ns))
    |> Map.ofArray

/// Whether completion keeps `item`: every item in scope, and one from a namespace the
/// file has not opened only once a prefix is typed and its name starts with it. The
/// project's references hold thousands of such names, so the list stays the size
/// of what the typed prefix can mean.
let private keeps (prefix: string) (item: DeclarationListItem) =
    item.NamespaceToOpen.IsNone
    || (prefix <> "" && item.NameInList.StartsWith(prefix, System.StringComparison.OrdinalIgnoreCase))

/// Build completion entries from a completed FCS check, with the entities of the
/// namespaces the file has not opened, and the namespace each such entry needs.
/// Kept synchronous and out of the `task` state machine in `getCompletions` so
/// that block stays statically compilable (FS3511) as the mapping logic grows.
let private buildEntries
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (parseResults: FSharpParseFileResults)
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : CompletionEntry list * Map<int, string> =
    let lines = source.Split('\n')
    if line >= lines.Length then
        [], Map.empty
    else
        let lineText = lines[line]
        let entities = FSharpEntityIndex.entities state checkResults
        let partialName, items = FSharpLocalAnalysis.declarationsAt parseResults checkResults entities lineText line character
        let span = editSpanFor lineText line character partialName.PartialIdent
        let kept = items |> Array.indexed |> Array.filter (snd >> keeps partialName.PartialIdent)
        (kept |> Array.map (fun (index, item) -> toEntry span index item) |> Array.toList), namespacesToOpen kept

/// Get completion items at a 0-based position in an F# file, remembering the
/// namespace each one from an unopened namespace must open.
let getCompletions
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! checkData = FSharpWorkspace.checkFileWithParse state filePath
            match checkData with
            | None -> return []
            | Some(parseResults, checkResults, source) ->
                let entries, namespaces = buildEntries state parseResults checkResults source line character
                pendingOpens[filePath] <- { Line = line; Namespaces = namespaces }
                return entries
        with ex ->
            Log.Debug(ex, "[F# Completion] failed")
            return []
    }

/// The `open` that item `index` of `filePath`'s last completion needs, placed where
/// FCS puts an `open` serving the completion's line: none when the item's
/// namespace is already open, or that completion is gone.
/// [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-OPEN]
let resolve (state: FSharpWorkspace.FSharpWorkspaceState) (filePath: string) (index: int) =
    task {
        match pendingOpens.TryGetValue filePath with
        | true, last when last.Namespaces.ContainsKey index ->
            let namespaceName = last.Namespaces[index]
            let! checkData = FSharpWorkspace.checkFileWithParse state filePath
            return
                checkData
                |> Option.map (fun (parseResults, _, source) ->
                    let line = FSharpLocalAnalysis.lineGetter source
                    let at = FSharpQuickFix.openPosition parseResults line (last.Line + 1) (namespaceName.Split '.')
                    [ FSharpQuickFix.lineInsertion filePath at $"open {namespaceName}" ])
                |> Option.defaultValue []
        | _ -> return []
    }
