/// Manages the F# workspace: project loading and semantic queries via FCS.
module SharpLsp.Sidecar.FSharp.FSharpWorkspace

open System
open System.Collections.Concurrent
open System.IO
open System.Reflection
open System.Threading
open System.Xml.Linq
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Text
open FSharp.Compiler.Tokenization
open Serilog
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Solutions
open SharpLsp.Sidecar.FSharp.Hover

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
    { Checker: FSharpChecker
      mutable ProjectOptions: FSharpProjectOptions option
      mutable IsLoaded: bool
      /// In-memory document buffers keyed by absolute file path, kept current by
      /// LSP `textDocument/didChange`. Per-file analyses read from here so hover,
      /// completion, etc. reflect unsaved edits instead of stale on-disk text.
      /// [FS-DIDCHANGE-OVERLAY]
      Overlays: ConcurrentDictionary<string, string> }

/// Overlay keys compare case-insensitively on Windows, where hosts vary the
/// path's spelling (VS Code lowercases the drive letter while FCS and MSBuild
/// report it uppercase); elsewhere Ordinal respects case-sensitive
/// filesystems. [FS-DIDCHANGE-OVERLAY]
let private overlayComparer: StringComparer =
    if OperatingSystem.IsWindows() then StringComparer.OrdinalIgnoreCase
    else StringComparer.Ordinal

/// Canonical overlay key via the shared `NativePaths` normalization: collapses
/// separator, relative-segment, and Windows extended-length (`\\?\`) spellings
/// so the didChange writer and every reader agree on one identity per file.
/// [FS-DIDCHANGE-OVERLAY]
let private overlayKey (filePath: string) : string =
    NativePaths.NormalizeFullPath filePath

/// Create a new workspace with an FSharpChecker.
let create () : FSharpWorkspaceState =
    let checker = FSharpChecker.Create(keepAssemblyContents = true)
    { Checker = checker
      ProjectOptions = None
      IsLoaded = false
      Overlays = ConcurrentDictionary<string, string>(overlayComparer) }

/// Record the editor's in-memory buffer for a file (LSP didChange/didOpen).
/// Per-file FCS analyses then resolve positions against the live buffer rather
/// than the on-disk file, restoring parity with the C# sidecar. Keys are
/// canonicalized, so any spelling of the path the host sends on later requests
/// finds the buffer. [FS-DIDCHANGE-OVERLAY]
let applyDidChange (state: FSharpWorkspaceState) (filePath: string) (newText: string) =
    state.Overlays[overlayKey filePath] <- newText

/// Read a file's current source: the in-memory overlay when the editor has an
/// open buffer for it, otherwise the on-disk contents. [FS-DIDCHANGE-OVERLAY]
let internal readSource (state: FSharpWorkspaceState) (filePath: string) : string =
    match state.Overlays.TryGetValue(overlayKey filePath) with
    | true, text -> text
    | _ -> File.ReadAllText filePath

/// Resolve a request path onto the project's own spelling of the same file.
/// Hosts vary the spelling (VS Code lowercases the drive letter) and FCS
/// filename comparisons are case-sensitive: checking a file under a spelling
/// that differs from `ProjectOptions.SourceFiles` yields symbols whose
/// declaration ranges never match any project-wide use, so references,
/// rename, and code lens silently return nothing while single-file analyses
/// keep working. [FS-REFS-PROJECT] [GitHub #110]
let internal projectFilePath (state: FSharpWorkspaceState) (filePath: string) : string =
    let normalized = NativePaths.NormalizeFullPath filePath
    match state.ProjectOptions with
    | Some options ->
        options.SourceFiles
        |> Array.tryFind (fun sourceFile -> NativePaths.AreEqual(sourceFile, normalized))
        |> Option.defaultValue normalized
    | None -> normalized

/// Parse an .fsproj file to extract Compile Include entries.
let internal parseFsprojSourceFiles (fsprojPath: string) : string array =
    let doc = XDocument.Load(fsprojPath)
    let projDir = Path.GetDirectoryName(fsprojPath) |> string
    doc.Descendants(XName.Get("Compile"))
    |> Seq.choose (fun el ->
        match el.Attribute(XName.Get("Include")) |> Option.ofObj with
        | None -> None
        | Some attr -> Some(Path.GetFullPath(Path.Combine(projDir, string attr.Value))))
    |> Seq.toArray

