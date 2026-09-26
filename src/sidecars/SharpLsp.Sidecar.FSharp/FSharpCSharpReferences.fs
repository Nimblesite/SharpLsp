/// The C# projects an F# project references, compiled in memory with Roslyn. MSBuild's
/// design-time build reports the C# compiler's command line for the build MSBuild picked,
/// Roslyn compiles it, and FCS reads the metadata-only assembly it emits under the very
/// `-r:` MSBuild wrote: a C# project nobody built still resolves, a saved C# edit reaches
/// F# on the next check without a build, and definition lands in the C# source. The C#
/// projects it references in turn are compiled the same way. When MSBuild cannot report
/// the command line, or Roslyn cannot emit, the reference stands on its DLL and the log
/// says why. Implements [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-CSHARP-REFERENCES] and
/// [DEFINITION-CROSSLANG] (GitHub #313).
module SharpLsp.Sidecar.FSharp.FSharpCSharpReferences

open System
open System.Collections.Concurrent
open System.Collections.Immutable
open System.IO
open System.Threading
open System.Threading.Tasks
open FSharp.Compiler.AbstractIL.ILBinaryReader
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open Microsoft.CodeAnalysis
open Microsoft.CodeAnalysis.CSharp
open Microsoft.CodeAnalysis.Emit
open Microsoft.CodeAnalysis.Text
open Serilog
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.FSharpDesignTime

/// A C# project compiled for the framework MSBuild picked, under the `-r:` that names it.
[<NoComparison; NoEquality>]
type CSharpBuild =
    {
        Project: string
        Framework: string
        /// The `-r:` value MSBuild wrote for the build: what FCS reads the assembly under.
        Reference: string
        /// The C# compiler's command line, parsed once per load.
        Arguments: CSharpCommandLineArguments
        /// The C# projects it references in turn, compiled the same way.
        References: CSharpBuild list
        Gate: obj
        /// The compilation and image of the sources as they stood at a stamp.
        mutable Emitted: (DateTime * CSharpCompilation * byte array) option
    }

/// Every build prepared, keyed by project and framework.
type CSharpBuilds = ConcurrentDictionary<string, CSharpBuild>

/// Whether `path` is a C# project file.
let isCSharpProject (path: string) =
    path.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)

let private keyOf (project: string) (framework: string) =
    $"{FSharpWorkspaceRuntime.overlayKey project}|{framework}"

/// The build of `reference`'s project for the framework MSBuild picked, when prepared.
let tryFind (builds: CSharpBuilds) (reference: ResolvedReference) =
    match builds.TryGetValue(keyOf reference.Project reference.Framework) with
    | true, build -> Some build
    | _ -> None

let private lastWrite (path: string) =
    if File.Exists path then File.GetLastWriteTimeUtc path else DateTime.MinValue

/// When the build's inputs last changed: its project file, its sources and the builds it
/// references. FCS reads the assembly again when this moves.
let rec stampOf (build: CSharpBuild) : DateTime =
    build.Project :: [ for source in build.Arguments.SourceFiles -> source.Path ]
    |> List.map lastWrite
    |> List.append (build.References |> List.map stampOf)
    |> List.max

/// A metadata-only image: the declarations FCS needs, however many method bodies fail.
let private emitOptions =
    EmitOptions(metadataOnly = true, tolerateErrors = true, includePrivateMembers = false)

let private readerOptions: ILReaderOptions =
    { pdbDirPath = None
      reduceMemoryUsage = ReduceMemoryFlag.Yes
      metadataOnly = MetadataOnlyFlag.Yes
      tryGetMetadataSnapshot = fun _ -> None }

/// The syntax tree of each source the command line names and the disk has.
let private syntaxTrees (arguments: CSharpCommandLineArguments) =
    arguments.SourceFiles
    |> Seq.map _.Path
    |> Seq.filter File.Exists
    |> Seq.map (fun path ->
        use stream = File.OpenRead path
        CSharpSyntaxTree.ParseText(SourceText.From(stream, arguments.Encoding), arguments.ParseOptions, path))
    |> List.ofSeq

