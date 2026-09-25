/// Per-framework FCS options for an F# project, read from MSBuild's design-time
/// build: the F# compiler task reports the exact command line it would run for ONE
/// target framework — its defines, references and globbed sources — without
/// compiling, and each reference MSBuild resolved from a project reference names the
/// framework of that project it picked. Implements [NETFX-PROJECTS-FSHARP].
module SharpLsp.Sidecar.FSharp.FSharpDesignTime

open System
open System.Collections.Concurrent
open System.Diagnostics
open System.IO
open System.Text.Json
open System.Threading
open System.Threading.Tasks
open System.Xml.Linq
open FSharp.Compiler.CodeAnalysis
open Serilog

/// A project reference MSBuild resolved for one framework: the assembly path its `-r:`
/// gives the compiler, the project that assembly is built from, and the framework of that
/// project MSBuild picked. [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]
type ResolvedReference =
    { Assembly: string
      Project: string
      Framework: string }

/// One loaded F# project and, when it targets several frameworks, the one it answers from.
[<NoComparison; NoEquality>]
type FSharpProjectEntry =
    {
        Path: string
        /// Every framework, in `<TargetFrameworks>` order; empty for a single-target project.
        Frameworks: string list
        mutable Active: string option
        mutable Options: FSharpProjectOptions
        /// Options already built, per framework.
        ByFramework: ConcurrentDictionary<string, FSharpProjectOptions>
        /// The project references MSBuild resolved for each framework built.
        Resolved: ConcurrentDictionary<string, ResolvedReference list>
    }

/// The design-time targets after which the compiler task has reported its arguments.
let private designTimeTargets =
    [ "ResolveAssemblyReferencesDesignTime"
      "ResolveProjectReferencesDesignTime"
      "ResolvePackageDependenciesDesignTime"
      "FindReferenceAssembliesForReferences"
      "_GenerateCompileDependencyCache"
      "BeforeBuild"
      "BeforeCompile"
      "CoreCompile" ]

/// Report the command line without compiling. `NonExistentFile` keeps CoreCompile from
/// being skipped as up to date, which would report nothing at all.
let private designTimeProperties (framework: string) =
    [ $"TargetFramework={framework}"
      "DesignTimeBuild=true"
      "SkipCompilerExecution=true"
      "ProvideCommandLineArgs=true"
      "BuildProjectReferences=false"
      @"NonExistentFile=__NonExistentSubDir__\__NonExistentFile__" ]

/// How long one evaluation or design-time build may take.
let private msbuildTimeout = TimeSpan.FromMinutes 3.0

/// Flags whose value is a path the compiler resolves against the project directory.
let private pathFlags = [ "-o:"; "--out:"; "-r:"; "--reference:"; "--doc:"; "--pdb:"; "--keyfile:" ]

let private startInfo (fsprojPath: string) (arguments: string list) =
    let info = ProcessStartInfo("dotnet")
    info.WorkingDirectory <- Path.GetDirectoryName fsprojPath |> string
    info.RedirectStandardOutput <- true
    info.RedirectStandardError <- true
    info.UseShellExecute <- false
    info.CreateNoWindow <- true

    for argument in [ "msbuild"; fsprojPath; "-nologo"; "-m:1"; "-nodeReuse:false" ] @ arguments do
        info.ArgumentList.Add argument

    info

let private stopProcess (proc: Process) =
    try
        proc.Kill(entireProcessTree = true)
        proc.WaitForExit(10_000) |> ignore
    with ex ->
        Log.Debug(ex, "Could not stop an MSBuild design-time build")

/// MSBuild's own account of a failure, on one line: the error lines it wrote, else
/// everything it wrote. A warning printed first — a state-file race, say — is not why
/// it failed, and a reason spread over several log lines hides the error behind it.
let private failureReason (exitCode: int) (detail: string) (text: string) =
    let lines =
        $"{detail}\n{text}".Split([| '\r'; '\n' |], StringSplitOptions.RemoveEmptyEntries)
        |> Array.map _.Trim()
        |> Array.filter (String.IsNullOrEmpty >> not)

    let errors =
        lines
        |> Array.filter (fun line -> line.Contains(": error ", StringComparison.OrdinalIgnoreCase))

    let shown = if errors.Length > 0 then errors else lines
    $"exit {exitCode}: {String.Join(' ', shown)}"