let private isFsprojPath (path: string) =
    path.EndsWith(".fsproj", StringComparison.OrdinalIgnoreCase)

let private isSolutionPath (path: string) =
    path.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)
    || path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase)

let private outcomeError (result: Outcome.Result<SolutionFileModel, string>) =
    result.Match((fun _ -> String.Empty), (fun err -> err))

let private outcomeValue (result: Outcome.Result<SolutionFileModel, string>) : SolutionFileModel =
    result.Match((fun value -> value), (fun err -> invalidOp err))

let private fsprojFilesFromSolution (path: string) (ct: CancellationToken) =
    task {
        let! readResult = SolutionFileReader.ReadAsync(path, ct)
        if readResult.IsError then
            return Error(outcomeError readResult)
        else
            let model = outcomeValue readResult
            let fsprojs =
                model.Projects
                |> Seq.filter (fun (project: SolutionProjectEntry) -> isFsprojPath project.Path)
                |> Seq.map (fun (project: SolutionProjectEntry) -> project.Path)
                |> Seq.toArray
            return Ok fsprojs
    }

let private discoverFsprojFiles (path: string) (ct: CancellationToken) =
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

/// Build the shared compiler options for a netcore F# check: `--noframework`,
/// the managed framework reference assemblies from the runtime dir, and
/// FSharp.Core. Reused by both project loading and unused-package analysis.
let internal frameworkReferenceArgs () : string array =
    // The runtime dir contains both managed and native DLLs (e.g. clretwrc.dll,
    // coreclr.dll); skip native DLLs since FCS rejects them with "bad cli header".
    let runtimeDir = Runtime.InteropServices.RuntimeEnvironment.GetRuntimeDirectory()
    let isManagedAssembly (path: string) =
        try
            AssemblyName.GetAssemblyName(path) |> ignore
            true
        with _ -> false
    let frameworkRefs =
        Directory.GetFiles(runtimeDir, "*.dll")
        |> Array.filter isManagedAssembly
        |> Array.map (fun dll -> $"-r:{dll}")
    // FSharp.Core is loaded by the sidecar itself; use that path — it's
    // guaranteed to exist and be ABI-compatible with FCS.
    let fsharpCorePath = typeof<unit>.Assembly.Location
    let fsharpCoreRef =
        if String.IsNullOrEmpty(fsharpCorePath) || not (File.Exists fsharpCorePath) then
            [||]
        else
            [| $"-r:{fsharpCorePath}" |]
    [| yield "--noframework"
       yield "--targetprofile:netcore"
       yield! frameworkRefs
       yield! fsharpCoreRef |]

/// Build the persistent FCS project options for an .fsproj: framework reference
/// assemblies + the project's restored NuGet package references ([FSharpAssets])
/// + the project's compile sources. Including the package references is what
/// keeps a building project free of false unresolved-`open` / unknown-type
/// diagnostics — without them FCS cannot resolve any external reference and
/// flags every `open`/type as an error even though the project compiles (#120).
/// Shared with the unused-package analysis so the compiler sees one reference
/// set across diagnostics, hover, and usage.
let internal buildProjectOptions (state: FSharpWorkspaceState) (fsprojPath: string) : FSharpProjectOptions =
    let sourceFiles = parseFsprojSourceFiles fsprojPath

    let packageRefs =
        FSharpAssets.parseAssets fsprojPath
        |> Option.map (snd >> FSharpAssets.packageReferenceArgs)
        |> Option.defaultValue [||]

    let otherOptions = Array.append (frameworkReferenceArgs ()) packageRefs
    // GetProjectOptionsFromCommandLineArgs deliberately returns SourceFiles =
    // [||] (sources stay buried in OtherOptions), but project-wide analyses —
    // ParseAndCheckProject for references/rename/code lens, and the
    // isSymbolInProject rename gate — read options.SourceFiles. Leaving it
    // empty makes every cross-file query silently return nothing, so populate
    // it explicitly from the parsed compile items. [FS-REFS-PROJECT]
    let options =
        state.Checker.GetProjectOptionsFromCommandLineArgs(
            fsprojPath, Array.append otherOptions sourceFiles)
    { options with SourceFiles = sourceFiles }

