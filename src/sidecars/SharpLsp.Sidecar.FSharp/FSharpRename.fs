/// Rename + prepare-rename for the F# sidecar via FCS, project-wide.
/// Implements [RENAME-FSHARP-PREPARE] / [RENAME-FSHARP-APPLY].
module SharpLsp.Sidecar.FSharp.FSharpRename

open System
open System.Threading
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Tokenization
open Serilog
open SharpLsp.Sidecar.FSharp.FSharpRenameAliases
open SharpLsp.Sidecar.FSharp.FSharpRenameIndexers
open SharpLsp.Sidecar.FSharp.FSharpRenameNames
open SharpLsp.Sidecar.FSharp.FSharpRenameToken

/// Prepare-rename result: the identifier token range + the symbol's current name.
type PrepareRename =
    { StartLine: int
      StartCharacter: int
      EndLine: int
      EndCharacter: int
      Placeholder: string }

/// Stable compiler identity shared with the other language sidecar.
type RenameIdentity = FSharpForeignSymbols.SymbolIdentity

[<NoComparison; NoEquality>]
type private ResolvedRename =
    { SymbolUse: FSharpSymbolUse
      Token: SourceToken }

[<NoComparison; NoEquality>]
type private LocatedUse =
    { SymbolUse: FSharpSymbolUse
      Token: SourceToken }

[<NoComparison; NoEquality>]
type private LocatedUseResult =
    | TextualUse of LocatedUse
    | ImplicitUse

type private TokenCandidate =
    { FilePath: string
      Line: int
      StartCharacter: int
      EndCharacter: int
      AbsoluteStart: int }

type private ProjectedCandidate =
    { Original: TokenCandidate
      StartCharacter: int
      EndCharacter: int }

/// Pure prepare-rename computation over an already-checked file. Kept separate
/// from the `task` so the async wrapper has a single bind + single return — the
/// shape FCS can compile to a static state machine (avoids FS3511).
let private rangeContains line character (symbolUse: FSharpSymbolUse) =
    let range = symbolUse.Range
    let startLine, endLine = range.StartLine - 1, range.EndLine - 1
    let afterStart = line > startLine || (line = startLine && character >= range.StartColumn)
    let beforeEnd = line < endLine || (line = endLine && character < range.EndColumn)
    afterStart && beforeEnd

let private resolveRenameUseAt
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (checkResults: FSharpCheckFileResults)
    tokenized line character =
    checkResults.GetAllUsesOfAllSymbolsInFile()
    |> Seq.filter (rangeContains line character)
    |> Seq.filter (fun symbolUse -> FSharpWorkspace.isSymbolInProject state symbolUse.Symbol)
    |> Seq.sortBy (fun symbolUse ->
        let range = symbolUse.Range
        range.EndColumn - range.StartColumn)
    |> Seq.tryPick (fun symbolUse ->
        tokenForUse state.Checker tokenized symbolUse
        |> Option.map (fun token ->
            { ResolvedRename.SymbolUse = symbolUse
              Token = token }))

let private resolveRenameUse
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    (source: string) line character =
    let tokenized = tokenizeSource state.Checker source
    let resolveAt = resolveRenameUseAt state checkResults tokenized line
    resolveAt character
    |> Option.orElseWith (fun () ->
        tokenAtPosition state.Checker tokenized line character
        |> Option.map (semanticCharacter character)
        |> Option.bind resolveAt)
    |> Option.orElseWith (fun () ->
        tryResolveAt checkResults parseResults line character
        |> Option.filter (fun (symbolUse, _) -> FSharpWorkspace.isSymbolInProject state symbolUse.Symbol)
        |> Option.map (fun (symbolUse, token) ->
            { SymbolUse = symbolUse
              Token = token }))

let private toPrepareRename line (resolved: ResolvedRename) =
    { StartLine = line
      StartCharacter = resolved.Token.StartCharacter
      EndLine = line
      EndCharacter = resolved.Token.EndCharacter
      Placeholder = resolved.Token.Text }

let private toPrepareToken line (token: SourceToken) =
    { StartLine = line
      StartCharacter = token.StartCharacter
      EndLine = line
      EndCharacter = token.EndCharacter
      Placeholder = token.Text }

