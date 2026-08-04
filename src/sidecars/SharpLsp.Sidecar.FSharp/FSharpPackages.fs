/// [PKG-UNUSED-DETECT-FS] Unused-package detection for F# projects.
///
/// Runs a project-wide check against the shared workspace options
/// ([FSharpWorkspace.buildProjectOptions], which already resolve the restored
/// compile assemblies from obj/project.assets.json via [FSharpAssets]) and
/// reports which referenced assemblies are actually used. The host's
/// [PKG-UNUSED-MAP] then maps assemblies → packages.
///
/// Fail-safe by construction: missing assets, a failed check, or zero symbol
/// uses all yield an empty `All` set, so the host flags nothing on uncertainty.
module SharpLsp.Sidecar.FSharp.FSharpPackages

open System
open System.Threading.Tasks
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open Serilog

/// Reference-usage for a project: used + all package assemblies + packages root.
[<NoComparison; NoEquality>]
type UsedReferences =
    { Used: string array
      All: string array
      Root: string }

/// Fail-safe empty result — the host flags nothing.
let private emptyUsage = { Used = [||]; All = [||]; Root = "" }

/// Assembly simple name owning a symbol, if determinable.
let private assemblyOf (sym: FSharpSymbol) : string option =
    match sym with
    | :? FSharpEntity as e -> Some(e.Assembly.SimpleName |> string)
    | :? FSharpMemberOrFunctionOrValue as m ->
        m.DeclaringEntity |> Option.map (fun e -> e.Assembly.SimpleName |> string)
    | _ -> None

/// Lowercased simple names of the assemblies actually used by symbol uses.
let private usedAssemblyNames (allUses: FSharpSymbolUse array) : Set<string> =
    allUses
    |> Seq.choose (fun (su: FSharpSymbolUse) ->
        try
            assemblyOf su.Symbol
        with _ ->
            None)
    |> Seq.choose (fun name ->
        if String.IsNullOrEmpty name then
            None
        else
            Some(name.ToLowerInvariant()))
    |> Set.ofSeq

/// Compute reference usage for an .fsproj. Fail-safe: any error → empty `All`.
let getReferenceUsage
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (fsprojPath: string)
    : Task<UsedReferences> =
    task {
        try
            match FSharpAssets.parseAssets fsprojPath with
            | None -> return emptyUsage
            | Some(root, assemblies) when List.isEmpty assemblies -> return { emptyUsage with Root = root }
            | Some(root, assemblies) ->
                let options = FSharpWorkspace.buildProjectOptions state fsprojPath
                let! results = state.Checker.ParseAndCheckProject(options)
                let allUses = results.GetAllUsesOfAllSymbols()

                if results.HasCriticalErrors || Array.isEmpty allUses then
                    return { emptyUsage with Root = root }
                else
                    let used = usedAssemblyNames allUses
                    let allPaths = assemblies |> List.map (fun a -> a.Path) |> List.toArray

                    let usedPaths =
                        assemblies
                        |> List.filter (fun a -> used.Contains(a.Simple.ToLowerInvariant()))
                        |> List.map (fun a -> a.Path)
                        |> List.toArray

                    return { Used = usedPaths; All = allPaths; Root = root }
        with ex ->
            Log.Debug(ex, "[F# Packages] usage failed")
            return emptyUsage
    }