let private loadFirstProject (state: FSharpWorkspaceState) (fsprojFiles: string array) =
    if fsprojFiles.Length = 0 then
        Error "No .fsproj found"
    else
        try
            let fsprojPath = Array.head fsprojFiles
            if fsprojFiles.Length > 1 then
                Log.Debug("F# workspace found {Count} projects; loading {Path}", fsprojFiles.Length, fsprojPath)
            let options = buildProjectOptions state fsprojPath
            state.ProjectOptions <- Some options
            state.IsLoaded <- true
            let fileList = String.Join(", ", options.SourceFiles |> Array.map Path.GetFileName)
            Log.Debug("F# workspace loaded from {Path} with files: [{Files}]", fsprojPath, fileList)
            Ok()
        with ex ->
            Error ex.Message

/// Load a project from a path, explicit solution, or workspace directory.
let loadProjectWithCancellation
    (state: FSharpWorkspaceState)
    (path: string)
    (ct: CancellationToken)
    =
    task {
        try
            let! discovered = discoverFsprojFiles path ct
            match discovered with
            | Error msg ->
                Log.Debug("F# workspace diagnostic: {Message}", msg)
                return Error msg
            | Ok fsprojFiles ->
                match loadFirstProject state fsprojFiles with
                | Ok () -> return Ok()
                | Error msg ->
                    Log.Debug("F# workspace load failed: {Message}", msg)
                    return Error msg
        with ex ->
            Log.Debug(ex, "F# workspace load failed")
            return Error ex.Message
    }

/// Load a project from a path (finds .fsproj).
let loadProject (state: FSharpWorkspaceState) (path: string) =
    loadProjectWithCancellation state path CancellationToken.None

/// Extract hover from FSharpCheckFileResults.
let private extractToolTip
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : (string * int * int * int * int) option =
    let lines = source.Split('\n')
    if line >= lines.Length then
        None
    else
        let lineText = lines[line]
        // FCS uses 1-based lines.
        let fcsLine = line + 1

        // Find the identifier at the position.
        let island =
            QuickParse.GetCompleteIdentifierIsland true lineText character

        match island with
        | None -> None
        | Some(name, endCol, _) ->
            let names = [ name ]
            // GetToolTip expects colAtEndOfNames, not start position.
            let tip =
                checkResults.GetToolTip(
                    fcsLine, endCol, lineText, names, FSharpTokenTag.Identifier)

            match FSharpHoverBuilder.renderToolTip tip with
            | Some markdown ->
                Some(markdown, line, character, line, character + name.Length)
            | None -> None

/// Get hover information at a position in an F# file.
let getHover
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            if not state.IsLoaded then
                return None
            else
                let filePath = projectFilePath state filePath
                let source = readSource state filePath
                let sourceText = SourceText.ofString source

                let! parseResults, checkAnswer =
                    state.Checker.ParseAndCheckFileInProject(
                        filePath,
                        0,
                        sourceText,
                        state.ProjectOptions.Value)

                match checkAnswer with
                | FSharpCheckFileAnswer.Succeeded checkResults ->
                    return extractToolTip checkResults source line character
                | FSharpCheckFileAnswer.Aborted ->
                    let diags =
                        parseResults.Diagnostics
                        |> Array.map (fun d -> $"{d.Severity}: {d.Message}")
                        |> String.concat "; "
                    Log.Debug("[F# Hover] check aborted; parse diagnostics: {Diagnostics}", diags)
                    return None
        with ex ->
            Log.Debug(ex, "[F# Hover] failed")
            return None
    }

// ── Definition ───────────────────────────────────────────────────

