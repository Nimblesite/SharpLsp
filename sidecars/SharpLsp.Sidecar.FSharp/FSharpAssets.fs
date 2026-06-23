/// [PKG-ASSETS-FS] Restored-package reference resolution from project.assets.json.
///
/// Single source of truth for turning a project's restored NuGet packages into
/// FCS `-r:` reference arguments. Both the persistent workspace options
/// ([FSharpWorkspace.buildProjectOptions]) and the unused-package analysis
/// ([FSharpPackages]) consume this, so the reference set the compiler sees is
/// identical across diagnostics, hover, and usage analysis — a file that builds
/// must not report unresolved `open`s/types (issue #120).
///
/// Fail-safe by construction: a missing or malformed assets file yields `None`
/// and callers fall back to a framework-only reference set rather than crashing.
module SharpLsp.Sidecar.FSharp.FSharpAssets

open System
open System.IO
open System.Text.Json
open Serilog

/// A restored package compile assembly: simple name + absolute path.
[<NoComparison; NoEquality>]
type PackageAssembly = { Simple: string; Path: string }

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

/// Parse compile assemblies + packages root from a project's restored assets.
let parseAssets (fsprojPath: string) : (string * PackageAssembly list) option =
    let path = assetsPath fsprojPath

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
            Log.Debug(ex, "[F# Assets] assets parse failed")
            None

/// FCS `-r:` reference args for the compile assemblies that exist on disk.
/// Nonexistent paths (e.g. project-reference `bin/placeholder` entries) are
/// dropped so the compiler is never handed a missing-assembly reference — which
/// would itself surface as a false diagnostic.
let packageReferenceArgs (assemblies: PackageAssembly list) : string array =
    assemblies
    |> List.filter (fun assembly -> File.Exists assembly.Path)
    |> List.map (fun assembly -> $"-r:{assembly.Path}")
    |> List.toArray