/// Wait for MSBuild, stopping it when it overruns or the caller gives up.
let private awaitMsbuild (proc: Process) (ct: CancellationToken) =
    task {
        use timeout = CancellationTokenSource.CreateLinkedTokenSource ct
        timeout.CancelAfter msbuildTimeout
        let output = proc.StandardOutput.ReadToEndAsync timeout.Token
        let error = proc.StandardError.ReadToEndAsync timeout.Token

        try
            do! proc.WaitForExitAsync timeout.Token
            let! text = output
            let! detail = error
            return if proc.ExitCode = 0 then Ok text else Error(failureReason proc.ExitCode detail text)
        with :? OperationCanceledException ->
            stopProcess proc
            return Error "MSBuild did not finish in time"
    }

/// Run `dotnet msbuild` on the project; its standard output, or why it failed.
let private runMsbuild (fsprojPath: string) (arguments: string list) (ct: CancellationToken) =
    task {
        match Process.Start(startInfo fsprojPath arguments) with
        | null -> return Error "Could not start dotnet msbuild"
        | started ->
            use proc = started
            return! awaitMsbuild proc ct
    }

/// The JSON document MSBuild prints for `-getProperty` / `-getItem`.
let private parseJson (text: string) =
    let start = text.IndexOf '{'
    if start < 0 then None else Some(JsonDocument.Parse(text.Substring start))

let private splitFrameworks (value: string) =
    value.Split(';', StringSplitOptions.RemoveEmptyEntries ||| StringSplitOptions.TrimEntries)
    |> Array.distinct
    |> List.ofArray

let private propertyOf (document: JsonDocument) (name: string) =
    match document.RootElement.TryGetProperty "Properties" with
    | true, properties ->
        match properties.TryGetProperty name with
        | true, value -> value.GetString() |> Option.ofObj
        | _ -> None
    | _ -> None

/// Whether the project file itself declares `<TargetFrameworks>`: the cheap test that
/// decides whether MSBuild is asked at all.
let declaresTargetFrameworks (fsprojPath: string) =
    XDocument.Load(fsprojPath).Descendants(XName.Get "TargetFrameworks") |> Seq.isEmpty |> not

/// The evaluated `<TargetFrameworks>`, in declared order.
let evaluateTargetFrameworks (fsprojPath: string) (ct: CancellationToken) =
    task {
        let! run = runMsbuild fsprojPath [ "-getProperty:TargetFrameworks"; "-getProperty:TargetFramework" ] ct

        return
            run
            |> Result.bind (fun text ->
                parseJson text
                |> Option.bind (fun document -> propertyOf document "TargetFrameworks")
                |> Option.map splitFrameworks
                |> function
                    | Some frameworks -> Ok frameworks
                    | None -> Error "MSBuild reported no TargetFrameworks")
    }

let private absolute (directory: string) (path: string) =
    if Path.IsPathRooted path then path else Path.GetFullPath(Path.Combine(directory, path))

/// The `name` items MSBuild printed for `-getItem:<name>`.
let private itemsNamed (name: string) (document: JsonDocument) =
    match document.RootElement.TryGetProperty "Items" with
    | true, items ->
        match items.TryGetProperty name with
        | true, found -> found.EnumerateArray() |> List.ofSeq
        | _ -> []
    | _ -> []

/// One metadata value of an item; none when it is absent or empty.
let private metadataOf (item: JsonElement) (name: string) =
    match item.TryGetProperty name with
    | true, value -> value.GetString() |> Option.ofObj |> Option.filter (String.IsNullOrWhiteSpace >> not)
    | _ -> None

let private itemIdentities (document: JsonDocument) =
    itemsNamed "FscCommandLineArgs" document |> List.choose (fun arg -> metadataOf arg "Identity") |> Array.ofList

/// The compiler's references that MSBuild resolved from project references, read from the
/// very items its `-r:` arguments are made of.
let private resolvedReferences (directory: string) (document: JsonDocument) =
    itemsNamed "ReferencePathWithRefAssemblies" document
    |> List.choose (fun item ->
        match metadataOf item "ReferenceSourceTarget", metadataOf item "MSBuildSourceProjectFile", metadataOf item "NearestTargetFramework" with
        | Some "ProjectReference", Some project, Some framework ->
            metadataOf item "Identity"
            |> Option.map (fun assembly ->
                { Assembly = absolute directory assembly
                  Project = absolute directory project
                  Framework = framework })
        | _ -> None)