/// Parse and check a file, returning parse results, check results, and source.
/// The canonical per-file analysis entry point; `checkFile` is the parse-less view.
let internal checkFileWithParse
    (state: FSharpWorkspaceState)
    (filePath: string)
    =
    task {
        if not state.IsLoaded then
            return None
        else
            let filePath = projectFilePath state filePath
            let source = readSource state filePath
            let sourceText = SourceText.ofString source

            let! parseResults, checkAnswer =
                state.Checker.ParseAndCheckFileInProject(
                    filePath,
                    0,
                    sourceText,
                    state.ProjectOptions.Value)

            match checkAnswer with
            | FSharpCheckFileAnswer.Succeeded checkResults ->
                return Some(parseResults, checkResults, source)
            | FSharpCheckFileAnswer.Aborted ->
                return None
    }

/// Parse and check a file, returning check results + source if successful.
let internal checkFile
    (state: FSharpWorkspaceState)
    (filePath: string)
    =
    task {
        let! result = checkFileWithParse state filePath
        return result |> Option.map (fun (_parse, check, source) -> (check, source))
    }

/// Check the whole loaded project (used for project-wide symbol queries:
/// references, rename, code lens, call hierarchy). FCS caches results keyed by
/// the project options, so repeat calls are cheap.
let internal checkProject (state: FSharpWorkspaceState) =
    task {
        if not state.IsLoaded then
            return None
        else
            let! results = state.Checker.ParseAndCheckProject(state.ProjectOptions.Value)
            return Some results
    }

/// Whether a symbol is declared inside the loaded project's own source files
/// (renameable), as opposed to the BCL / FSharp.Core / a NuGet dependency.
let internal isSymbolInProject
    (state: FSharpWorkspaceState)
    (symbol: FSharpSymbol)
    : bool =
    match symbol.DeclarationLocation, state.ProjectOptions with
    | Some range, Some options when range.FileName <> "" ->
        // Path identity via the shared helper: tolerant of casing and Windows
        // extended-length (`\\?\`) spellings. [GitHub #110]
        let target = NativePaths.NormalizeFullPath range.FileName
        let inSourceFiles =
            options.SourceFiles
            |> Array.exists (fun file -> NativePaths.AreEqual(file, target))
        // Fall back to an on-disk F# source check: BCL / FSharp.Core / NuGet
        // symbols have no source declaration, so this stays false for them.
        let isSourceOnDisk =
            (target.EndsWith(".fs", StringComparison.OrdinalIgnoreCase)
             || target.EndsWith(".fsi", StringComparison.OrdinalIgnoreCase))
            && File.Exists(target)
        inSourceFiles || isSourceOnDisk
    | _ -> false

// ── Shared helpers ──────────────────────────────────────────────

/// Convert an FCS Range to a DefinitionLocation (1-based → 0-based).
let rangeToLocation (r: FSharp.Compiler.Text.Range) =
    if r.FileName = "" then None
    else
        Some
            { FilePath = r.FileName
              Line = r.StartLine - 1
              Character = r.StartColumn
              EndLine = r.EndLine - 1
              EndCharacter = r.EndColumn }

/// Get the symbol use at a given 0-based position.
let internal getSymbolUse
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    =
    let lines = source.Split('\n')
    if line >= lines.Length then None
    else
        let lineText = lines[line]
        let fcsLine = line + 1
        let island =
            QuickParse.GetCompleteIdentifierIsland true lineText character
        match island with
        | None -> None
        | Some(name, endCol, _) ->
            checkResults.GetSymbolUseAtLocation(
                fcsLine, endCol, lineText, [ name ])

/// Extract the type entity from an FSharpType.
let private getTypeEntity (ty: FSharpType) =
    if ty.HasTypeDefinition then Some ty.TypeDefinition
    else None

