/// Manages the F# workspace: project loading and semantic queries via FCS.
module Forge.Sidecar.FSharp.FSharpWorkspace

open System
open System.IO
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Text
open FSharp.Compiler.Tokenization
open Forge.Sidecar.FSharp.Hover

/// Definition result: file path + start line/col + end line/col (0-based).
type DefinitionLocation =
    { FilePath: string
      Line: int
      Character: int
      EndLine: int
      EndCharacter: int }

/// Workspace state holding the FSharpChecker and loaded project options.
[<NoComparison; NoEquality>]
type FSharpWorkspaceState =
    { Checker: FSharpChecker
      mutable ProjectOptions: FSharpProjectOptions option
      mutable IsLoaded: bool }

/// Create a new workspace with an FSharpChecker.
let create () : FSharpWorkspaceState =
    let checker = FSharpChecker.Create(keepAssemblyContents = true)
    { Checker = checker
      ProjectOptions = None
      IsLoaded = false }

/// Load a project from a path (finds .fsproj or .fsx).
let loadProject (state: FSharpWorkspaceState) (path: string) =
    task {
        try
            // For now, create script-based options.
            // Full .fsproj support requires Ionide.ProjInfo (Phase 3).
            let dummyScript = Path.Combine(path, "script.fsx")
            let! options, _diagnostics =
                state.Checker.GetProjectOptionsFromScript(
                    dummyScript,
                    SourceText.ofString "",
                    assumeDotNetFramework = false)
            state.ProjectOptions <- Some options
            state.IsLoaded <- true
            eprintfn $"F# workspace loaded from {path}"
            return Ok()
        with ex ->
            eprintfn $"F# workspace load failed: {ex.Message}"
            return Error ex.Message
    }

/// Extract hover from FSharpCheckFileResults.
let private extractToolTip
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : (string * int * int * int * int) option =
    let lines = source.Split('\n')
    if line >= lines.Length then
        None
    else
        let lineText = lines[line]
        // FCS uses 1-based lines.
        let fcsLine = line + 1

        // Find the identifier at the position.
        let island =
            QuickParse.GetCompleteIdentifierIsland true lineText character

        match island with
        | None -> None
        | Some(name, _, _) ->
            let names = [ name ]
            let tip =
                checkResults.GetToolTip(
                    fcsLine, character, lineText, names, FSharpTokenTag.Identifier)

            match FSharpHoverBuilder.renderToolTip tip with
            | Some markdown ->
                Some(markdown, line, character, line, character + name.Length)
            | None -> None

/// Get hover information at a position in an F# file.
let getHover
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            if not state.IsLoaded then
                return None
            else
                let source = File.ReadAllText(filePath)
                let sourceText = SourceText.ofString source

                let! _parseResults, checkAnswer =
                    state.Checker.ParseAndCheckFileInProject(
                        filePath,
                        0,
                        sourceText,
                        state.ProjectOptions.Value)

                match checkAnswer with
                | FSharpCheckFileAnswer.Succeeded checkResults ->
                    return extractToolTip checkResults source line character
                | FSharpCheckFileAnswer.Aborted ->
                    eprintfn "[F# Hover] Check aborted"
                    return None
        with ex ->
            eprintfn $"[F# Hover] Exception: {ex.Message}"
            return None
    }

// ── Definition ───────────────────────────────────────────────────

/// Parse and check a file, returning check results if successful.
let private checkFile
    (state: FSharpWorkspaceState)
    (filePath: string)
    =
    task {
        if not state.IsLoaded then
            return None
        else
            let source = File.ReadAllText(filePath)
            let sourceText = SourceText.ofString source

            let! _parseResults, checkAnswer =
                state.Checker.ParseAndCheckFileInProject(
                    filePath,
                    0,
                    sourceText,
                    state.ProjectOptions.Value)

            match checkAnswer with
            | FSharpCheckFileAnswer.Succeeded checkResults ->
                return Some(checkResults, source)
            | FSharpCheckFileAnswer.Aborted ->
                return None
    }

/// Extract declaration location from FCS check results.
let private extractDefinition
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : DefinitionLocation option =
    let lines = source.Split('\n')
    if line >= lines.Length then
        None
    else
        let lineText = lines[line]
        let fcsLine = line + 1

        let island =
            QuickParse.GetCompleteIdentifierIsland true lineText character

        match island with
        | None -> None
        | Some(name, _, _) ->
            let names = [ name ]
            let declResult =
                checkResults.GetDeclarationLocation(
                    fcsLine, character, lineText, names)

            match declResult with
            | FindDeclResult.DeclFound declRange ->
                Some
                    { FilePath = declRange.FileName
                      Line = declRange.StartLine - 1
                      Character = declRange.StartColumn
                      EndLine = declRange.EndLine - 1
                      EndCharacter = declRange.EndColumn }
            | FindDeclResult.DeclNotFound _
            | FindDeclResult.ExternalDecl _ ->
                None

