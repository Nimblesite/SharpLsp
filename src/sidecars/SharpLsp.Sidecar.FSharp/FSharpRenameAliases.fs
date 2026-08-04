/// Scope-aware module-abbreviation recovery for F# rename.
module SharpLsp.Sidecar.FSharp.FSharpRenameAliases

open System
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpRenameToken

type SemanticUseKey = string * int * int * int * int

[<NoComparison; NoEquality>]
type private AliasSyntax =
    { Alias: Ident
      Target: Ident
      Scope: Range }

[<NoComparison; NoEquality>]
type private BoundAlias =
    { Syntax: AliasSyntax
      TargetSymbol: FSharpSymbol }

[<NoComparison; NoEquality>]
type AliasUse =
    { Range: Range
      Token: SourceToken
      SemanticKey: SemanticUseKey option }

[<NoComparison; NoEquality>]
type ResolvedAlias =
    { TargetSymbol: FSharpSymbol
      AliasToken: SourceToken
      Uses: AliasUse array }

let semanticUseKey (symbolUse: FSharpSymbolUse) : SemanticUseKey =
    let range = symbolUse.Range
    range.FileName, range.StartLine, range.StartColumn, range.EndLine, range.EndColumn

let private rangeKey (range: Range) : SemanticUseKey =
    range.FileName, range.StartLine, range.StartColumn, range.EndLine, range.EndColumn

let private scopeForAlias (path: SyntaxNode list) (alias: Ident) =
    path
    |> List.tryHead
    |> Option.map _.Range
    |> Option.defaultValue alias.idRange

let private collectAliasSyntaxes tree =
    (([]: AliasSyntax list), tree)
    ||> ParsedInput.fold (fun found path node ->
        match node with
        | SyntaxNode.SynModule(SynModuleDecl.ModuleAbbrev(alias, longId, _)) ->
            match List.tryLast longId with
            | Some target -> { Alias = alias; Target = target; Scope = scopeForAlias path alias } :: found
            | None -> found
        | _ -> found)
    |> List.rev

let private bindAlias (checkResults: FSharpCheckFileResults) source (syntax: AliasSyntax) =
    let targetRange = syntax.Target.idRange
    FSharpWorkspace.getSymbolUse checkResults source (targetRange.StartLine - 1) targetRange.StartColumn
    |> Option.map (fun targetUse ->
        { Syntax = syntax
          TargetSymbol = targetUse.Symbol })

let private isAfterDeclaration (syntax: AliasSyntax) (range: Range) =
    let aliasRange = syntax.Alias.idRange
    (range.StartLine, range.StartColumn) >=
    (aliasRange.StartLine, aliasRange.StartColumn)

let private withinScope (syntax: AliasSyntax) (range: Range) =
    Range.rangeContainsRange syntax.Scope range

let private previousNonWhitespace (lineText: string) startCharacter =
    let mutable index = startCharacter - 1
    while index >= 0 && Char.IsWhiteSpace(lineText[index]) do
        index <- index - 1
    if index < 0 then None else Some lineText[index]

let private isRootToken (sourceLines: string array) (useRange: Range) (token: SourceToken) =
    let lineIndex = useRange.EndLine - 1
    match Array.tryItem lineIndex sourceLines with
    | None -> false
    | Some lineText -> previousNonWhitespace lineText token.StartCharacter <> Some '.'

let private eligibleOwner (candidate: BoundAlias) (symbolUse: FSharpSymbolUse) token =
    candidate.TargetSymbol.Equals(symbolUse.Symbol)
    && candidate.Syntax.Alias.idText = token.Text.Trim('`')
    && withinScope candidate.Syntax symbolUse.Range
    && isAfterDeclaration candidate.Syntax symbolUse.Range

let private ownerRank (candidate: BoundAlias) =
    let range = candidate.Syntax.Scope
    range.StartLine, range.StartColumn, -range.EndLine, -range.EndColumn

let private ownsUse (aliases: BoundAlias array) (alias: BoundAlias) symbolUse token =
    aliases
    |> Array.filter (fun candidate -> eligibleOwner candidate symbolUse token)
    |> Array.sortByDescending ownerRank
    |> Array.tryHead
    |> Option.exists (fun owner -> obj.ReferenceEquals(owner, alias))