/// FCS reports some semantic uses at a zero-width range: a record copy-and-update
/// expression `{ value with Field = 1 }` names its record type at the `{` with an
/// empty span. There is no identifier text there to rewrite, so such a use is
/// carried as implicit instead of failing the whole rename. [RENAME-FSHARP-APPLY]
let private isInferredUse (symbolUse: FSharpSymbolUse) =
    let range = symbolUse.Range
    range.StartLine = range.EndLine && range.StartColumn = range.EndColumn

let private classifyLocatedUse checker tokenized syntaxes symbolUse =
    tokenForUse checker tokenized symbolUse
    |> Option.map (fun token ->
        TextualUse
            { SymbolUse = symbolUse
              Token = token })
    |> Option.orElseWith (fun () ->
        if isImplicitUse syntaxes symbolUse || isInferredUse symbolUse then Some ImplicitUse
        else None)

let private locateFileUses (state: FSharpWorkspace.FSharpWorkspaceState) (filePath, uses) (ct: CancellationToken) =
    task {
        if String.IsNullOrWhiteSpace(filePath) then return uses |> Array.map (fun _ -> None)
        else
            let! source = FSharpWorkspace.readSourceWithCancellation state filePath ct
            let tokenized = tokenizeSource state.Checker source
            let! checkedFile = FSharpWorkspace.checkFileWithParseWithCancellation state filePath ct
            let syntaxes = checkedFile |> Option.map (fun (parse, _, _) -> collectSyntaxes parse) |> Option.defaultValue [||]
            return uses |> Array.map (classifyLocatedUse state.Checker tokenized syntaxes)
    }

let private collectLocatedUses state groups (ct: CancellationToken) =
    task {
        let collected = ResizeArray<LocatedUseResult option>()
        for group in groups do
            ct.ThrowIfCancellationRequested()
            let! located = locateFileUses state group ct
            collected.AddRange(located)
        return collected.ToArray()
    }

let private tryLocateUses state (uses: FSharpSymbolUse array) ct =
    task {
        let groups =
            uses
            |> Array.groupBy (fun symbolUse ->
                let range = symbolUse.Range
                range.FileName)
        let! located = collectLocatedUses state groups ct
        if Array.isEmpty located || located |> Array.exists Option.isNone then return None
        else
            return
                located
                |> Array.choose id
                |> Array.choose (function TextualUse locatedUse -> Some locatedUse | _ -> None)
                |> Some
    }

let private prepareChecked state parseResults checkResults source line character =
    let aliases = FSharpRenameAliases.resolveFile state parseResults checkResults source
    match FSharpRenameAliases.tryResolveAt line character aliases with
    | Some(_, token, _) -> Some(toPrepareToken line token)
    | None ->
        resolveRenameUse state checkResults parseResults source line character
        |> Option.map (toPrepareRename line)

/// Check whether the symbol at a position can be renamed, returning its token range.
let prepareRename
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFileWithParse state filePath
            match fileCheck with
            | None -> return None
            | Some(parseResults, checkResults, source) ->
                return prepareChecked state parseResults checkResults source line character
        with ex ->
            Log.Debug(ex, "[F# PrepareRename] failed")
            return None
    }

/// The identity of a symbol a C# project of the workspace declares, used here: F# reads that
/// project in memory, so the C# sidecar finds its C# declaration and uses by it.
/// [REFERENCES-CROSS-LANGUAGE]
let private csharpIdentity (state: FSharpWorkspace.FSharpWorkspaceState) checkResults source line character =
    FSharpWorkspace.getSymbolUse checkResults source line character
    |> Option.filter (fun symbolUse -> FSharpCSharpReferences.declares state.CSharpBuilds symbolUse.Symbol)
    |> Option.bind (fun symbolUse -> FSharpForeignSymbols.identityOf symbolUse.Symbol)

let private computeRenameIdentity state parseResults checkResults source line character =
    resolveRenameUse state checkResults parseResults source line character
    |> Option.bind (fun resolved -> FSharpForeignSymbols.identityOf (normalizeSymbol resolved.SymbolUse.Symbol))
    |> Option.orElseWith (fun () -> csharpIdentity state checkResults source line character)

