/// [PKG-UNUSED-DETECT-FS] Unused-package detection for F# projects.
///
/// The persistent workspace options omit NuGet refs, so this module builds an
/// *isolated* FSharpProjectOptions that includes the project's restored compile
/// assemblies (from obj/project.assets.json), runs a project-wide check, and
/// reports which referenced assemblies are actually used. The host's
/// [PKG-UNUSED-MAP] then maps assemblies → packages.
///
/// Fail-safe by construction: missing assets, a failed check, or zero symbol
/// uses all yield an empty `All` set, so the host flags nothing on uncertainty.
module SharpLsp.Sidecar.FSharp.FSharpPackages

open System
open System.IO
open System.Text.Json
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

/// A restored package compile assembly: simple name + absolute path.
[<NoComparison; NoEquality>]
type private PackageAssembly = { Simple: string; Path: string }

/// Fail-safe empty result — the host flags nothing.
let private emptyUsage = { Used = [||]; All = [||]; Root = "" }

/// Path to a project's restored assets file.
let private assetsPath (fsprojPath: string) =
    let dir = Path.GetDirectoryName(fsprojPath) |> string
    Path.Combine(dir, "obj", "project.assets.json")

/// Try to read an object property.
let private tryProp (el: JsonElement) (name: string) : JsonElement option =
    match el.TryGetProperty(name) with
    | true, value -> Some value
    | false, _ -> None

/// First property name of an object element, if any.
let private firstName (el: JsonElement) : string option =
    if el.ValueKind = JsonValueKind.Object then
        el.EnumerateObject() |> Seq.map (fun p -> p.Name) |> Seq.tryHead
    else
        None

/// First property value of an object element, if any.
let private firstValue (el: JsonElement) : JsonElement option =
    if el.ValueKind = JsonValueKind.Object then
        el.EnumerateObject() |> Seq.map (fun p -> p.Value) |> Seq.tryHead
    else
        None

/// Folder path (relative to the packages root) for a library key.
let private libraryPath (libraries: JsonElement option) (key: string) : string =
    let fromLibraries =
        libraries
        |> Option.bind (fun lib -> tryProp lib key)
        |> Option.bind (fun entry -> tryProp entry "path")
        |> Option.map (fun path -> path.GetString() |> string)

    match fromLibraries with
    | Some path when not (String.IsNullOrEmpty path) -> path
    | _ -> key.ToLowerInvariant()

/// Replace forward slashes with the platform path separator.
let private toLocal (rel: string) = rel.Replace('/', Path.DirectorySeparatorChar)

/// Compile assemblies declared by one target-framework package entry.
let private packageAssemblies
    (root: string)
    (libraries: JsonElement option)
    (key: string)
    (entry: JsonElement)
    : PackageAssembly seq =
    match tryProp entry "compile" with
    | Some compile when compile.ValueKind = JsonValueKind.Object ->
        let libPath = libraryPath libraries key

        compile.EnumerateObject()
        |> Seq.choose (fun file ->
            if file.Name = "_._" then
                None
            else
                let abs = Path.Combine(root, toLocal libPath, toLocal file.Name)
                let simple = Path.GetFileNameWithoutExtension(file.Name) |> string
                Some { Simple = simple; Path = abs })
    | _ -> Seq.empty

/// Parse compile assemblies + packages root from project.assets.json.
let private parseAssets (path: string) : (string * PackageAssembly list) option =
    if not (File.Exists path) then
        None
    else
        try
            use doc = JsonDocument.Parse(File.ReadAllText path)
            let rootEl = doc.RootElement

            let root =
                tryProp rootEl "packageFolders"
                |> Option.bind firstName
                |> Option.defaultValue ""

            let libraries = tryProp rootEl "libraries"
            let target = tryProp rootEl "targets" |> Option.bind firstValue

            match target with
            | Some targetEl when targetEl.ValueKind = JsonValueKind.Object ->
                let assemblies =
                    targetEl.EnumerateObject()
                    |> Seq.collect (fun pkg -> packageAssemblies root libraries pkg.Name pkg.Value)
                    |> Seq.toList

                Some(root, assemblies)
            | _ -> None
        with ex ->
            Log.Debug(ex, "[F# Packages] assets parse failed")
            None

/// Build isolated project options that resolve the restored package references.
let private projectOptions
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (fsprojPath: string)
    (assemblies: PackageAssembly list)
    =
    let sources = FSharpWorkspace.parseFsprojSourceFiles fsprojPath
    let packageRefs = assemblies |> List.map (fun a -> $"-r:{a.Path}") |> List.toArray
    let other = Array.append (FSharpWorkspace.frameworkReferenceArgs ()) packageRefs
    state.Checker.GetProjectOptionsFromCommandLineArgs(fsprojPath, Array.append other sources)

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
            match parseAssets (assetsPath fsprojPath) with
            | None -> return emptyUsage
            | Some(root, assemblies) when List.isEmpty assemblies -> return { emptyUsage with Root = root }
            | Some(root, assemblies) ->
                let options = projectOptions state fsprojPath assemblies
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
