/// Code completion for the F# sidecar via FCS GetDeclarationListInfo.
/// Implements [FS-COMPLETION] / [FS-COMPLETION-RESOLVE] from
/// docs/plans/FSHARP-FEATURES-PLAN.md.
module SharpLsp.Sidecar.FSharp.FSharpCompletion

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Tokenization
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
/// understands (see src/semantic.rs). Anything unmapped falls back to "Keyword".
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
/// Implements [COMPLETION-EDIT-REPLACE].
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

/// Build completion entries from a completed FCS check. Kept synchronous and out
/// of the `task` state machine in `getCompletions` so that block stays statically
/// compilable (FS3511) as the mapping logic grows.
let private buildEntries
    (parseResults: FSharpParseFileResults)
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : CompletionEntry list =
    let lines = source.Split('\n')
    if line >= lines.Length then
        []
    else
        let lineText = lines[line]
        // GetPartialLongNameEx wants the 0-based index of the last character before
        // the caret; the caret sits at `character`.
        let index = min (character - 1) (lineText.Length - 1)
        let partialName = QuickParse.GetPartialLongNameEx(lineText, index)
        let span = editSpanFor lineText line character partialName.PartialIdent
        let info =
            checkResults.GetDeclarationListInfo(
                Some parseResults, line + 1, lineText, partialName, (fun () -> []))
        info.Items |> Array.mapi (toEntry span) |> Array.toList

/// Get completion items at a 0-based position in an F# file.
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
                return buildEntries parseResults checkResults source line character
        with ex ->
            Log.Debug(ex, "[F# Completion] failed")
            return []
    }