/// Return the compiler-stable identity for the renameable symbol at a position.
let getRenameIdentity (state: FSharpWorkspace.FSharpWorkspaceState) filePath line character =
    task {
        try
            if not state.IsLoaded then
                return raise (InvalidOperationException("F# workspace is not loaded"))
            else
                let! fileCheck = FSharpWorkspace.checkFileWithParse state filePath
                let parseResults, checkResults, source = FSharpForeignSymbols.requireCheckedFile filePath fileCheck
                return computeRenameIdentity state parseResults checkResults source line character
        with ex ->
            Log.Debug(ex, "[F# RenameIdentity] failed")
            return raise ex
    }

let private editForLocated newName (located: LocatedUse) : FSharpCodeActions.RawEdit =
    let range = located.SymbolUse.Range
    { FilePath = range.FileName
      StartLine = range.EndLine - 1
      StartCharacter = located.Token.StartCharacter
      EndLine = range.EndLine - 1
      EndCharacter = located.Token.EndCharacter
      NewText = newName }

let private distinctEdits (edits: FSharpCodeActions.RawEdit array) =
    edits
    |> Array.distinctBy (fun edit ->
        edit.FilePath, edit.StartLine, edit.StartCharacter, edit.EndLine, edit.EndCharacter)
    |> Array.toList

let private tryEditsForUses state newName uses ct =
    task {
        let! located = tryLocateUses state uses ct
        return located |> Option.map (Array.map (editForLocated newName) >> distinctEdits)
    }

let private withoutAliasUses symbol aliases uses =
    let keys = FSharpRenameAliases.keysForTarget symbol aliases
    uses |> Array.filter (FSharpRenameAliases.semanticUseKey >> keys.Contains >> not)

let private invalidName newName = Error $"Invalid F# rename name: '{newName}'"

let private combineEdits first second =
    Array.append (List.toArray first) (List.toArray second) |> distinctEdits

let private standardRename state newName (resolved: ResolvedRename) ct =
    task {
        let symbol = normalizeSymbol resolved.SymbolUse.Symbol
        let usedIn = resolved.SymbolUse.FileName
        let! aliases = FSharpRenameAliases.collectProject state (FSharpWorkspace.anchorOf state symbol usedIn) ct
        match aliases with
        | Error message -> return Error message
        | Ok aliases ->
            let! uses = FSharpReferences.getProjectUsagesForSymbol state usedIn symbol ct
            let! located = tryEditsForUses state newName (withoutAliasUses symbol aliases uses) ct
            match located with
            | None -> return Error "F# rename could not classify every semantic use"
            | Some edits ->
                let! metadata = planMetadata state symbol newName ct
                return metadata |> Result.map (combineEdits edits)
    }

let private renameChecked state parseResults checkResults source line character newName ct =
    task {
        let aliases = FSharpRenameAliases.resolveFile state parseResults checkResults source
        match FSharpRenameAliases.tryResolveAt line character aliases with
        | Some(symbol, token, _) when not (isValidNewName parseResults state.Checker symbol token newName) ->
            return invalidName newName
        | Some(_, _, uses) -> return Ok(FSharpRenameAliases.edits newName uses)
        | None ->
            match resolveRenameUse state checkResults parseResults source line character with
            | None -> return Ok []
            | Some resolved when not (isValidNewName parseResults state.Checker resolved.SymbolUse.Symbol resolved.Token newName) ->
                return invalidName newName
            | Some resolved -> return! standardRename state newName resolved ct
    }

/// Every use of the symbol `assemblyName` and `xmlDocSig` name. A rename by identity, from
/// the other language with no F# file to anchor on, walks every loaded project.
let private collectMatchingUses (state: FSharpWorkspace.FSharpWorkspaceState) assemblyName xmlDocSig ct =
    FSharpForeignSymbols.usesIn state assemblyName xmlDocSig (FSharpWorkspace.allSourceFiles state) ct