let private candidateUse checker tokenized sourceLines aliases (alias: BoundAlias) symbolUse =
    tokenForUseName checker tokenized alias.Syntax.Alias.idText symbolUse
    |> Option.filter (isRootToken sourceLines symbolUse.Range)
    |> Option.filter (ownsUse aliases alias symbolUse)
    |> Option.filter (fun _ -> rangeKey symbolUse.Range <> rangeKey alias.Syntax.Target.idRange)
    |> Option.map (fun token ->
        { Range = symbolUse.Range
          Token = token
          SemanticKey = Some(semanticUseKey symbolUse) })

let private declarationUse checker tokenized (alias: BoundAlias) =
    tokenForRangeName checker tokenized alias.Syntax.Alias.idText alias.Syntax.Alias.idRange
    |> Option.map (fun token ->
        { Range = alias.Syntax.Alias.idRange
          Token = token
          SemanticKey = None })

let private ensureDeclaration checker tokenized (alias: BoundAlias) (uses: AliasUse array) =
    let declarationKey = rangeKey alias.Syntax.Alias.idRange
    if uses |> Array.exists (fun aliasUse -> rangeKey aliasUse.Range = declarationKey) then Some uses
    else declarationUse checker tokenized alias |> Option.map (fun aliasUse -> Array.append [| aliasUse |] uses)

let private resolveBoundAlias checker tokenized sourceLines aliases (alias: BoundAlias) (checkResults: FSharpCheckFileResults) =
    checkResults.GetUsesOfSymbolInFile(alias.TargetSymbol)
    |> Array.choose (candidateUse checker tokenized sourceLines aliases alias)
    |> ensureDeclaration checker tokenized alias
    |> Option.bind (fun uses ->
        declarationUse checker tokenized alias
        |> Option.map (fun declaration ->
            { TargetSymbol = alias.TargetSymbol
              AliasToken = declaration.Token
              Uses = uses }))

let resolveFile
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (parseResults: FSharpParseFileResults)
    (checkResults: FSharpCheckFileResults)
    source =
    let tokenized = tokenizeSource state.Checker source
    let sourceLines, _ = tokenized
    let aliases =
        collectAliasSyntaxes parseResults.ParseTree
        |> List.choose (bindAlias checkResults source)
        |> List.toArray
    aliases
    |> Array.choose (fun alias ->
        resolveBoundAlias state.Checker tokenized sourceLines aliases alias checkResults)

let private tokenContains character (token: SourceToken) =
    token.StartCharacter <= character && character < token.EndCharacter

let tryResolveAt line character (aliases: ResolvedAlias array) =
    aliases
    |> Array.tryPick (fun alias ->
        alias.Uses
        |> Array.tryFind (fun aliasUse ->
            aliasUse.Range.EndLine - 1 = line && tokenContains character aliasUse.Token)
        |> Option.map (fun aliasUse -> alias.TargetSymbol, aliasUse.Token, alias.Uses))

let private useEdit newName (aliasUse: AliasUse) : FSharpCodeActions.RawEdit =
    { FilePath = aliasUse.Range.FileName
      StartLine = aliasUse.Range.EndLine - 1
      StartCharacter = aliasUse.Token.StartCharacter
      EndLine = aliasUse.Range.EndLine - 1
      EndCharacter = aliasUse.Token.EndCharacter
      NewText = newName }

let edits newName (uses: AliasUse array) =
    uses
    |> Array.map (useEdit newName)
    |> Array.distinctBy (fun edit ->
        edit.FilePath, edit.StartLine, edit.StartCharacter, edit.EndLine, edit.EndCharacter)
    |> Array.toList

let keysForTarget (symbol: FSharpSymbol) (aliases: ResolvedAlias array) =
    aliases
    |> Array.filter (fun alias -> alias.TargetSymbol.Equals(symbol))
    |> Array.collect _.Uses
    |> Array.choose _.SemanticKey
    |> Set.ofArray

let private projectFiles (state: FSharpWorkspace.FSharpWorkspaceState) =
    state.ProjectOptions |> Option.map _.SourceFiles |> Option.defaultValue [||]

let collectProject state =
    task {
        let collected = ResizeArray<ResolvedAlias>()
        let mutable failure = None
        for filePath in projectFiles state do
            let! checkedFile = FSharpWorkspace.checkFileWithParse state filePath
            match checkedFile with
            | Some(parseResults, checkResults, source) ->
                collected.AddRange(resolveFile state parseResults checkResults source)
            | None -> failure <- Some $"FCS could not check {filePath}"
        return failure |> Option.map Error |> Option.defaultWith (fun () -> Ok(collected.ToArray()))
    }
