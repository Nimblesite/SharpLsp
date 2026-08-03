/// Reference-count code lenses for the F# sidecar via FCS. Implements
/// [FS-CODELENS] — a "N references" lens above every top-level definition.
module SharpLsp.Sidecar.FSharp.FSharpCodeLens

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open Serilog

/// A code lens in the sidecar's neutral domain shape (mirror of CodeLensResult).
type CodeLensEntry =
    { Line: int
      Character: int
      Title: string }

/// Pluralize the reference count exactly as the C# CodeLensResolver does.
let private formatTitle (count: int) : string =
    match count with
    | 0 -> "0 references"
    | 1 -> "1 reference"
    | n -> $"{n} references"

/// Whether a definition symbol use deserves a reference-count lens: types and
/// modules (not namespaces) and module-level values/functions/members.
let private isLensable (su: FSharpSymbolUse) : bool =
    su.IsFromDefinition
    && (match su.Symbol with
        | :? FSharpEntity as ent -> not ent.IsNamespace
        | :? FSharpMemberOrFunctionOrValue as mfv -> mfv.IsModuleValueOrMember
        | _ -> false)

/// Get reference-count lenses for every top-level definition in a file.
let getCodeLenses (state: FSharpWorkspace.FSharpWorkspaceState) (filePath: string) =
    task {
        try
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            match fileCheck with
            | None -> return []
            | Some(checkResults, _source) ->
                let! proj = FSharpWorkspace.checkProject state
                match proj with
                | None -> return []
                | Some projResults ->
                    let definitions =
                        checkResults.GetAllUsesOfAllSymbolsInFile()
                        |> Seq.filter isLensable
                        |> Seq.toArray
                    return
                        definitions
                        |> Array.choose (fun (su: FSharpSymbolUse) ->
                            let r = su.Range
                            if r.FileName = "" then
                                None
                            else
                                let refCount =
                                    projResults.GetUsesOfSymbol(su.Symbol)
                                    |> Array.filter (fun u -> not u.IsFromDefinition)
                                    |> Array.length
                                Some
                                    { Line = r.StartLine - 1
                                      Character = r.StartColumn
                                      Title = formatTitle refCount })
                        |> Array.toList
        with ex ->
            Log.Debug(ex, "[F# CodeLens] failed")
            return []
    }