let private signatureHeaderEnd (xmlDocSig: string) =
    [| xmlDocSig.IndexOf('('); xmlDocSig.IndexOf('~') |]
    |> Array.filter (fun index -> index >= 0)
    |> Array.append [| xmlDocSig.Length |]
    |> Array.min

let internal declarationNameFromXmlDocSignature (xmlDocSig: string) =
    let headerEnd = signatureHeaderEnd xmlDocSig
    let header = xmlDocSig.Substring(0, headerEnd)
    let separator = [| header.LastIndexOf('.'); header.LastIndexOf('#'); header.LastIndexOf(':') |] |> Array.max
    let startIndex = separator + 1
    let arityIndex = header.IndexOf('`', startIndex)
    let endIndex = if arityIndex >= 0 then arityIndex else headerEnd
    if startIndex < endIndex then Some(header.Substring(startIndex, endIndex - startIndex))
    else None

let internal renameXmlDocSignature (xmlDocSig: string) (currentName: string) (newName: string) =
    let headerEnd = signatureHeaderEnd xmlDocSig
    let header = xmlDocSig.Substring(0, headerEnd)
    let index = header.LastIndexOf(currentName, StringComparison.Ordinal)
    if index < 2 then ""
    else xmlDocSig.Substring(0, index) + newName + xmlDocSig.Substring(index + currentName.Length)

let private tokenCandidate filePath lineIndex absoluteStart (lineText: string) currentName (token: FSharpTokenInfo) =
    if token.CharClass <> FSharpTokenCharKind.Identifier then None
    else
        let text = lineText.Substring(token.LeftColumn, token.RightColumn - token.LeftColumn + 1)
        if text <> currentName && text <> $"``{currentName}``" then None
        else
            Some
                { FilePath = filePath
                  Line = lineIndex
                  StartCharacter = token.LeftColumn
                  EndCharacter = token.RightColumn + 1
                  AbsoluteStart = absoluteStart + token.LeftColumn }

let private candidatesInLine filePath lineIndex absoluteStart lineText currentName tokens =
    tokens
    |> Array.choose (tokenCandidate filePath lineIndex absoluteStart lineText currentName)

let private tokenCandidates
    (state: FSharpWorkspace.FSharpWorkspaceState)
    filePath (source: string) currentName =
    let lines, tokensByLine = tokenizeSource state.Checker source
    let candidates = ResizeArray<TokenCandidate>()
    let mutable absoluteStart = 0
    for lineIndex, lineText in lines |> Array.indexed do
        let tokens = if lineIndex < tokensByLine.Length then tokensByLine[lineIndex] else [||]
        candidates.AddRange(candidatesInLine filePath lineIndex absoluteStart lineText currentName tokens)
        absoluteStart <- absoluteStart + lineText.Length + 1
    candidates.ToArray()

let private candidateEdit newName candidate : FSharpCodeActions.RawEdit =
    { FilePath = candidate.FilePath
      StartLine = candidate.Line
      StartCharacter = candidate.StartCharacter
      EndLine = candidate.Line
      EndCharacter = candidate.EndCharacter
      NewText = newName }

let private projectCandidatePositions (newName: string) (candidates: TokenCandidate array) =
    let mutable line = -1
    let mutable shift = 0
    candidates
    |> Array.map (fun candidate ->
        if line <> candidate.Line then
            line <- candidate.Line
            shift <- 0
        let startCharacter = candidate.StartCharacter + shift
        let length = candidate.EndCharacter - candidate.StartCharacter
        shift <- shift + newName.Length - length
        { Original = candidate
          StartCharacter = startCharacter
          EndCharacter = startCharacter + newName.Length })

let private projectSource (source: string) (newName: string) (candidates: TokenCandidate array) =
    let projected = Text.StringBuilder(source.Length)
    let mutable cursor = 0
    for candidate in candidates do
        let unchangedLength = candidate.AbsoluteStart - cursor
        projected.Append(source, cursor, unchangedLength).Append(newName) |> ignore
        cursor <- candidate.AbsoluteStart + candidate.EndCharacter - candidate.StartCharacter
    projected.Append(source, cursor, source.Length - cursor).ToString()