/// Extract the declaration location for the symbol at a position.
/// Prefers the resolved FSharpSymbol's declaration location — robust for
/// qualified names (Module.member), record fields, DU cases, and cross-file
/// symbols — and falls back to FCS GetDeclarationLocation (which can follow
/// into signature files) using the identifier island's end column.
let private extractDefinition
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : DefinitionLocation option =
    let fromSymbol =
        getSymbolUse checkResults source line character
        |> Option.bind (fun su -> su.Symbol.DeclarationLocation)
        |> Option.bind rangeToLocation
    match fromSymbol with
    | Some _ -> fromSymbol
    | None ->
        let lines = source.Split('\n')
        if line >= lines.Length then
            None
        else
            let lineText = lines[line]
            match QuickParse.GetCompleteIdentifierIsland true lineText character with
            | None -> None
            | Some(name, endCol, _) ->
                match checkResults.GetDeclarationLocation(line + 1, endCol, lineText, [ name ]) with
                | FindDeclResult.DeclFound declRange -> rangeToLocation declRange
                | FindDeclResult.DeclNotFound _
                | FindDeclResult.ExternalDecl _ -> None

/// Get definition location at a position in an F# file.
let getDefinition
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractDefinition checkResults source line character
            | None ->
                return None
        with ex ->
            Log.Debug(ex, "[F# Definition] failed")
            return None
    }

// ── Type Definition ─────────────────────────────────────────────

/// Extract type definition location from a symbol use.
let private extractTypeDefinition
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : DefinitionLocation option =
    match getSymbolUse checkResults source line character with
    | None -> None
    | Some su ->
        let typeEntity =
            match su.Symbol with
            | :? FSharpMemberOrFunctionOrValue as mfv ->
                mfv.FullType |> getTypeEntity
            | :? FSharpField as field ->
                field.FieldType |> getTypeEntity
            | :? FSharpEntity as ent -> Some ent
            | _ -> None
        match typeEntity with
        | Some ent -> rangeToLocation ent.DeclarationLocation
        | None -> None

/// Get the type definition location at a position.
let getTypeDefinition
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractTypeDefinition checkResults source line character
            | None -> return None
        with ex ->
            Log.Debug(ex, "[F# TypeDefinition] failed")
            return None
    }

// ── Declaration ─────────────────────────────────────────────────

/// Find the interface or base member declaration for an override.
let private findBaseMember
    (mfv: FSharpMemberOrFunctionOrValue)
    : DefinitionLocation option =
    if not mfv.IsOverrideOrExplicitInterfaceImplementation then
        None
    else
        match mfv.DeclaringEntity with
        | Some ent ->
            let baseLoc =
                ent.AllInterfaces
                |> Seq.tryPick (fun iface ->
                    if not iface.HasTypeDefinition then None
                    else
                        iface.TypeDefinition.MembersFunctionsAndValues
                        |> Seq.tryFind (fun m ->
                            m.DisplayName = mfv.DisplayName)
                        |> Option.bind (fun m ->
                            rangeToLocation m.DeclarationLocation))
            baseLoc
        | None -> None

/// Extract declaration location (base/interface for overrides).
let private extractDeclaration
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : DefinitionLocation option =
    match getSymbolUse checkResults source line character with
    | None -> None
    | Some su ->
        match su.Symbol with
        | :? FSharpMemberOrFunctionOrValue as mfv ->
            match findBaseMember mfv with
            | Some loc -> Some loc
            | None -> rangeToLocation mfv.DeclarationLocation
        | _ ->
            extractDefinition checkResults source line character

/// Get the declaration location at a position.
let getDeclaration
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractDeclaration checkResults source line character
            | None -> return None
        with ex ->
            Log.Debug(ex, "[F# Declaration] failed")
            return None
    }

// ── Implementation ──────────────────────────────────────────────

/// Extract implementations (fallback: symbol's own location).
let private extractImplementations
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (line: int)
    (character: int)
    : DefinitionLocation list =
    match getSymbolUse checkResults source line character with
    | None -> []
    | Some su ->
        match su.Symbol.DeclarationLocation with
        | Some declRange ->
            match rangeToLocation declRange with
            | Some loc -> [ loc ]
            | None -> []
        | None -> []

/// Get implementation locations at a position.
let getImplementations
    (state: FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! result = checkFile state filePath
            match result with
            | Some(checkResults, source) ->
                return extractImplementations checkResults source line character
            | None -> return []
        with ex ->
            Log.Debug(ex, "[F# Implementation] failed")
            return []
    }
