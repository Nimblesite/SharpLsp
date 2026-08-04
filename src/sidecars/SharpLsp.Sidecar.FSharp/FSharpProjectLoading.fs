/// Project and script option construction for FSharp.Compiler.Service.
module SharpLsp.Sidecar.FSharp.FSharpProjectLoading

open System
open System.IO
open System.Reflection
open System.Threading
open System.Xml.Linq
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Text
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Solutions

let parseFsprojSourceFiles (fsprojPath: string) : string array =
    let document = XDocument.Load(fsprojPath)
    let projectDirectory = Path.GetDirectoryName(fsprojPath) |> string

    document.Descendants(XName.Get("Compile"))
    |> Seq.choose (fun element ->
        element.Attribute(XName.Get("Include"))
        |> Option.ofObj
        |> Option.map (fun attribute -> Path.GetFullPath(Path.Combine(projectDirectory, attribute.Value))))
    |> Seq.toArray

let parseFsprojOtherFlags (fsprojPath: string) : string array =
    let separators = [| ' '; '\t'; '\r'; '\n' |]

    XDocument.Load(fsprojPath).Descendants(XName.Get("OtherFlags"))
    |> Seq.collect (fun element -> element.Value.Split(separators, StringSplitOptions.RemoveEmptyEntries))
    |> Seq.filter (fun value -> not (value.StartsWith("$(", StringComparison.Ordinal)))
    |> Seq.toArray

let private validAssemblyName (value: string) =
    let trimmed = value.Trim()

    if
        String.IsNullOrWhiteSpace(trimmed)
        || trimmed.Contains("$(", StringComparison.Ordinal)
    then
        None
    else
        Some trimmed

let parseFsprojAssemblyName (fsprojPath: string) =
    let explicitName =
        XDocument.Load(fsprojPath).Descendants(XName.Get("AssemblyName"))
        |> Seq.choose (_.Value >> validAssemblyName)
        |> Seq.tryLast

    explicitName
    |> Option.defaultValue (Path.GetFileNameWithoutExtension(fsprojPath) |> string)

let private isOutputFlag (value: string) =
    value.StartsWith("--out:", StringComparison.OrdinalIgnoreCase)
    || value.StartsWith("-o:", StringComparison.OrdinalIgnoreCase)

let private projectIdentityArgs fsprojPath projectFlags =
    if projectFlags |> Array.exists isOutputFlag then
        [||]
    else
        [| $"--out:{parseFsprojAssemblyName fsprojPath}.dll" |]

let private isFsprojPath (path: string) =
    path.EndsWith(".fsproj", StringComparison.OrdinalIgnoreCase)

let private isSolutionPath (path: string) =
    path.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)
    || path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase)

let isScriptPath (path: string) =
    path.EndsWith(".fsx", StringComparison.OrdinalIgnoreCase)
    || path.EndsWith(".fsscript", StringComparison.OrdinalIgnoreCase)

let private outcomeError (result: Outcome.Result<SolutionFileModel, string>) =
    result.Match((fun _ -> String.Empty), (fun error -> error))

let private outcomeValue (result: Outcome.Result<SolutionFileModel, string>) : SolutionFileModel =
    result.Match((fun value -> value), (fun error -> invalidOp error))

let private solutionProjects (model: SolutionFileModel) =
    model.Projects
    |> Seq.filter (fun (project: SolutionProjectEntry) -> isFsprojPath project.Path)
    |> Seq.map (fun (project: SolutionProjectEntry) -> project.Path)
    |> Seq.toArray

let private fsprojFilesFromSolution (path: string) (ct: CancellationToken) =
    task {
        let! readResult = SolutionFileReader.ReadAsync(path, ct)

        if readResult.IsError then
            return Error(outcomeError readResult)
        else
            return Ok(readResult |> outcomeValue |> solutionProjects)
    }

let discoverFsprojFiles (path: string) (ct: CancellationToken) =
    task {
        let fullPath = Path.GetFullPath(path)

        if File.Exists(fullPath) && isFsprojPath fullPath then
            return Ok [| fullPath |]
        elif File.Exists(fullPath) && isSolutionPath fullPath then
            return! fsprojFilesFromSolution fullPath ct
        elif Directory.Exists(fullPath) then
            return Ok(Directory.GetFiles(fullPath, "*.fsproj", SearchOption.AllDirectories))
        else
            return Error $"Path does not exist: {path}"
    }

let private isManagedAssembly (path: string) =
    try
        AssemblyName.GetAssemblyName(path) |> ignore
        true
    with _ ->
        false

let private runtimeReferenceArgs () =
    Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory()
    |> fun directory -> Directory.GetFiles(directory, "*.dll")
    |> Array.filter isManagedAssembly
    |> Array.map (fun assemblyPath -> $"-r:{assemblyPath}")

let private fsharpCoreReferenceArgs () =
    let assemblyPath = typeof<unit>.Assembly.Location

    if String.IsNullOrEmpty(assemblyPath) || not (File.Exists assemblyPath) then
        [||]
    else
        [| $"-r:{assemblyPath}" |]

/// Compiler references shared by project loading and package analysis.
let frameworkReferenceArgs () : string array =
    [| yield "--noframework"
       yield "--targetprofile:netcore"
       yield! runtimeReferenceArgs ()
       yield! fsharpCoreReferenceArgs () |]

let private packageReferenceArgs fsprojPath =
    FSharpAssets.parseAssets fsprojPath
    |> Option.map (snd >> FSharpAssets.packageReferenceArgs)
    |> Option.defaultValue [||]

let private projectReferenceArg projectPath =
    ProjectReferences.FindOutputAssembly(projectPath)
    |> Option.ofObj
    |> Option.map (fun assemblyPath -> $"-r:{assemblyPath}")

let private projectReferenceArgs fsprojPath =
    ProjectReferences.ReadReferencedProjects(fsprojPath)
    |> Seq.filter (fun project -> project.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
    |> Seq.choose projectReferenceArg
    |> Seq.toArray

let private compilerArgs fsprojPath projectFlags =
    Array.concat
        [ frameworkReferenceArgs ()
          packageReferenceArgs fsprojPath
          projectReferenceArgs fsprojPath
          projectIdentityArgs fsprojPath projectFlags
          projectFlags ]

/// Build persistent FCS options with explicit source files and all references.
let buildProjectOptions (checker: FSharpChecker) (fsprojPath: string) : FSharpProjectOptions =
    let sourceFiles = parseFsprojSourceFiles fsprojPath
    let projectFlags = parseFsprojOtherFlags fsprojPath
    let otherOptions = compilerArgs fsprojPath projectFlags

    let options =
        checker.GetProjectOptionsFromCommandLineArgs(fsprojPath, Array.append otherOptions sourceFiles)

    { options with
        SourceFiles = sourceFiles }

let scriptOptions (checker: FSharpChecker) (scriptPath: string) (source: string) (ct: CancellationToken) =
    let flags = [| "--define:INTERACTIVE"; "--define:EDITING" |]

    checker.GetProjectOptionsFromScript(
        scriptPath,
        SourceText.ofString source,
        otherFlags = flags,
        useFsiAuxLib = true,
        useSdkRefs = true,
        assumeDotNetFramework = false
    )
    |> fun computation -> Async.StartAsTask(computation, cancellationToken = ct)
