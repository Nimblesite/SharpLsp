/// Document symbols for the F# sidecar via FCS GetNavigationItems.
/// Purely syntactic (parse-only) so it responds without a cracked project —
/// matching the host's "syntax-only" latency budget for textDocument/documentSymbol.
/// Implements [FS-DOCSYMBOL].
module SharpLsp.Sidecar.FSharp.FSharpSymbols

open System.IO
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Text
open Serilog

/// A document symbol in the sidecar's neutral domain shape. Maps onto the wire
/// DocumentSymbolResult, which the Rust host turns into an LSP DocumentSymbol.
/// Ranges are 0-based; `Sel*` is the identifier (selectionRange), the outer
/// range is the whole declaration body and always contains the selection.
type SymbolItem =
    { Name: string
      Kind: string
      StartLine: int
      StartCharacter: int
      EndLine: int
      EndCharacter: int
      SelStartLine: int
      SelStartCharacter: int
      SelEndLine: int
      SelEndCharacter: int
      Children: SymbolItem list }

/// Map an FCS glyph to a capitalized kind string the Rust host understands
/// (see `parse_document_symbol_kind` in src/document_symbols.rs).
let private kindOfGlyph (glyph: FSharpGlyph) : string =
    match glyph with
    | FSharpGlyph.Module
    | FSharpGlyph.NameSpace -> "Module"
    | FSharpGlyph.Class
    | FSharpGlyph.Type
    | FSharpGlyph.Typedef
    | FSharpGlyph.Exception -> "Class"
    | FSharpGlyph.Interface -> "Interface"
    | FSharpGlyph.Struct -> "Struct"
    | FSharpGlyph.Enum -> "Enum"
    | FSharpGlyph.EnumMember -> "EnumMember"
    | FSharpGlyph.Union -> "Enum"
    | FSharpGlyph.Delegate -> "Function"
    | FSharpGlyph.Method
    | FSharpGlyph.OverridenMethod
    | FSharpGlyph.ExtensionMethod -> "Function"
    | FSharpGlyph.Property -> "Property"
    | FSharpGlyph.Field -> "Field"
    | FSharpGlyph.Constant -> "Constant"
    | FSharpGlyph.Variable -> "Variable"
    | FSharpGlyph.TypeParameter -> "TypeParameter"
    | _ -> "Field"

/// Smaller of two source positions (line, then column).
let private posMin (a: pos) (b: pos) : pos =
    if a.Line < b.Line || (a.Line = b.Line && a.Column <= b.Column) then a else b

/// Larger of two source positions (line, then column).
let private posMax (a: pos) (b: pos) : pos =
    if a.Line > b.Line || (a.Line = b.Line && a.Column >= b.Column) then a else b

/// Build a SymbolItem from a navigation item and its already-mapped children.
/// The outer range is the union of the identifier range and the body range so
/// it always contains the selection (LSP requires selectionRange ⊆ range).
let private toItem (children: SymbolItem list) (nav: NavigationItem) : SymbolItem =
    let ident = nav.Range
    let body = nav.BodyRange
    let outerStart = posMin ident.Start body.Start
    let outerEnd = posMax ident.End body.End
    { Name = nav.LogicalName
      Kind = kindOfGlyph nav.Glyph
      StartLine = outerStart.Line - 1
      StartCharacter = outerStart.Column
      EndLine = outerEnd.Line - 1
      EndCharacter = outerEnd.Column
      SelStartLine = ident.StartLine - 1
      SelStartCharacter = ident.StartColumn
      SelEndLine = ident.EndLine - 1
      SelEndCharacter = ident.EndColumn
      Children = children }

/// Map one top-level declaration (and its nested members) to a SymbolItem tree.
let private toTopLevel (decl: NavigationTopLevelDeclaration) : SymbolItem =
    let children = decl.Nested |> Array.map (toItem []) |> Array.toList
    toItem children decl.Declaration

/// Parsing options that work without a cracked project. Fixtures use no
/// conditional-compilation directives, so the defaults parse them faithfully.
let private parsingOptions (state: FSharpWorkspace.FSharpWorkspaceState) (filePath: string) =
    match state.ProjectOptions with
    | Some opts -> fst (state.Checker.GetParsingOptionsFromProjectOptions(opts))
    | None -> { FSharpParsingOptions.Default with SourceFiles = [| filePath |] }

/// Document symbols for an F# file (parse-only, project-independent).
let documentSymbols (state: FSharpWorkspace.FSharpWorkspaceState) (filePath: string) =
    task {
        try
            let source = File.ReadAllText(filePath)
            let sourceText = SourceText.ofString source
            let options = parsingOptions state filePath
            let! parseResults = state.Checker.ParseFile(filePath, sourceText, options)
            let nav = parseResults.GetNavigationItems()
            return nav.Declarations |> Array.map toTopLevel |> Array.toList
        with ex ->
            Log.Debug(ex, "[F# DocumentSymbols] failed")
            return []
    }
