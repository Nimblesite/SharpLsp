/// FS0039 imports from outside the file project's references. FCS checks the
/// other loaded F# projects for public types and their referenced assemblies;
/// NuGet identity comes from that project's assets, then the shared curated
/// table. Implements [REFACTOR-IMPORT-REFERENCE].
module SharpLsp.Sidecar.FSharp.FSharpImportReferences

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open FSharp.Compiler.Text
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.Common.References
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

[<NoComparison; NoEquality>]
type private ImportContext =
    { Workspace: FSharpWorkspace.FSharpWorkspaceState
      ParseResults: FSharpParseFileResults
      Line: int -> string
      FilePath: string
      DiagnosticRange: range
      OwnProject: string
      Name: string }

let private projectName path = NativePaths.NameOf path |> string
let private projectStem path = NativePaths.StemOf path |> string

let private directReferences (state: FSharpWorkspace.FSharpWorkspaceState) (project: string) =
    match state.References.TryGetValue(NativePaths.NormalizeFullPath project) with
    | true, references -> references
    | _ -> []

/// Whether `from` reaches `target` through loaded F# project references.
let rec private reaches state (from: string) (target: string) =
    let rec walk trail current =
        if NativePaths.AreEqual(current, target) then true
        elif trail |> List.exists (fun seen -> NativePaths.AreEqual(seen, current)) then false
        else directReferences state current |> List.exists (walk (current :: trail))
    walk [] from

let private otherProjects (state: FSharpWorkspace.FSharpWorkspaceState) ownProject =
    state.Projects.Values
    |> Seq.filter (fun entry -> not (NativePaths.AreEqual(entry.Path, ownProject)))
    |> List.ofSeq

let private importable name (entity: FSharpEntity) =
    let topLevel = entity.DeclaringEntity |> Option.forall (fun parent -> parent.IsNamespace)
    entity.Accessibility.IsPublic
    && not entity.IsNamespace
    && not entity.IsFSharpModule
    && topLevel
    && (entity.DisplayName = name || entity.CompiledName = name || entity.LogicalName = name)

let private namedTypes name (entities: seq<FSharpEntity>) =
    FSharpEntityIndex.allNested entities
    |> Seq.filter (importable name)
    |> List.ofSeq

let private fullName (entity: FSharpEntity) =
    match entity.Namespace, entity.TryFullName with
    | Some namespaceName, Some fullName when namespaceName.Length > 0 -> Some(namespaceName, fullName)
    | _ -> None

let private referenceAction (context: ImportContext) (reference: ReferenceImport) (title: string) (namespaceName: string) =
    let parts = namespaceName.Split '.'
    let at = FSharpQuickFix.openPosition context.ParseResults context.Line context.DiagnosticRange.StartLine parts
    FSharpQuickFix.insertLine title context.FilePath at $"open {namespaceName}", reference

let private projectAction (context: ImportContext) (entry: FSharpDesignTime.FSharpProjectEntry) (entity: FSharpEntity) =
    fullName entity
    |> Option.map (fun (namespaceName, fullName) ->
        let other, own = projectStem entry.Path, projectName context.OwnProject
        let title = $"Reference project {other} from {own} and add 'open {namespaceName}' — {other} declares {fullName}"
        let reference = ReferenceImport.ToProject(context.OwnProject, entry.Path)
        referenceAction context reference title namespaceName)

let private packageAction (context: ImportContext) (entry: FSharpDesignTime.FSharpProjectEntry) assemblyPath (entity: FSharpEntity) =
    fullName entity
    |> Option.bind (fun (namespaceName, _) ->
        PackageOfAssembly.Find(entry.Path, assemblyPath)
        |> Option.ofObj
        |> Option.map (fun package ->
            let title =
                $"Add package {package.Id} {package.Version} to {projectName context.OwnProject} (as in {projectName entry.Path}) and add 'open {namespaceName}'"
            let reference = ReferenceImport.ToPackage(context.OwnProject, package.Id, package.Version)
            referenceAction context reference title namespaceName))

let private projectActions (context: ImportContext) (entry: FSharpDesignTime.FSharpProjectEntry) (checkedProject: FSharpCheckProjectResults) =
    if reaches context.Workspace context.OwnProject entry.Path
       || reaches context.Workspace entry.Path context.OwnProject then []
    else
        namedTypes context.Name checkedProject.AssemblySignature.Entities
        |> List.choose (projectAction context entry)

let private assemblyActions (context: ImportContext) (entry: FSharpDesignTime.FSharpProjectEntry) (assembly: FSharpAssembly) =
    assembly.FileName
    |> Option.map (fun path ->
        namedTypes context.Name assembly.Contents.Entities
        |> List.choose (packageAction context entry path))
    |> Option.defaultValue []

let private packageActions (context: ImportContext) (entry: FSharpDesignTime.FSharpProjectEntry) (checkedProject: FSharpCheckProjectResults) =
    checkedProject.ProjectContext.GetReferencedAssemblies()
    |> List.collect (assemblyActions context entry)

let private checkProject (state: FSharpWorkspace.FSharpWorkspaceState) (entry: FSharpDesignTime.FSharpProjectEntry) =
    Async.StartAsTask(state.Checker.ParseAndCheckProject(FSharpWorkspace.wired state entry.Options))

let rec private collectActions (context: ImportContext) (entries: FSharpDesignTime.FSharpProjectEntry list) =
    task {
        match entries with
        | [] -> return [], []
        | entry :: rest ->
            let! checkedProject = checkProject context.Workspace entry
            let projects = projectActions context entry checkedProject
            let packages = packageActions context entry checkedProject
            let! moreProjects, morePackages = collectActions context rest
            return projects @ moreProjects, packages @ morePackages
    }

let private wellKnownActions (context: ImportContext) =
    WellKnownPackages.Named(context.Name)
    |> Seq.map (fun known ->
        let title =
            $"Install package {known.PackageId} (latest stable from nuget.org) in {projectName context.OwnProject} and add 'open {known.Namespace}'"
        let reference = ReferenceImport.ToPackage(context.OwnProject, known.PackageId, "")
        referenceAction context reference title known.Namespace)
    |> List.ofSeq

/// Project and solution-package actions are both offered; a well-known package
/// is the fallback only when neither exists. Each resolve is exactly its open.
let actions workspace parseResults source filePath (diagnosticRange: range) name =
    task {
        match FSharpWorkspace.optionsFor workspace filePath with
        | None -> return []
        | Some own ->
            let context =
                { Workspace = workspace
                  ParseResults = parseResults
                  Line = FSharpLocalAnalysis.lineGetter source
                  FilePath = filePath
                  DiagnosticRange = diagnosticRange
                  OwnProject = own.ProjectFileName
                  Name = name }
            let! projects, packages = collectActions context (otherProjects workspace own.ProjectFileName)
            let solutionActions = projects @ packages
            if solutionActions.IsEmpty then return wellKnownActions context
            else return solutionActions
    }