/// The compiler's arguments for `framework`, exactly as the build would pass them, and the
/// project references among them with the framework of each MSBuild picked.
let commandLineArgs (fsprojPath: string) (framework: string) (ct: CancellationToken) =
    task {
        let arguments =
            [ yield! designTimeProperties framework |> List.map (sprintf "-p:%s")
              yield! designTimeTargets |> List.map (sprintf "-t:%s")
              "-getItem:FscCommandLineArgs"
              "-getItem:ReferencePathWithRefAssemblies" ]

        let! run = runMsbuild fsprojPath arguments ct
        let directory = Path.GetDirectoryName fsprojPath |> string

        return
            run
            |> Result.bind (fun text ->
                match parseJson text |> Option.map (fun document -> itemIdentities document, resolvedReferences directory document) with
                | Some(args, references) when args.Length > 0 -> Ok(args, references)
                | _ -> Error $"the design-time build of {framework} reported no compiler arguments")
    }

/// A path-valued flag with its path made absolute; any other flag unchanged.
let private absoluteFlag (directory: string) (arg: string) =
    FSharpProjectLoading.flagValue pathFlags arg
    |> Option.map (fun (flag, path) -> flag + absolute directory path)
    |> Option.defaultValue arg

/// FCS options from a compiler command line: flags stay options, the rest are sources.
let optionsFromArgs (checker: FSharpChecker) (fsprojPath: string) (args: string array) =
    let directory = Path.GetDirectoryName fsprojPath |> string
    let isSource (arg: string) = not (arg.StartsWith '-')
    let sources = args |> Array.filter isSource |> Array.map (absolute directory)
    let flags = args |> Array.filter (isSource >> not) |> Array.map (absoluteFlag directory)
    { checker.GetProjectOptionsFromCommandLineArgs(fsprojPath, flags) with SourceFiles = sources }

/// The options for `framework`, built once and remembered with the project references
/// MSBuild resolved for it.
let optionsForFramework (checker: FSharpChecker) (entry: FSharpProjectEntry) (framework: string) ct =
    task {
        match entry.ByFramework.TryGetValue framework with
        | true, options -> return Ok options
        | _ ->
            let! compiled = commandLineArgs entry.Path framework ct

            return
                compiled
                |> Result.map (fun (args, references) ->
                    let options = optionsFromArgs checker entry.Path args
                    entry.Resolved[framework] <- references
                    entry.ByFramework[framework] <- options
                    options)
    }

let private singleTarget (options: FSharpProjectOptions) (path: string) =
    { Path = path
      Frameworks = []
      Active = None
      Options = options
      ByFramework = ConcurrentDictionary()
      Resolved = ConcurrentDictionary() }

/// A multi-targeted project answering from its first framework; when MSBuild cannot
/// report that framework's arguments, it keeps the hand-built options and says why.
let private multiTarget checker fallback path (frameworks: string list) ct =
    task {
        let entry = { singleTarget fallback path with Frameworks = frameworks; Active = List.tryHead frameworks }

        match! optionsForFramework checker entry frameworks.Head ct with
        | Ok options -> entry.Options <- options
        | Error reason -> Log.Warning("F# project {Path} keeps its <Compile> items: {Reason}", path, reason)

        return entry
    }

/// Load one project: from MSBuild when it targets several frameworks, else by hand.
let loadEntry (checker: FSharpChecker) (fallback: string -> FSharpProjectOptions) (path: string) ct =
    task {
        let options = fallback path

        if not (declaresTargetFrameworks path) then
            return singleTarget options path
        else
            match! evaluateTargetFrameworks path ct with
            | Ok frameworks when frameworks.Length > 1 -> return! multiTarget checker options path frameworks ct
            | Ok _ -> return singleTarget options path
            | Error reason ->
                Log.Warning("F# project {Path}: target frameworks unknown: {Reason}", path, reason)
                return singleTarget options path
    }
