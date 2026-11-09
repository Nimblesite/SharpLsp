/// F# inlay hints via FCS, as FSAC shows them (GitHub #389): a definition's inferred
/// type in the file's short display names, each parameter name before its own
/// argument and never on an operator, and a pipeline's input type before its `|>`.
/// Arguments come from the parsed applications and types from the checked symbol
/// uses: no scan of the source text. Implements [SHARPLSP-FEATURES-INTELLIGENCE]
/// inlay hints and [SHARPLSP-FEATURES-FSHARP] pipeline hints.
module SharpLsp.Sidecar.FSharp.FSharpInlayHints

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open MessagePack
open Serilog

/// Wire-compatible inlay hint, positionally matched to the Rust host's
/// `SidecarInlayHint` ([line, character, label, kind]). This MUST be a keyed
/// MessagePack record — F# anonymous records (`{| ... |}`) serialize with
/// alphabetically-sorted, named fields, which the host cannot deserialize
/// (it fails with `missing field \`line\``), so inlay hints silently vanished.
[<MessagePackObject>]
type InlayHintItem =
    { [<Key(0)>] Line: int
      [<Key(1)>] Character: int
      [<Key(2)>] Label: string
      [<Key(3)>] Kind: int }

/// LSP `InlayHintKind.Type`.
let private typeKind = 1

/// LSP `InlayHintKind.Parameter`.
let private parameterKind = 2

/// A hint `label` of `kind` before the character at `position`.
let private hintAt (position: pos) label kind =
    { Line = position.Line - 1
      Character = position.Column
      Label = label
      Kind = kind }

/// `ty` as the file reads it at `symbolUse`: short names, no namespaces.
let private display (symbolUse: FSharpSymbolUse) (ty: FSharpType) =
    ty.Format(symbolUse.DisplayContext.WithShortTypeNames true)

/// The inferred type after a definition the source leaves unannotated.
let private typeHint (parseResults: FSharpParseFileResults) (symbolUse: FSharpSymbolUse) =
    let range = symbolUse.Range

    match symbolUse.Symbol with
    | :? FSharpMemberOrFunctionOrValue as value when
        symbolUse.IsFromDefinition
        && not value.IsProperty
        && not (parseResults.IsTypeAnnotationGivenAtPosition range.Start)
        ->
        [ hintAt range.End $": {display symbolUse value.FullType}" typeKind ]
    | _ -> []

/// The ranges of a method call's positional arguments, or of a function's curried ones.
let private argumentRanges (parseResults: FSharpParseFileResults) (symbolRange: range) =
    let arguments = parseResults.GetAllArgumentsForFunctionApplicationAtPosition symbolRange.Start |> Option.defaultValue []
    // FCS locates a call from a position inside its arguments.
    let call = arguments |> List.tryHead |> Option.bind (fun argument -> parseResults.FindParameterLocations argument.Start)

    match call with
    | Some call when call.LongIdEndLocation = symbolRange.End ->
        call.ArgumentLocations
        |> Array.filter (fun argument -> not argument.IsNamedArgument)
        |> Array.map _.ArgumentRange
        |> List.ofArray
    | _ -> arguments

/// The parameter names an applied method or function takes, one per argument: a
/// method's tupled group, or the name of each single-parameter curried group.
let private parameterNames (value: FSharpMemberOrFunctionOrValue) (tupledCall: bool) =
    let named (parameter: FSharpParameter) = parameter.Name |> Option.filter ((<>) "")
    let groups = value.CurriedParameterGroups |> Seq.map List.ofSeq |> List.ofSeq

    match groups with
    | [ group ] when tupledCall -> group |> List.map named
    | _ ->
        groups
        |> List.map (function
            | [ parameter ] -> named parameter
            | _ -> None)

/// Each parameter name before its own argument of a call to a method or function.
let private parameterHints (parseResults: FSharpParseFileResults) (symbolUse: FSharpSymbolUse) =
    match symbolUse.Symbol with
    | :? FSharpMemberOrFunctionOrValue as value when
        symbolUse.IsFromUse && not (PrettyNaming.IsOperatorDisplayName value.DisplayName)
        ->
        let range = symbolUse.Range
        let arguments = argumentRanges parseResults range
        let tupled = value.IsMethod || value.IsConstructor

        Seq.zip arguments (parameterNames value tupled)
        |> Seq.choose (fun (argument, name) -> name |> Option.map (fun name -> hintAt argument.Start $"{name}:" parameterKind))
        |> List.ofSeq
    | _ -> []

/// `ty` as instantiated at `symbolUse` when it is one of the symbol's generic parameters.
let private instantiated (symbolUse: FSharpSymbolUse) (ty: FSharpType) =
    if ty.IsGenericParameter then
        symbolUse.GenericArguments
        |> List.tryFind (fun (parameter, _) -> parameter.Name = ty.GenericParameter.Name)
        |> Option.map snd
    else
        Some ty

/// The type flowing into a `|>`, before the operator. [SHARPLSP-FEATURES-FSHARP]
let private pipelineHint (symbolUse: FSharpSymbolUse) =
    match symbolUse.Symbol with
    | :? FSharpMemberOrFunctionOrValue as pipe when symbolUse.IsFromUse && pipe.CompiledName = "op_PipeRight" ->
        pipe.CurriedParameterGroups
        |> Seq.tryHead
        |> Option.bind Seq.tryHead
        |> Option.bind (fun input -> instantiated symbolUse input.Type)
        |> Option.map (fun input ->
            let range = symbolUse.Range
            hintAt range.Start $": {display symbolUse input}" typeKind)
        |> Option.toList
    | _ -> []

/// Every hint of the symbol uses that start on lines `startLine..endLine` (0-based).
let private hintsIn parseResults (checkResults: FSharpCheckFileResults) startLine endLine =
    checkResults.GetAllUsesOfAllSymbolsInFile()
    |> Seq.filter (fun symbolUse ->
        let range = symbolUse.Range
        range.StartLine - 1 >= startLine && range.StartLine - 1 <= endLine)
    |> Seq.collect (fun symbolUse ->
        typeHint parseResults symbolUse
        @ parameterHints parseResults symbolUse
        @ pipelineHint symbolUse)
    |> List.ofSeq

/// Get inlay hints for an F# file. The overlay-aware `checkFileWithParse`
/// supplies the live buffer text. [HOVER-FSHARP-OVERLAY]
let getInlayHints (state: FSharpWorkspace.FSharpWorkspaceState) (filePath: string) (startLine: int) (endLine: int) =
    task {
        try
            match! FSharpWorkspace.checkFileWithParse state filePath with
            | Some(parseResults, checkResults, _) -> return hintsIn parseResults checkResults startLine endLine
            | None -> return []
        with ex ->
            Log.Debug(ex, "[F# InlayHints] failed")
            return []
    }