/// The first errors of `diagnostics`, on one line.
let private errorsOf (diagnostics: Diagnostic seq) =
    diagnostics
    |> Seq.filter (fun diagnostic -> diagnostic.Severity = DiagnosticSeverity.Error)
    |> Seq.truncate 3
    |> Seq.map string
    |> fun errors -> String.Join(' ', errors)

/// The metadata-only image of `compilation`, or why Roslyn could not emit one.
let private emit (compilation: CSharpCompilation) =
    use stream = new MemoryStream()
    let result = compilation.Emit(stream, options = emitOptions)

    if result.Success then
        Ok(stream.ToArray())
    else
        Error(errorsOf result.Diagnostics)

/// The signing key a `/keyfile:` names is looked for beside the project.
let private strongNaming (build: CSharpBuild) =
    DesktopStrongNameProvider(ImmutableArray.Create(Path.GetDirectoryName build.Project |> string))

/// Each reference on the command line: a C# project compiled here is read from its
/// compilation, a file the disk has from that file, and a file it lacks — an unbuilt
/// project no build here covers — is left for the compiler to report.
let rec private metadataReferences (build: CSharpBuild) : MetadataReference list =
    build.Arguments.MetadataReferences
    |> Seq.choose (fun (reference: CommandLineReference) ->
        match build.References |> List.tryFind (fun inner -> NativePaths.AreEqual(inner.Reference, reference.Reference)) with
        | Some inner ->
            Some((compilationOf inner).ToMetadataReference(reference.Properties.Aliases, reference.Properties.EmbedInteropTypes) :> MetadataReference)
        | None when File.Exists reference.Reference ->
            Some(MetadataReference.CreateFromFile(reference.Reference, reference.Properties) :> MetadataReference)
        | None -> None)
    |> List.ofSeq

/// Roslyn's compilation of the command line's sources against its references.
and private compile (build: CSharpBuild) =
    let name =
        build.Arguments.CompilationName
        |> Option.ofObj
        |> Option.defaultValue (Path.GetFileNameWithoutExtension build.Project |> string)

    let options = build.Arguments.CompilationOptions.WithStrongNameProvider(strongNaming build)
    CSharpCompilation.Create(name, syntaxTrees build.Arguments, metadataReferences build, options)

/// The compilation and image of `build` as its inputs stand now: emitted again when they
/// changed, and the last ones kept when Roslyn cannot emit the changed sources.
and private emitted (build: CSharpBuild) =
    lock build.Gate (fun () ->
        let stamp = stampOf build

        match build.Emitted with
        | Some(at, compilation, image) when at = stamp -> Ok(compilation, image)
        | previous ->
            let compilation = compile build

            match emit compilation, previous with
            | Ok image, _ ->
                build.Emitted <- Some(stamp, compilation, image)
                Ok(compilation, image)
            | Error reason, Some(_, compilation, image) ->
                Log.Warning("C# project {Path} keeps its last image: {Reason}", build.Project, reason)
                Ok(compilation, image)
            | Error reason, None -> Error reason)

/// The compilation of `build` as its inputs stand now, whether or not it emits.
and private compilationOf (build: CSharpBuild) =
    match emitted build with
    | Ok(compilation, _) -> compilation
    | Error _ -> compile build

/// FCS's reader of the build's image now. A build is wired only once it has emitted, and
/// keeps its last image after, so there is always one to read.
let private reader (build: CSharpBuild) =
    match emitted build with
    | Ok(_, image) -> OpenILModuleReaderFromBytes build.Reference image readerOptions
    | Error reason -> invalidOp $"C# project {build.Project} has no image to read: {reason}"

/// FCS's reference to the build: read under the `-r:` MSBuild wrote, and read again
/// whenever its inputs change.
let referencedProject (build: CSharpBuild) =
    FSharpReferencedProject.ILModuleReference(build.Reference, (fun () -> stampOf build), (fun () -> reader build))