/// Get definition location at a position in an F# file.
let getDefinition
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractDefinition checkResults source line character
            | None ->
                return None
        with ex ->
            eprintfn $"[F# Definition] Exception: {ex.Message}"
            return None
    }

// ── Shared helpers ──────────────────────────────────────────────

/// Convert an FCS Range to a DefinitionLocation (1-based → 0-based).
let private rangeToLocation (r: FSharp.Compiler.Text.Range) =
    if r.FileName = "" then None
    else
        Some
            { FilePath = r.FileName
              Line = r.StartLine - 1
              Character = r.StartColumn
              EndLine = r.EndLine - 1
              EndCharacter = r.EndColumn }

/// Get the symbol use at a given 0-based position.
let private getSymbolUse
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    =
    let lines = source.Split('\n')
    if line >= lines.Length then None
    else
        let lineText = lines[line]
        let fcsLine = line + 1
        checkResults.GetSymbolUseAtLocation(
            fcsLine, character, lineText, [])

/// Extract the type entity from an FSharpType.
let private getTypeEntity (ty: FSharpType) =
    if ty.HasTypeDefinition then Some ty.TypeDefinition
    else None

// ── Type Definition ─────────────────────────────────────────────

/// Extract type definition location from a symbol use.
let private extractTypeDefinition
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : DefinitionLocation option =
    match getSymbolUse checkResults source line character with
    | None -> None
    | Some su ->
        let typeEntity =
            match su.Symbol with
            | :? FSharpMemberOrFunctionOrValue as mfv ->
                mfv.FullType |> getTypeEntity
            | :? FSharpField as field ->
                field.FieldType |> getTypeEntity
            | :? FSharpEntity as ent -> Some ent
            | _ -> None
        match typeEntity with
        | Some ent -> rangeToLocation ent.DeclarationLocation
        | None -> None

/// Get the type definition location at a position.
let getTypeDefinition
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractTypeDefinition checkResults source line character
            | None -> return None
        with ex ->
            eprintfn $"[F# TypeDefinition] Exception: {ex.Message}"
            return None
    }

// ── Declaration ─────────────────────────────────────────────────

/// Find the interface or base member declaration for an override.
let private findBaseMember
    (mfv: FSharpMemberOrFunctionOrValue)
    : DefinitionLocation option =
    if not mfv.IsOverrideOrExplicitInterfaceImplementation then
        None
    else
        match mfv.DeclaringEntity with
        | Some ent ->
            let baseLoc =
                ent.AllInterfaces
                |> Seq.tryPick (fun iface ->
                    if not iface.HasTypeDefinition then None
                    else
                        iface.TypeDefinition.MembersFunctionsAndValues
                        |> Seq.tryFind (fun m ->
                            m.DisplayName = mfv.DisplayName)
                        |> Option.bind (fun m ->
                            rangeToLocation m.DeclarationLocation))
            baseLoc
        | None -> None

/// Extract declaration location (base/interface for overrides).
let private extractDeclaration
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : DefinitionLocation option =
    match getSymbolUse checkResults source line character with
    | None -> None
    | Some su ->
        match su.Symbol with
        | :? FSharpMemberOrFunctionOrValue as mfv ->
            match findBaseMember mfv with
            | Some loc -> Some loc
            | None -> rangeToLocation mfv.DeclarationLocation
        | _ ->
            extractDefinition checkResults source line character

/// Get the declaration location at a position.
let getDeclaration
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractDeclaration checkResults source line character
            | None -> return None
        with ex ->
            eprintfn $"[F# Declaration] Exception: {ex.Message}"
            return None
    }

// ── Implementation ──────────────────────────────────────────────

/// Extract implementations (fallback: symbol's own location).
let private extractImplementations
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : DefinitionLocation list =
    match getSymbolUse checkResults source line character with
    | None -> []
    | Some su ->
        match su.Symbol.DeclarationLocation with
        | Some declRange ->
            match rangeToLocation declRange with
            | Some loc -> [ loc ]
            | None -> []
        | None -> []

/// Get implementation locations at a position.
let getImplementations
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractImplementations checkResults source line character
            | None -> return []
        with ex ->
            eprintfn $"[F# Implementation] Exception: {ex.Message}"
            return []
    }
