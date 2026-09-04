/// Reference-count portion of [SHARPLSP-FEATURES-CODE-LENS]: an FCS-backed
/// "N references" lens above every top-level definition.
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

/// References to one definition symbol, excluding the definition itself.
let private referenceCount (projResults: FSharpCheckProjectResults) (symbol: FSharpSymbol) : int =
    projResults.GetUsesOfSymbol(symbol)
    |> Array.filter (fun u -> not u.IsFromDefinition)
    |> Array.length

/// One lens per ANCHOR, summing the counts of every definition that shares it.
///
/// `type Greeter(greeting: string)` is two definitions at one range — the
/// entity and its primary constructor — and emitting a lens for each stacked
/// "0 references | 1 reference" above a single declaration. Summing them is
/// what Roslyn's count for a class already is: uses of the name and
/// constructions of it, together.
let private lensesByAnchor (projResults: FSharpCheckProjectResults) (definitions: FSharpSymbolUse[]) =
    definitions
    |> Array.filter (fun su ->
        let anchor = su.Range
        anchor.FileName <> "")
    |> Array.groupBy (fun su ->
        let anchor = su.Range
        (anchor.StartLine, anchor.StartColumn))
    |> Array.map (fun ((line, column), group) ->
        { Line = line - 1
          Character = column
          Title = group |> Array.sumBy (fun su -> referenceCount projResults su.Symbol) |> formatTitle })
    |> Array.toList

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
                    return
                        checkResults.GetAllUsesOfAllSymbolsInFile()
                        |> Seq.filter isLensable
                        |> Seq.toArray
                        |> lensesByAnchor projResults
        with ex ->
            Log.Debug(ex, "[F# CodeLens] failed")
            return []
    }
