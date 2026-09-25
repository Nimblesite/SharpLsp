/// Hover and semantic navigation over checked F# source.
module SharpLsp.Sidecar.FSharp.FSharpSemanticNavigation

open System
open System.IO
open System.Threading.Tasks
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Tokenization
open Serilog
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.Hover

[<NoComparison; NoEquality>]
type NavigationLocation =
    { FilePath: string
      Line: int
      Character: int
      EndLine: int
      EndCharacter: int }

type private CheckedFile = FSharpCheckFileResults * string
type private ParsedFile = FSharpParseFileResults * FSharpCheckFileResults * string

/// The `--define:` symbols the file was checked with.
let private definesOf (checkResults: FSharpCheckFileResults) =
    checkResults.ProjectContext.ProjectOptions.OtherOptions
    |> Array.choose (fun option ->
        if option.StartsWith("--define:", StringComparison.Ordinal) then
            Some(option.Substring "--define:".Length)
        else
            None)
    |> List.ofArray

/// Every token of one line, and the lexer state the next line starts in. A CRLF
/// line's `\r` is dropped first: left on a `#if` line, it keeps the lexer from
/// entering the inactive branch at all.
let private scanLine (tokenizer: FSharpSourceTokenizer) (text: string) state =
    let lineTokenizer = tokenizer.CreateLineTokenizer(text.TrimEnd '\r')

    let rec scan state tokens =
        match lineTokenizer.ScanToken state with
        | Some token, next -> scan next (token :: tokens)
        | None, next -> List.rev tokens, next

    scan state []

/// True inside code an inactive `#if` branch holds: the active framework's defines
/// do not compile it, so nothing there may resolve — though a name lookup at the
/// position would still find a same-named symbol that IS compiled. [NETFX-CONTEXT]
let private isInactiveCode (checkResults: FSharpCheckFileResults) (lines: string array) line character =
    let tokenizer = FSharpSourceTokenizer(definesOf checkResults, None, None, None)

    let atLine =
        lines
        |> Array.take line
        |> Array.fold (fun state text -> snd (scanLine tokenizer text state)) FSharpTokenizerLexState.Initial

    fst (scanLine tokenizer lines[line] atLine)
    |> List.exists (fun token ->
        token.ColorClass = FSharpTokenColorKind.InactiveCode
        && token.LeftColumn <= character
        && character <= token.RightColumn)

let private extractToolTip (checkResults: FSharpCheckFileResults) (source: string) line character =
    let lines = source.Split('\n')

    if line < 0 || line >= lines.Length || isInactiveCode checkResults lines line character then
        None
    else
        let lineText = lines[line]

        QuickParse.GetCompleteIdentifierIsland true lineText character
        |> Option.bind (fun (name, endColumn, _) ->
            checkResults.GetToolTip(line + 1, endColumn, lineText, [ name ], FSharpTokenTag.Identifier)
            |> FSharpHoverBuilder.renderToolTip
            |> Option.map (fun markdown -> markdown, line, character, line, character + name.Length))

let getHover (checkFile: string -> Task<ParsedFile option>) filePath line character =
    task {
        try
            let! result = checkFile filePath

            return
                result
                |> Option.bind (fun (_, checkResults, source) -> extractToolTip checkResults source line character)
        with ex ->
            Log.Debug(ex, "[F# Hover] failed")
            return None
    }

let isSymbolInProject (options: FSharpProjectOptions option) (symbol: FSharpSymbol) =
    match symbol.DeclarationLocation, options with
    | Some range, Some projectOptions when range.FileName <> "" ->
        let target = NativePaths.NormalizeFullPath range.FileName

        let inSourceFiles =
            projectOptions.SourceFiles
            |> Array.exists (fun file -> NativePaths.AreEqual(file, target))

        let isSource =
            (target.EndsWith(".fs", StringComparison.OrdinalIgnoreCase)
             || target.EndsWith(".fsi", StringComparison.OrdinalIgnoreCase))
            && File.Exists(target)

        inSourceFiles || isSource
    | _ -> false

let rangeToLocation (range: FSharp.Compiler.Text.Range) =
    if range.FileName = "" then
        None
    else
        Some
            { FilePath = range.FileName
              Line = range.StartLine - 1
              Character = range.StartColumn
              EndLine = range.EndLine - 1
              EndCharacter = range.EndColumn }

let private symbolRangeContains line character (symbolUse: FSharpSymbolUse) =
    let range = symbolUse.Range
    let startLine = range.StartLine - 1
    let endLine = range.EndLine - 1

    let afterStart =
        line > startLine || (line = startLine && character >= range.StartColumn)

    let beforeEnd = line < endLine || (line = endLine && character < range.EndColumn)
    afterStart && beforeEnd

let private symbolSpan (symbolUse: FSharpSymbolUse) =
    let range = symbolUse.Range
    range.EndLine - range.StartLine, range.EndColumn - range.StartColumn

let private symbolUseCoveringPosition (checkResults: FSharpCheckFileResults) line character =
    checkResults.GetAllUsesOfAllSymbolsInFile()
    |> Seq.filter (symbolRangeContains line character)
    |> Seq.sortBy symbolSpan
    |> Seq.tryHead

let private quickSymbolUse (checkResults: FSharpCheckFileResults) line character lineText =
    QuickParse.GetCompleteIdentifierIsland true lineText character
    |> Option.bind (fun (name, endColumn, _) ->
        checkResults.GetSymbolUseAtLocation(line + 1, endColumn, lineText, [ name ]))

