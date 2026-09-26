/// Manages the F# workspace and preserves its public semantic-query API.
module SharpLsp.Sidecar.FSharp.FSharpWorkspace

open System
open System.Collections.Concurrent
open System.IO
open System.Threading
open System.Threading.Tasks
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Text
open Serilog
open SharpLsp.Sidecar.Common

/// Definition result: file path + start line/col + end line/col (0-based).
type DefinitionLocation =
    { FilePath: string
      Line: int
      Character: int
      EndLine: int
      EndCharacter: int }

/// Workspace state holding the FSharpChecker and loaded project options.
[<NoComparison; NoEquality>]
type FSharpWorkspaceState =
    {
        Checker: FSharpChecker
        mutable ProjectOptions: FSharpProjectOptions option
        mutable IsLoaded: bool
        /// Live editor buffers keyed by canonical absolute file path.
        Overlays: ConcurrentDictionary<string, string>
        /// Every loaded project, keyed by its project file. [NETFX-PROJECTS-FSHARP]
        Projects: ConcurrentDictionary<string, FSharpDesignTime.FSharpProjectEntry>
        /// The F# projects each loaded project references, read once at load.
        /// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]
        References: ConcurrentDictionary<string, string list>
        /// The C# projects loaded projects reference, compiled in memory.
        /// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-CSHARP-REFERENCES]
        CSharpBuilds: FSharpCSharpReferences.CSharpBuilds
    }

/// Create a new workspace with an overlay-aware FSharpChecker.
let create () : FSharpWorkspaceState =
    let overlays =
        ConcurrentDictionary<string, string>(NativePaths.Comparer)

    let readDocument filePath =
        async {
            return
                FSharpWorkspaceRuntime.tryReadSource overlays filePath
                |> Option.map SourceText.ofString
        }

    { Checker = FSharpWorkspaceRuntime.createOverlayAwareChecker readDocument
      ProjectOptions = None
      IsLoaded = false
      Overlays = overlays
      Projects = ConcurrentDictionary(NativePaths.Comparer)
      References = ConcurrentDictionary(NativePaths.Comparer)
      CSharpBuilds = ConcurrentDictionary(NativePaths.Comparer) }

/// The project that compiles `filePath`, if any loaded project does.
let internal projectOf (state: FSharpWorkspaceState) (filePath: string) =
    state.Projects.Values
    |> Seq.tryFind (fun entry -> (FSharpWorkspaceRuntime.tryProjectSourcePath entry.Options filePath).IsSome)

