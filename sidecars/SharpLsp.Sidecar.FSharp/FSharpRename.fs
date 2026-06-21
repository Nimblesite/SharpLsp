/// Rename + prepare-rename for the F# sidecar via FCS, project-wide.
/// Implements [FS-RENAME-PREPARE] / [FS-RENAME-APPLY].
module SharpLsp.Sidecar.FSharp.FSharpRename

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Tokenization
open Serilog

/// Prepare-rename result: the identifier token range + the symbol's current name.
type PrepareRename =
    { StartLine: int
      StartCharacter: int
      EndLine: int
      EndCharacter: int
      Placeholder: string }

/// A symbol is renameable only if it is declared in the project's own sources
/// (not the BCL / FSharp.Core / a NuGet dependency) and is not a namespace.
let private canRename (state: FSharpWorkspace.FSharpWorkspaceState) (symbol: FSharpSymbol) =
    match symbol with
    | :? FSharpEntity as ent when ent.IsNamespace -> false
    | _ -> FSharpWorkspace.isSymbolInProject state symbol

/// Pure prepare-rename computation over an already-checked file. Kept separate
/// from the `task` so the async wrapper has a single bind + single return — the
/// shape FCS can compile to a static state machine (avoids FS3511).
let private computePrepare
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : PrepareRename option =
    match FSharpWorkspace.getSymbolUse checkResults source line character with
    | Some su when canRename state su.Symbol ->
        let lines = source.Split('\n')
        let lineText = lines[line]
        match QuickParse.GetCompleteIdentifierIsland true lineText character with
        | Some(name, endCol, _) ->
            Some
                { StartLine = line
                  StartCharacter = max 0 (endCol - name.Length)
                  EndLine = line
                  EndCharacter = endCol
                  Placeholder = su.Symbol.DisplayName }
        | None -> None
    | _ -> None

/// Check whether the symbol at a position can be renamed, returning its token range.
let prepareRename
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            return
                fileCheck
                |> Option.bind (fun (checkResults, source) ->
                    computePrepare state checkResults source line character)
        with ex ->
            Log.Debug(ex, "[F# PrepareRename] failed")
            return None
    }

/// Build a replacement edit for one use of the symbol. Only the trailing
/// identifier segment is rewritten, so qualified uses (`Module.name`) keep the
/// qualifier and only `name` is replaced.
let private editForUse
    (newName: string)
    (displayName: string)
    (su: FSharpSymbolUse)
    : FSharpCodeActions.RawEdit option =
    let r = su.Range
    if r.FileName = "" then
        None
    else
        Some
            { FilePath = r.FileName
              StartLine = r.EndLine - 1
              StartCharacter = max 0 (r.EndColumn - displayName.Length)
              EndLine = r.EndLine - 1
              EndCharacter = r.EndColumn
              NewText = newName }

/// Rename the symbol at a position to `newName` across the whole project.
/// Returns the flat list of edits; the handler groups them per document.
let rename
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    (newName: string)
    =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            match fileCheck with
            | None -> return []
            | Some(checkResults, source) ->
                match FSharpWorkspace.getSymbolUse checkResults source line character with
                | Some su when not (canRename state su.Symbol) -> return []
                | Some su ->
                    let! uses = FSharpReferences.getProjectUsages state filePath line character
                    let displayName = su.Symbol.DisplayName
                    return uses |> Array.choose (editForUse newName displayName) |> Array.toList
                | None -> return []
        with ex ->
            Log.Debug(ex, "[F# Rename] failed")
            return []
    }