let getSymbolUse (checkResults: FSharpCheckFileResults) (source: string) line character =
    let lines = source.Split('\n')

    if line < 0 || line >= lines.Length then
        None
    else
        quickSymbolUse checkResults line character lines[line]
        |> Option.orElseWith (fun () -> symbolUseCoveringPosition checkResults line character)

let private getTypeEntity (valueType: FSharpType) =
    if valueType.HasTypeDefinition then
        Some valueType.TypeDefinition
    else
        None

let private fromMetadata (symbolUse: FSharpSymbolUse option) =
    symbolUse
    |> Option.bind (fun useInfo -> FSharpMetadataNavigator.tryResolve useInfo.Symbol)
    |> Option.map (fun (filePath, startLine, startColumn, endLine, endColumn) ->
        { FilePath = filePath
          Line = startLine
          Character = startColumn
          EndLine = endLine
          EndCharacter = endColumn })

let private declarationResultLocation result =
    match result with
    | FindDeclResult.DeclFound declarationRange -> rangeToLocation declarationRange
    | FindDeclResult.DeclNotFound _
    | FindDeclResult.ExternalDecl _ -> None

let private declarationLocationFallback (checkResults: FSharpCheckFileResults) (source: string) line character =
    let lines = source.Split('\n')

    if line < 0 || line >= lines.Length then
        None
    else
        let lineText = lines[line]

        QuickParse.GetCompleteIdentifierIsland true lineText character
        |> Option.map (fun (name, endColumn, _) ->
            checkResults.GetDeclarationLocation(line + 1, endColumn, lineText, [ name ]))
        |> Option.bind declarationResultLocation

let private extractDefinition checkResults source line character =
    let symbolUse = getSymbolUse checkResults source line character

    let fromSource =
        symbolUse
        |> Option.bind (fun useInfo -> useInfo.Symbol.DeclarationLocation)
        |> Option.bind rangeToLocation

    fromSource
    |> Option.orElseWith (fun () -> fromMetadata symbolUse)
    |> Option.orElseWith (fun () -> declarationLocationFallback checkResults source line character)

let getDefinition (checkFile: string -> Task<CheckedFile option>) filePath line character =
    task {
        try
            let! result = checkFile filePath

            return
                result
                |> Option.bind (fun (check, source) -> extractDefinition check source line character)
        with ex ->
            Log.Debug(ex, "[F# Definition] failed")
            return None
    }

let private symbolTypeEntity (symbol: FSharpSymbol) =
    match symbol with
    | :? FSharpMemberOrFunctionOrValue as memberValue -> memberValue.FullType |> getTypeEntity
    | :? FSharpField as field -> field.FieldType |> getTypeEntity
    | :? FSharpEntity as entity -> Some entity
    | _ -> None

let private extractTypeDefinition checkResults source line character =
    getSymbolUse checkResults source line character
    |> Option.bind (fun useInfo -> symbolTypeEntity useInfo.Symbol)
    |> Option.bind (fun entity -> rangeToLocation entity.DeclarationLocation)

let getTypeDefinition (checkFile: string -> Task<CheckedFile option>) filePath line character =
    task {
        try
            let! result = checkFile filePath

            return
                result
                |> Option.bind (fun (check, source) -> extractTypeDefinition check source line character)
        with ex ->
            Log.Debug(ex, "[F# TypeDefinition] failed")
            return None
    }

let private findBaseMember (memberValue: FSharpMemberOrFunctionOrValue) =
    if not memberValue.IsOverrideOrExplicitInterfaceImplementation then
        None
    else
        memberValue.DeclaringEntity
        |> Option.bind (fun entity ->
            entity.AllInterfaces
            |> Seq.choose getTypeEntity
            |> Seq.collect (fun interfaceEntity -> interfaceEntity.MembersFunctionsAndValues)
            |> Seq.tryFind (fun item -> item.DisplayName = memberValue.DisplayName)
            |> Option.bind (fun item -> rangeToLocation item.DeclarationLocation))

let private extractDeclaration checkResults source line character =
    match getSymbolUse checkResults source line character with
    | None -> None
    | Some useInfo ->
        match useInfo.Symbol with
        | :? FSharpMemberOrFunctionOrValue as memberValue ->
            findBaseMember memberValue
            |> Option.orElseWith (fun () -> rangeToLocation memberValue.DeclarationLocation)
        | _ -> extractDefinition checkResults source line character

let getDeclaration (checkFile: string -> Task<CheckedFile option>) filePath line character =
    task {
        try
            let! result = checkFile filePath

            return
                result
                |> Option.bind (fun (check, source) -> extractDeclaration check source line character)
        with ex ->
            Log.Debug(ex, "[F# Declaration] failed")
            return None
    }

let private extractImplementations checkResults source line character =
    getSymbolUse checkResults source line character
    |> Option.bind (fun useInfo -> useInfo.Symbol.DeclarationLocation)
    |> Option.bind rangeToLocation
    |> Option.toList

let getImplementations (checkFile: string -> Task<CheckedFile option>) filePath line character =
    task {
        try
            let! result = checkFile filePath

            return
                result
                |> Option.map (fun (check, source) -> extractImplementations check source line character)
                |> Option.defaultValue []
        with ex ->
            Log.Debug(ex, "[F# Implementation] failed")
            return []
    }
