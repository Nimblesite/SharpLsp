/// Code completion for the F# sidecar via FCS GetDeclarationListInfo.
/// Implements [FS-COMPLETION] / [FS-COMPLETION-RESOLVE] from
/// docs/plans/FSHARP-FEATURES-PLAN.md.
module SharpLsp.Sidecar.FSharp.FSharpCompletion

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
      Index: int }

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

/// Convert one FCS declaration item to a domain completion entry.
let private toEntry (index: int) (item: DeclarationListItem) : CompletionEntry =
    { Label = item.NameInList
      Kind = glyphToKind item.Glyph
      Detail = detailFor item
      InsertText = item.NameInCode
      Index = index }

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
                let lines = source.Split('\n')
                if line >= lines.Length then
                    return []
                else
                    let lineText = lines[line]
                    // GetPartialLongNameEx wants the 0-based index of the last
                    // character before the caret; the caret sits at `character`.
                    let index = min (character - 1) (lineText.Length - 1)
                    let partialName = QuickParse.GetPartialLongNameEx(lineText, index)
                    let info =
                        checkResults.GetDeclarationListInfo(
                            Some parseResults, line + 1, lineText, partialName, (fun () -> []))
                    return info.Items |> Array.mapi toEntry |> Array.toList
        with ex ->
            Log.Debug(ex, "[F# Completion] failed")
            return []
    }
