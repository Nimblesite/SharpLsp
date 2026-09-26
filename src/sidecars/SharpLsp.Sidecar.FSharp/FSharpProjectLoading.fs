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
    let projectDirectory = NativePaths.DirectoryOf fsprojPath

    document.Descendants(XName.Get("Compile"))
    |> Seq.choose (fun element ->
        element.Attribute(XName.Get("Include"))
        |> Option.ofObj
        |> Option.map (fun attribute -> NativePaths.Resolve(projectDirectory, attribute.Value)))
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
    |> Option.defaultValue (NativePaths.StemOf fsprojPath)

let private isOutputFlag (value: string) =
    value.StartsWith("--out:", StringComparison.OrdinalIgnoreCase)
    || value.StartsWith("-o:", StringComparison.OrdinalIgnoreCase)

let private projectIdentityArgs fsprojPath projectFlags =
    if projectFlags |> Array.exists isOutputFlag then
        [||]
    else
        [| $"--out:{parseFsprojAssemblyName fsprojPath}.dll" |]

let private isFsprojPath (path: string) = NativePaths.HasExtension(path, ".fsproj")

let private isSolutionPath (path: string) =
    NativePaths.HasExtension(path, ".sln") || NativePaths.HasExtension(path, ".slnx")

let isScriptPath (path: string) =
    NativePaths.HasExtension(path, ".fsx") || NativePaths.HasExtension(path, ".fsscript")

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
        let fullPath = NativePaths.NormalizeFullPath path

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

/// The sidecar runtime's references never change within a process, and reading every
/// runtime assembly's header is paid once, however many projects load.
let private runtimeReferences =
    lazy
        [| yield "--noframework"
           yield "--targetprofile:netcore"
           yield! runtimeReferenceArgs ()
           yield! fsharpCoreReferenceArgs () |]

/// Compiler references shared by project loading and package analysis.
let frameworkReferenceArgs () : string array = Array.copy runtimeReferences.Value

let private packageReferenceArgs fsprojPath =
    FSharpAssets.parseAssets fsprojPath
    |> Option.map (snd >> FSharpAssets.packageReferenceArgs)
    |> Option.defaultValue [||]

let private projectReferenceArg projectPath =
    ProjectReferences.FindOutputAssembly(projectPath)
    |> Option.ofObj
    |> Option.map (fun assemblyPath -> $"-r:{assemblyPath}")

/// The projects `fsprojPath` references whose project file ends in `extension`.
let referencedProjects (extension: string) (fsprojPath: string) =
    ProjectReferences.ReadReferencedProjects(fsprojPath)
    |> Seq.filter (fun project -> NativePaths.HasExtension(project, extension))

/// The prefix among `prefixes` that compiler argument `arg` starts with, and its value.
let flagValue (prefixes: string list) (arg: string) =
    prefixes
    |> List.tryFind (fun prefix -> arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
    |> Option.map (fun prefix -> prefix, arg.Substring prefix.Length)

/// A C# project is referenced as its built assembly: FCS cannot read C# source.
let private projectReferenceArgs fsprojPath =
    referencedProjects ".csproj" fsprojPath
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
