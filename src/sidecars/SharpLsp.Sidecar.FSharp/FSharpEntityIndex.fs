/// The entities a file's check can reach: its own project's, and the public ones
/// of every assembly the project references. Completion offers them from
/// namespaces the file has not opened, and an undefined name's "Add 'open'" fix
/// looks its namespace up among them. Each referenced assembly's content is built
/// once per workspace, rebuilt when that assembly changes, and built ahead by the
/// background warm-up. Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-OPEN] (GitHub #122).
module SharpLsp.Sidecar.FSharp.FSharpEntityIndex

open System.Threading
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices

/// A project's referenced assemblies, grouped by the file each one is read from.
let private referencedFiles (context: FSharpProjectContext) =
    context.GetReferencedAssemblies() |> List.groupBy _.FileName

/// One referenced assembly file's public entities, from the workspace's cache once built.
let private contentOf (state: FSharpWorkspace.FSharpWorkspaceState) (fileName, assemblies) =
    AssemblyContent.GetAssemblyContent state.Entities.Locking AssemblyContentType.Public fileName assemblies

/// The entities `checkResults` can reach: the project's own, and its references' public ones.
let entities state (checkResults: FSharpCheckFileResults) () : AssemblySymbol list =
    let own = AssemblyContent.GetAssemblySignatureContent AssemblyContentType.Full checkResults.PartialAssemblySignature
    own @ (referencedFiles checkResults.ProjectContext |> List.collect (contentOf state))

/// Build a checked project's referenced entities ahead of its first completion, one
/// assembly at a time so a cancelled `ct` stops between them. [SHARPLSP-FEATURES-WARM-UP]
let warm state (context: FSharpProjectContext) (ct: CancellationToken) =
    referencedFiles context
    |> List.iter (fun reference ->
        ct.ThrowIfCancellationRequested()
        contentOf state reference |> ignore)

/// Whether the entities of every assembly file `context` references are built. FCS's
/// cache entry type is internal, so its option's members cannot be called from here: an
/// entry is told apart by presence alone, since a missing one is the null option.
let internal isBuilt (state: FSharpWorkspace.FSharpWorkspaceState) (context: FSharpProjectContext) =
    let cache = state.Entities :> IAssemblyContentCache
    referencedFiles context
    |> List.forall (fun (fileName, _) -> fileName |> Option.forall (fun file -> not (obj.ReferenceEquals(cache.TryGet file, null))))
