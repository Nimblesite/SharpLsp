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
    }

/// Create a new workspace with an overlay-aware FSharpChecker.
let create () : FSharpWorkspaceState =
    let overlays =
        ConcurrentDictionary<string, string>(FSharpWorkspaceRuntime.overlayComparer)

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
      Projects = ConcurrentDictionary(FSharpWorkspaceRuntime.overlayComparer) }

/// The project that compiles `filePath`, if any loaded project does.
let internal projectOf (state: FSharpWorkspaceState) (filePath: string) =
    state.Projects.Values
    |> Seq.tryFind (fun entry -> (FSharpWorkspaceRuntime.tryProjectSourcePath entry.Options filePath).IsSome)

/// The options that compile `filePath`: the workspace's when they do, which keeps them
/// authoritative for the primary project; else the owning project's; else the workspace's.
let internal optionsFor (state: FSharpWorkspaceState) (filePath: string) =
    let compiles (options: FSharpProjectOptions) =
        (FSharpWorkspaceRuntime.tryProjectSourcePath options filePath).IsSome

    match state.ProjectOptions with
    | Some primary when compiles primary -> Some primary
    | primary -> projectOf state filePath |> Option.map _.Options |> Option.orElse primary

/// Record the editor's in-memory buffer and invalidate the corresponding FCS file.
let applyDidChange (state: FSharpWorkspaceState) (filePath: string) (newText: string) =
    let normalizedPath = FSharpWorkspaceRuntime.overlayKey filePath
    state.Overlays[normalizedPath] <- newText

    match optionsFor state normalizedPath with
    | Some options ->
        match FSharpWorkspaceRuntime.tryProjectSourcePath options normalizedPath with
        | Some projectPath -> FSharpWorkspaceRuntime.notifyFileChanged state.Checker projectPath options
        | None -> ()
    | None -> ()

/// Read the live overlay when present, otherwise the source on disk.
let internal readSource (state: FSharpWorkspaceState) (filePath: string) : string =
    match FSharpWorkspaceRuntime.tryReadSource state.Overlays filePath with
    | Some text -> text
    | None ->
        let normalizedPath = FSharpWorkspaceRuntime.overlayKey filePath
        raise (FileNotFoundException("F# source file was not found.", normalizedPath))

/// Resolve a request path to the spelling held in project options.
let internal projectFilePath (state: FSharpWorkspaceState) (filePath: string) : string =
    match optionsFor state filePath with
    | Some options -> FSharpWorkspaceRuntime.projectSourcePath options filePath
    | None -> FSharpWorkspaceRuntime.overlayKey filePath

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
    let files = String.Join(", ", options.SourceFiles |> Array.map Path.GetFileName)
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

                for entry in entries do
                    state.Projects[entry.Path] <- entry

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
                return! loadScript state (Path.GetFullPath path) ct
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

let internal checkProject (state: FSharpWorkspaceState) =
    task {
        if not state.IsLoaded then
            return None
        else
            let! results = state.Checker.ParseAndCheckProject(state.ProjectOptions.Value)
            return Some results
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

let getDefinition state filePath line character =
    FSharpSemanticNavigation.getDefinition (checkFile state) filePath line character
    |> mapNavigation

let getTypeDefinition state filePath line character =
    FSharpSemanticNavigation.getTypeDefinition (checkFile state) filePath line character
    |> mapNavigation

let getDeclaration state filePath line character =
    FSharpSemanticNavigation.getDeclaration (checkFile state) filePath line character
    |> mapNavigation

let getImplementations state filePath line character =
    FSharpSemanticNavigation.getImplementations (checkFile state) filePath line character
    |> mapNavigationList