/// The value `table` holds for `key`, if any.
let private valueAt (table: ConcurrentDictionary<string, 'T>) (key: string) =
    match table.TryGetValue key with
    | true, value -> Some value
    | _ -> None

/// The value `table` holds for the project file `project`, however it is spelled.
let private lookup (table: ConcurrentDictionary<string, 'T>) (project: string) =
    valueAt table (NativePaths.NormalizeFullPath project)

/// The project references MSBuild resolved for `options`, when they are one of their
/// project's MSBuild builds.
let private resolvedFor (state: FSharpWorkspaceState) (options: FSharpProjectOptions) =
    lookup state.Projects options.ProjectFileName
    |> Option.bind (fun entry -> FSharpDesignTime.frameworkOf entry options |> Option.bind (valueAt entry.Resolved))
    |> Option.defaultValue []

/// The builds of loaded F# projects that MSBuild resolved the project references of
/// `options` to, each once its options are built. FCS keeps one builder per project and
/// framework, so a build read here and the one its project answers from coexist.
/// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]
let private referencedBuilds (state: FSharpWorkspaceState) (options: FSharpProjectOptions) : FSharpProjectGraph.ReferencedBuild list =
    resolvedFor state options
    |> List.choose (fun reference ->
        lookup state.Projects reference.Project
        |> Option.bind (fun referenced -> valueAt referenced.ByFramework reference.Framework)
        |> Option.map (fun build -> { Reference = reference.Assembly; Options = build }))

/// The C# projects compiled in memory for the project references of `options`, each read
/// under the `-r:` MSBuild wrote. [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-CSHARP-REFERENCES]
let private referencedAssemblies (state: FSharpWorkspaceState) (options: FSharpProjectOptions) =
    resolvedFor state options
    |> List.choose (FSharpCSharpReferences.tryFind state.CSharpBuilds)
    |> List.map FSharpCSharpReferences.referencedProject

/// `options` with the loaded F# projects and the C# projects it references wired in, in
/// memory. [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]
let internal wired (state: FSharpWorkspaceState) (options: FSharpProjectOptions) =
    let current = lookup state.Projects >> Option.map _.Options
    let referencesOf = lookup state.References >> Option.defaultValue []
    FSharpProjectGraph.wireGraph (referencedAssemblies state) current referencesOf (referencedBuilds state) options

let private readsFromDll (entry: FSharpDesignTime.FSharpProjectEntry) (reference: FSharpDesignTime.ResolvedReference) (reason: string) =
    Log.Warning("F# project {Path} reads {Reference} from its DLL: {Reason}", entry.Path, reference.Project, reason)

/// Build, once, each build of a loaded F# project that MSBuild resolved `entry`'s project
/// references to under `framework`, then theirs, and compile each C# project among them,
/// so a reference reads its build in memory from the first request on. A build MSBuild
/// cannot report leaves its reference on the DLL.
/// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]
let rec internal prepareReferencedBuilds
    (state: FSharpWorkspaceState)
    (entry: FSharpDesignTime.FSharpProjectEntry)
    (framework: string)
    (ct: CancellationToken)
    : Task<unit> =
    task {
        for reference in valueAt entry.Resolved framework |> Option.defaultValue [] do
            match lookup state.Projects reference.Project with
            | Some referenced when not (referenced.ByFramework.ContainsKey reference.Framework) ->
                match! FSharpDesignTime.optionsForFramework state.Checker referenced reference.Framework ct with
                | Ok _ -> do! prepareReferencedBuilds state referenced reference.Framework ct
                | Error reason -> readsFromDll entry reference reason
            | None when FSharpCSharpReferences.isCSharpProject reference.Project ->
                match! FSharpCSharpReferences.prepare state.CSharpBuilds [] reference ct with
                | Ok _ -> ()
                | Error reason -> readsFromDll entry reference reason
            | _ -> ()
    }

/// The options that compile `filePath`: the workspace's when they do, which keeps them
/// authoritative for the primary project; else the owning project's; else the workspace's.
let internal optionsFor (state: FSharpWorkspaceState) (filePath: string) =
    let compiles (options: FSharpProjectOptions) =
        (FSharpWorkspaceRuntime.tryProjectSourcePath options filePath).IsSome

    let own =
        match state.ProjectOptions with
        | Some primary when compiles primary -> Some primary
        | primary -> projectOf state filePath |> Option.map _.Options |> Option.orElse primary

    own |> Option.map (wired state)

/// Every loaded project's own options but the workspace's — a script or a lone
/// project has no other.
let private otherProjectOptions (state: FSharpWorkspaceState) =
    let isWorkspaces (options: FSharpProjectOptions) =
        state.ProjectOptions
        |> Option.exists (fun own -> NativePaths.AreEqual(own.ProjectFileName, options.ProjectFileName))

    state.Projects.Values |> Seq.map _.Options |> Seq.filter (isWorkspaces >> not) |> List.ofSeq

/// Each file once, in the order given.
let private distinctFiles (files: string seq) =
    Linq.Enumerable.DistinctBy(files, (fun file -> NativePaths.NormalizeFullPath file), NativePaths.Comparer)
    |> Array.ofSeq

/// Every source file of every loaded project, the workspace's first, each once. Only a
/// rename by identity — from the other language, with no F# file to anchor on — walks
/// them all.
let internal allSourceFiles (state: FSharpWorkspaceState) : string array =
    Option.toList state.ProjectOptions @ otherProjectOptions state
    |> Seq.collect _.SourceFiles
    |> distinctFiles

/// True when `options` read `project` in memory, directly or through another project.
let rec private readsInMemory (project: string) (options: FSharpProjectOptions) =
    options.ReferencedProjects
    |> Array.exists (function
        | FSharpReferencedProject.FSharpReference(_, referenced) ->
            NativePaths.AreEqual(referenced.ProjectFileName, project)
            || readsInMemory project referenced
        | _ -> false)

/// The projects a project-wide query anchored on `filePath` spans: the project that
/// compiles it, then every loaded project that reads that one IN MEMORY — through
/// whichever build of it MSBuild picked — which sees its current source. A project still
/// reading it as a DLL — its build could not be produced — sees it as last built, and
/// checking every project of a large solution on every request stalled the whole server.
/// The first query checks each reader once; the checker keeps every builder, so the next
/// re-checks nothing. [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]
let internal queryScope (state: FSharpWorkspaceState) (filePath: string) : FSharpProjectOptions list =
    match optionsFor state filePath with
    | None -> []
    | Some own ->
        let reads (options: FSharpProjectOptions) =
            not (NativePaths.AreEqual(options.ProjectFileName, own.ProjectFileName))
            && readsInMemory own.ProjectFileName options

        own :: (state.Projects.Values |> Seq.map (fun entry -> wired state entry.Options) |> Seq.filter reads |> List.ofSeq)

/// Every source file of the scope anchored on `filePath`, each once: what references and
/// rename walk ([REFERENCES-FSHARP-FIND]).
let internal scopeSourceFiles (state: FSharpWorkspaceState) (filePath: string) : string array =
    queryScope state filePath |> Seq.collect _.SourceFiles |> distinctFiles

/// The file a query about `symbol` anchors on: its declaration, when a loaded project
/// compiles that file; otherwise the file it was used in.
let internal anchorOf (state: FSharpWorkspaceState) (symbol: FSharpSymbol) (usedIn: string) =
    symbol.DeclarationLocation
    |> Option.map (fun range -> range.FileName)
    |> Option.filter (fun declared -> (projectOf state declared).IsSome)
    |> Option.defaultValue usedIn

/// Every build of the project that compiles `filePath`, wired: the one it answers from and
/// each framework's, since another project may read a build it does not answer from.
/// [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]
let private buildsCompiling (state: FSharpWorkspaceState) (filePath: string) =
    let byFramework =
        projectOf state filePath
        |> Option.map (fun entry -> entry.ByFramework.Values |> Seq.map (wired state) |> List.ofSeq)
        |> Option.defaultValue []

    Option.toList (optionsFor state filePath) @ byFramework

/// Record the editor's in-memory buffer and invalidate the file in every build that
/// compiles it.
let applyDidChange (state: FSharpWorkspaceState) (filePath: string) (newText: string) =
    let normalizedPath = NativePaths.NormalizeFullPath filePath
    state.Overlays[normalizedPath] <- newText

    for options in buildsCompiling state normalizedPath do
        match FSharpWorkspaceRuntime.tryProjectSourcePath options normalizedPath with
        | Some projectPath -> FSharpWorkspaceRuntime.notifyFileChanged state.Checker projectPath options
        | None -> ()

/// Read the live overlay when present, otherwise the source on disk.
let internal readSource (state: FSharpWorkspaceState) (filePath: string) : string =
    match FSharpWorkspaceRuntime.tryReadSource state.Overlays filePath with
    | Some text -> text
    | None ->
        let normalizedPath = NativePaths.NormalizeFullPath filePath
        raise (FileNotFoundException("F# source file was not found.", normalizedPath))

/// Resolve a request path to the spelling held in project options.
let internal projectFilePath (state: FSharpWorkspaceState) (filePath: string) : string =
    match optionsFor state filePath with
    | Some options -> FSharpWorkspaceRuntime.projectSourcePath options filePath
    | None -> NativePaths.NormalizeFullPath filePath

/// The one raw per-file FCS check; version deliberately remains the literal 0.
let internal parseAndCheckOnce (state: FSharpWorkspaceState) filePath options =
    task {
        let source = readSource state filePath

        let! parseResults, checkAnswer =
            state.Checker.ParseAndCheckFileInProject(filePath, 0, SourceText.ofString source, options)

        return parseResults, checkAnswer, source
    }

let private interpretAnswer
    (parseResults: FSharpParseFileResults)
    (checkAnswer: FSharpCheckFileAnswer)
    (source: string)
    =
    match checkAnswer with
    | FSharpCheckFileAnswer.Succeeded checkResults -> Some(parseResults, checkResults, source)
    | FSharpCheckFileAnswer.Aborted ->
        Log.Debug("[F# Check] aborted; parse diagnostics: {@Diagnostics}", parseResults.Diagnostics)
        None

let internal checkFileWithParse (state: FSharpWorkspaceState) (filePath: string) =
    task {
        if not state.IsLoaded then
            return None
        else
            let projectPath = projectFilePath state filePath

            let options = (optionsFor state projectPath).Value
            let! parseResults, checkAnswer, source = parseAndCheckOnce state projectPath options

            return interpretAnswer parseResults checkAnswer source
    }

let internal checkFileWithSource state filePath source =
    task {
        if not state.IsLoaded then
            return None
        else
            let projectPath = projectFilePath state filePath

            let! parseResults, checkAnswer =
                state.Checker.ParseAndCheckFileInProject(
                    projectPath,
                    0,
                    SourceText.ofString source,
                    (optionsFor state projectPath).Value
                )

            return interpretAnswer parseResults checkAnswer source
    }

let internal checkFile (state: FSharpWorkspaceState) (filePath: string) =
    task {
        let! result = checkFileWithParse state filePath
        return result |> Option.map (fun (_, check, source) -> check, source)
    }

let internal parseFsprojSourceFiles path =
    FSharpProjectLoading.parseFsprojSourceFiles path

let internal parseFsprojOtherFlags path =
    FSharpProjectLoading.parseFsprojOtherFlags path

let internal parseFsprojAssemblyName path =
    FSharpProjectLoading.parseFsprojAssemblyName path

let internal frameworkReferenceArgs () =
    FSharpProjectLoading.frameworkReferenceArgs ()

let internal buildProjectOptions (state: FSharpWorkspaceState) fsprojPath =
    FSharpProjectLoading.buildProjectOptions state.Checker fsprojPath

let private activateWorkspace
    (state: FSharpWorkspaceState)
    (options: FSharpProjectOptions)
    (path: string)
    (kind: string)
    =
    state.ProjectOptions <- Some options
    state.IsLoaded <- true
    let files = String.Join(", ", options.SourceFiles |> Array.map NativePaths.NameOf)
    Log.Debug("F# {Kind} loaded from {Path} with files: [{Files}]", kind, path, files)

/// Load EVERY project; the first one is the workspace's for project-wide queries.
let private loadProjects (state: FSharpWorkspaceState) (fsprojFiles: string array) ct =
    task {
        if fsprojFiles.Length = 0 then
            return Error "No .fsproj found"
        else
            try
                let fallback = buildProjectOptions state
                let! entries = fsprojFiles |> Array.map (fun path -> FSharpDesignTime.loadEntry state.Checker fallback path ct) |> Task.WhenAll
                state.Projects.Clear()
                state.References.Clear()

                for entry in entries do
                    let key = NativePaths.NormalizeFullPath entry.Path
                    state.Projects[key] <- entry
                    state.References[key] <- FSharpProjectGraph.fsharpReferences entry.Path

                for entry in entries do
                    match FSharpDesignTime.builtFramework entry with
                    | Some framework -> do! prepareReferencedBuilds state entry framework ct
                    | None -> ()

                Log.Debug("F# workspace loaded {Count} project(s); {Path} is primary", entries.Length, fsprojFiles[0])
                activateWorkspace state entries[0].Options fsprojFiles[0] "workspace"
                return Ok()
            with ex ->
                return Error ex.Message
    }

let private logScriptDiagnostics (scriptPath: string) (diagnostics: FSharp.Compiler.Diagnostics.FSharpDiagnostic seq) =
    diagnostics
    |> Seq.iter (fun diagnostic ->
        Log.Debug("F# script option diagnostic for {Path}: {Message}", scriptPath, diagnostic.Message))

let private loadScript (state: FSharpWorkspaceState) scriptPath ct =
    task {
        let source = readSource state scriptPath
        let! options, diagnostics = FSharpProjectLoading.scriptOptions state.Checker scriptPath source ct
        logScriptDiagnostics scriptPath diagnostics
        activateWorkspace state options scriptPath "script"
        return Ok()
    }

let private loadDiscoveredProject (state: FSharpWorkspaceState) (discovered: Result<string array, string>) ct =
    task {
        match discovered with
        | Error message ->
            Log.Debug("F# workspace diagnostic: {Message}", message)
            return Error message
        | Ok projectFiles ->
            match! loadProjects state projectFiles ct with
            | Ok() -> return Ok()
            | Error message ->
                Log.Debug("F# workspace load failed: {Message}", message)
                return Error message
    }

/// Load a project, solution, workspace directory, or self-describing script.
let loadProjectWithCancellation (state: FSharpWorkspaceState) (path: string) (ct: CancellationToken) =
    task {
        try
            if File.Exists(path) && FSharpProjectLoading.isScriptPath path then
                return! loadScript state (NativePaths.NormalizeFullPath path) ct
            else
                let! discovered = FSharpProjectLoading.discoverFsprojFiles path ct
                return! loadDiscoveredProject state discovered ct
        with ex ->
            Log.Debug(ex, "F# workspace load failed")
            return Error ex.Message
    }

let loadProject (state: FSharpWorkspaceState) (path: string) =
    loadProjectWithCancellation state path CancellationToken.None

let getHover state filePath line character =
    FSharpSemanticNavigation.getHover (checkFileWithParse state) filePath line character

/// Whole-project results of the workspace's own project; none until one loads.
let internal checkProject (state: FSharpWorkspaceState) =
    task {
        if not state.IsLoaded then
            return None
        else
            let! results = state.Checker.ParseAndCheckProject(wired state state.ProjectOptions.Value)
            return Some results
    }

/// Whole-project results for `projects` — a query's scope, or its head alone — one after
/// another: checking them concurrently starved the thread pool and took five times as
/// long once the builders were warm. Empty until a workspace loads.
let internal checkAll (state: FSharpWorkspaceState) (projects: FSharpProjectOptions list) =
    task {
        let results = ResizeArray<FSharpCheckProjectResults>()

        if state.IsLoaded then
            for (options: FSharpProjectOptions) in projects do
                let! checkedProject = state.Checker.ParseAndCheckProject options
                results.Add checkedProject

        return List.ofSeq results
    }

let internal isSymbolInProject (state: FSharpWorkspaceState) (symbol: FSharpSymbol) =
    FSharpSemanticNavigation.isSymbolInProject state.ProjectOptions symbol

let private mapLocation (location: FSharpSemanticNavigation.NavigationLocation) =
    { FilePath = location.FilePath
      Line = location.Line
      Character = location.Character
      EndLine = location.EndLine
      EndCharacter = location.EndCharacter }

/// Convert an FCS range to a zero-based definition location.
let rangeToLocation range =
    FSharpSemanticNavigation.rangeToLocation range |> Option.map mapLocation

let internal getSymbolUse checkResults source line character =
    FSharpSemanticNavigation.getSymbolUse checkResults source line character

let private mapNavigation (operation: Task<FSharpSemanticNavigation.NavigationLocation option>) =
    task {
        let! result = operation
        return result |> Option.map mapLocation
    }

let private mapNavigationList (operation: Task<FSharpSemanticNavigation.NavigationLocation list>) =
    task {
        let! result = operation
        return result |> List.map mapLocation
    }

/// Where an external symbol is declared: in the C# source compiled in memory, when a C#
/// project of the workspace declares it. [DEFINITION-CROSSLANG]
let private external (state: FSharpWorkspaceState) =
    FSharpCSharpReferences.tryLocate state.CSharpBuilds

let getDefinition state filePath line character =
    FSharpSemanticNavigation.getDefinitionIn (external state) (checkFile state) filePath line character
    |> mapNavigation

let getTypeDefinition state filePath line character =
    FSharpSemanticNavigation.getTypeDefinitionIn (external state) (checkFile state) filePath line character
    |> mapNavigation

let getDeclaration state filePath line character =
    FSharpSemanticNavigation.getDeclarationIn (external state) (checkFile state) filePath line character
    |> mapNavigation

let getImplementations state filePath line character =
    FSharpSemanticNavigation.getImplementations (checkFile state) filePath line character
    |> mapNavigationList
