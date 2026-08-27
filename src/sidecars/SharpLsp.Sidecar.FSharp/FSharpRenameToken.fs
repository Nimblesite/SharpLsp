/// F# lexer-backed token recovery shared by prepare-rename and rename edits.
/// Implements token boundary handling for [RENAME-FSHARP-PREPARE]/[RENAME-FSHARP-APPLY].
module SharpLsp.Sidecar.FSharp.FSharpRenameToken

open System
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Tokenization

type SourceToken =
    { StartCharacter: int
      EndCharacter: int
      Text: string
      Kind: RenameTokenKind }

and RenameTokenKind =
    | IdentifierToken
    | OperatorToken

let tokenizeSource (checker: FSharpChecker) (source: string) =
    source.Split('\n'), checker.TokenizeFile(source)

let private tokensSpanText length (tokens: FSharpTokenInfo array) =
    not (Array.isEmpty tokens)
    && tokens[0].LeftColumn = 0
    && tokens[tokens.Length - 1].RightColumn = length - 1
    && (tokens
        |> Array.pairwise
        |> Array.forall (fun (left, right) -> left.RightColumn + 1 = right.LeftColumn))

let classifyName (checker: FSharpChecker) (text: string) =
    let tokens = checker.TokenizeFile(text) |> Array.collect id
    let identifiers = tokens |> Array.forall (fun token -> token.CharClass = FSharpTokenCharKind.Identifier)
    let operators =
        tokens
        |> Array.forall (fun token ->
            match token.CharClass with
            | FSharpTokenCharKind.Operator
            | FSharpTokenCharKind.Delimiter -> true
            | _ -> false)
    if not (tokensSpanText text.Length tokens) then None
    elif identifiers then Some IdentifierToken
    elif operators && PrettyNaming.IsOperatorDisplayName(text) then Some OperatorToken
    else None

let private tokenFromBounds checker (lineText: string) startCharacter endCharacter =
    if startCharacter < 0 || endCharacter <= startCharacter || endCharacter > lineText.Length then None
    else
        let text = lineText.Substring(startCharacter, endCharacter - startCharacter)
        classifyName checker text
        |> Option.map (fun kind ->
            { StartCharacter = startCharacter
              EndCharacter = endCharacter
              Text = text
              Kind = kind })

let sourceNameForSymbol (symbol: FSharpSymbol) =
    let displayName = symbol.DisplayName
    if PrettyNaming.IsOperatorDisplayName(displayName) then displayName.Trim('(', ')')
    else displayName

/// FCS reports `DisplayName` carrying the ``escaping`` backticks an identifier
/// needs, and the lexer hands back that same escaped text. Compare the logical
/// names so an escaped identifier matches its own uses.
let private logicalName (text: string) = text.Trim('`')

let private tokenMatchesName sourceName (token: SourceToken) =
    (logicalName token.Text).TrimStart('\'') = logicalName sourceName

let tokenForRangeName
    (checker: FSharpChecker)
    (sourceLines: string array, sourceTokens: FSharpTokenInfo array array)
    sourceName
    (range: FSharp.Compiler.Text.Range) =
    let lineIndex = range.EndLine - 1
    if range.StartLine <> range.EndLine || lineIndex < 0 || lineIndex >= sourceLines.Length then None
    else
        tokenFromBounds checker sourceLines[lineIndex] range.StartColumn range.EndColumn
        |> Option.filter (tokenMatchesName sourceName)
        |> Option.orElseWith (fun () ->
            sourceTokens |> Array.tryItem lineIndex |> Option.defaultValue [||] |> Array.rev
            |> Array.filter (fun token ->
                token.LeftColumn < range.EndColumn && token.RightColumn + 1 > range.StartColumn)
            |> Array.tryPick (fun token ->
                tokenFromBounds checker sourceLines[lineIndex] token.LeftColumn (token.RightColumn + 1)
                |> Option.filter (tokenMatchesName sourceName)))

let tokenForUseName checker tokenized sourceName (symbolUse: FSharpSymbolUse) =
    tokenForRangeName checker tokenized sourceName symbolUse.Range

let tokenForUse checker tokenized (symbolUse: FSharpSymbolUse) =
    tokenForUseName checker tokenized (sourceNameForSymbol symbolUse.Symbol) symbolUse

let tokenAtPosition
    (checker: FSharpChecker)
    (sourceLines: string array, sourceTokens: FSharpTokenInfo array array)
    line character =
    match Array.tryItem line sourceLines, Array.tryItem line sourceTokens with
    | Some lineText, Some tokens ->
        tokens
        |> Array.tryFind (fun token ->
            token.LeftColumn <= character && character <= token.RightColumn)
        |> Option.bind (fun token ->
            tokenFromBounds checker lineText token.LeftColumn (token.RightColumn + 1))
    | _ -> None

let semanticCharacter character (token: SourceToken) =
    let escaped =
        token.Text.Length > 4
        && token.Text.StartsWith("``", StringComparison.Ordinal)
        && token.Text.EndsWith("``", StringComparison.Ordinal)
    if escaped then Math.Clamp(character, token.StartCharacter + 2, token.EndCharacter - 3)
    else character