let private matchesProjectedRange (candidate: ProjectedCandidate) (symbolUse: FSharpSymbolUse) =
    let range = symbolUse.Range
    range.StartLine - 1 = candidate.Original.Line
    && range.EndLine - 1 = candidate.Original.Line
    && range.StartColumn = candidate.StartCharacter
    && range.EndColumn = candidate.EndCharacter

let private matchingProjectedEdits
    assemblyName staleXml newName (checkResults: FSharpCheckFileResults)
    (source: string) (candidates: ProjectedCandidate array) =
    candidates
    |> Array.choose (fun candidate ->
        FSharpWorkspace.getSymbolUse
            checkResults source candidate.Original.Line candidate.StartCharacter
        |> Option.filter (matchesProjectedRange candidate)
        |> Option.filter (FSharpForeignSymbols.matches assemblyName staleXml)
        |> Option.map (fun _ -> candidateEdit newName candidate.Original))

let private transientFileEdits
    (state: FSharpWorkspace.FSharpWorkspaceState)
    assemblyName staleXml currentName newName filePath ct =
    task {
        let! source = FSharpWorkspace.readSourceWithCancellation state filePath ct
        let candidates = tokenCandidates state filePath source currentName
        if Array.isEmpty candidates then return [||]
        else
            let projectedCandidates = projectCandidatePositions newName candidates
            let projectedSource = projectSource source newName candidates
            let! checkedFile = FSharpWorkspace.checkFileWithSource state filePath projectedSource ct
            let _, checkResults, checkedSource = FSharpForeignSymbols.requireCheckedFile filePath checkedFile
            return matchingProjectedEdits
                assemblyName staleXml newName checkResults checkedSource projectedCandidates
    }

let private transientForeignEdits
    (state: FSharpWorkspace.FSharpWorkspaceState)
    assemblyName xmlDocSig newName (ct: CancellationToken) =
    task {
        match declarationNameFromXmlDocSignature xmlDocSig with
        | None -> return []
        | Some currentName when currentName = newName -> return []
        | Some currentName ->
            let staleXml = renameXmlDocSignature xmlDocSig currentName newName
            let edits = ResizeArray<FSharpCodeActions.RawEdit>()
            let files = FSharpWorkspace.allSourceFiles state
            if String.IsNullOrWhiteSpace(staleXml) then return []
            else
                for filePath in files do
                    ct.ThrowIfCancellationRequested()
                    let! fileEdits = transientFileEdits state assemblyName staleXml currentName newName filePath ct
                    edits.AddRange(fileEdits)
                return edits.ToArray() |> distinctEdits
    }

/// [SHARPLSP-FEATURES-REFACTORING] Rename references declared by another language sidecar.
let renameForeign (state: FSharpWorkspace.FSharpWorkspaceState) assemblyName xmlDocSig newName ct =
    task {
        try
            if not state.IsLoaded then
                return raise (InvalidOperationException("F# workspace is not loaded"))
            elif [ assemblyName; xmlDocSig; newName ] |> List.exists String.IsNullOrWhiteSpace then
                return []
            else
                let! uses = collectMatchingUses state assemblyName xmlDocSig ct
                let! located = tryEditsForUses state newName uses ct
                match located with
                | Some edits -> return edits
                | None -> return! transientForeignEdits state assemblyName xmlDocSig newName ct
        with ex ->
            Log.Debug(ex, "[F# RenameForeign] failed")
            return raise ex
    }

/// Rename with an explicit failure channel for invalid request names.
let renameResult
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    (newName: string)
    (ct: CancellationToken)
    =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFileWithParseWithCancellation state filePath ct
            match fileCheck with
            | None -> return Ok []
            | Some(parseResults, checkResults, source) ->
                return! renameChecked state parseResults checkResults source line character newName ct
        with ex ->
            Log.Debug(ex, "[F# Rename] failed")
            return Error $"F# rename request failed: {ex.Message}"
    }

/// Compatibility entry point for in-process callers that treat failures as no edits.
let rename state filePath line character newName =
    task {
        let! result = renameResult state filePath line character newName CancellationToken.None
        return Result.defaultValue [] result
    }