/// The build of `reference` from `args`, kept in `builds` once Roslyn has emitted it.
let private validated (builds: CSharpBuilds) (reference: ResolvedReference) (args: string array) references =
    let arguments = CSharpCommandLineParser.Default.Parse(args, Path.GetDirectoryName reference.Project |> string, null)

    let build =
        { Project = reference.Project
          Framework = reference.Framework
          Reference = reference.Assembly
          Arguments = arguments
          References = references
          Gate = obj ()
          Emitted = None }

    emitted build
    |> Result.map (fun _ ->
        builds[keyOf reference.Project reference.Framework] <- build
        build)

/// The build of `reference`'s project for the framework MSBuild picked, compiled once and
/// kept in `builds`, the C# projects it references first; or why it could not be. A
/// project on `trail` is already being prepared: a cycle, which MSBuild refuses anyway.
let rec prepare (builds: CSharpBuilds) (trail: string list) (reference: ResolvedReference) (ct: CancellationToken) : Task<Result<CSharpBuild, string>> =
    task {
        match tryFind builds reference with
        | Some build -> return Ok build
        | None when trail |> List.exists (fun seen -> NativePaths.AreEqual(seen, reference.Project)) ->
            return Error $"{reference.Project} is referenced in a cycle"
        | None ->
            match! compilerArgs "CscCommandLineArgs" reference.Project reference.Framework ct with
            | Error reason -> return Error reason
            | Ok(args, resolved) ->
                let! references = prepareReferenced builds (reference.Project :: trail) resolved ct
                return validated builds reference args references
    }

/// The builds of the C# projects among `resolved` that could be prepared; one that could
/// not is left for the compiler to read from its DLL, and the log says why.
and private prepareReferenced builds trail (resolved: ResolvedReference list) ct : Task<CSharpBuild list> =
    task {
        let prepared = ResizeArray<CSharpBuild>()

        for inner in resolved |> List.filter (fun inner -> isCSharpProject inner.Project) do
            match! prepare builds trail inner ct with
            | Ok build -> prepared.Add build
            | Error reason -> Log.Warning("C# project {Path} is read from its DLL: {Reason}", inner.Project, reason)

        return List.ofSeq prepared
    }

/// The documentation id of `symbol`, which names the same declaration in Roslyn.
let private docId (symbol: FSharpSymbol) =
    match symbol with
    | :? FSharpEntity as entity -> Some entity.XmlDocSig
    | :? FSharpMemberOrFunctionOrValue as value -> Some value.XmlDocSig
    | :? FSharpField as field -> Some field.XmlDocSig
    | :? FSharpUnionCase as case -> Some case.XmlDocSig
    | _ -> None

/// The build FCS read `symbol` from, when a C# project compiled here declares it.
let private buildOf (builds: CSharpBuilds) (symbol: FSharpSymbol) =
    symbol.Assembly.FileName
    |> Option.bind (fun file -> builds.Values |> Seq.tryFind (fun build -> NativePaths.AreEqual(build.Reference, file)))

let private positionsOf (location: Location) =
    let span = location.GetLineSpan()
    span.Path, span.StartLinePosition.Line, span.StartLinePosition.Character, span.EndLinePosition.Line, span.EndLinePosition.Character

/// Where `symbol` is declared in C# source: its file and 0-based start and end positions
/// in the compilation FCS read it from, found by the documentation id both compilers give
/// one declaration. [DEFINITION-CROSSLANG]
let tryLocate (builds: CSharpBuilds) (symbol: FSharpSymbol) : (string * int * int * int * int) option =
    try
        buildOf builds symbol
        |> Option.bind (fun build -> docId symbol |> Option.map (fun id -> compilationOf build, id))
        |> Option.bind (fun (compilation, id) -> DocumentationCommentId.GetFirstSymbolForDeclarationId(id, compilation) |> Option.ofObj)
        |> Option.bind (fun declared -> declared.Locations |> Seq.tryFind _.IsInSource)
        |> Option.map positionsOf
    with ex ->
        Log.Debug(ex, "[F# Definition] the C# declaration of {Symbol} was not located", symbol.DisplayName)
        None
