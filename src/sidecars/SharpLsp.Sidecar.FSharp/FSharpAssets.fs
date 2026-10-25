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
open SharpLsp.Sidecar.Common

/// A restored package compile assembly: simple name + absolute path.
[<NoComparison; NoEquality>]
type PackageAssembly = { Simple: string; Path: string }

/// Path to a project's restored assets file.
let private assetsPath (fsprojPath: string) =
    NativePaths.Resolve(NativePaths.DirectoryOf fsprojPath, "obj", "project.assets.json")

/// Try to read an object property.
let private tryProp (el: JsonElement) (name: string) : JsonElement option =
    match el.TryGetProperty(name) with
    | true, value -> Some value
    | false, _ -> None

/// SDK package roots retain their declared precedence, including fallback caches.
let private folderNames (el: JsonElement) : string list =
    if el.ValueKind = JsonValueKind.Object then
        el.EnumerateObject() |> Seq.map (fun p -> p.Name) |> Seq.toList
    else
        []

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
    // NuGet lays a package out under its lower-cased id/version: a layout rule, not path identity.
    | _ -> key.ToLowerInvariant()

/// Resolve each compile input against every SDK root before filtering missing files.
let private assemblyPath roots library file =
    let candidates = roots |> List.map (fun root -> NativePaths.Resolve(root, library, file))
    candidates |> List.tryFind File.Exists |> Option.orElse (List.tryHead candidates)

/// A placeholder never reaches FCS; physical fallback assemblies preserve their identity.
let private compileAssembly roots library (file: JsonProperty) =
    // NuGet placeholders can exist physically inside a path-qualified compile item (#160).
    if NativePaths.SameName(file.Name, "_._") then None
    else
        assemblyPath roots library file.Name
        |> Option.map (fun path -> { Simple = NativePaths.StemOf file.Name; Path = path })

/// Compile assemblies declared by one target-framework package entry.
let private packageAssemblies roots libraries key (entry: JsonElement) : PackageAssembly seq =
    match tryProp entry "compile" with
    | Some compile when compile.ValueKind = JsonValueKind.Object ->
        let libPath = libraryPath libraries key

        compile.EnumerateObject() |> Seq.choose (compileAssembly roots libPath)
    | _ -> Seq.empty

/// Decode one SDK snapshot without separating roots from their compile entries.
let private documentAssets (document: JsonElement) =
    let roots = tryProp document "packageFolders" |> Option.map folderNames |> Option.defaultValue []
    let libraries = tryProp document "libraries"
    match tryProp document "targets" |> Option.bind firstValue with
    | Some target when target.ValueKind = JsonValueKind.Object ->
        let assemblies =
            target.EnumerateObject()
            |> Seq.collect (fun pkg -> packageAssemblies roots libraries pkg.Name pkg.Value)
            |> Seq.toList
        Some(roots |> List.tryHead |> Option.defaultValue "", assemblies)
    | _ -> None

/// Parse physical compile assemblies and preserve the SDK's primary root metadata.
let parseAssets (fsprojPath: string) : (string * PackageAssembly list) option =
    let path = assetsPath fsprojPath

    if not (File.Exists path) then
        None
    else
        try
            use doc = JsonDocument.Parse(File.ReadAllText path)
            documentAssets doc.RootElement
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

/// The restored packages of `fsprojPath` that have left the disk since it was restored,
/// as clearing the NuGet cache leaves them: its assets file names them, no package folder
/// holds them. None for a project never restored, or whose assets file cannot be read.
/// [DIAG-RESTORE]
let missingPackages (fsprojPath: string) : string list =
    PackageAssets.MissingPackages(fsprojPath).Match(
        (fun packages -> List.ofArray packages),
        (fun _ ->
            Log.Debug("F# project package assets could not be read for {Project}", fsprojPath)
            []))
