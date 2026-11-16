/// `workspace/diagnostics/documents`: the loaded workspace's source documents with
/// their owning project, for the host's pull-diagnostics enumeration
/// ([DIAG-ARCHITECTURE-PULL-REFRESH]). A pure walk of the loaded FCS project
/// graphs — no eager compilation and no diagnostic result caches
/// ([DIAG-ARCHITECTURE-EAGER-SCAN]).
module SharpLsp.Sidecar.FSharp.FSharpDocuments

open FSharp.Compiler.CodeAnalysis
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Messages
open SharpLsp.Sidecar.FSharp

/// The document one project's source file belongs to: its normal spelling of the
/// path plus the owning project's name (the project file's stem) and path.
let private documentOf (options: FSharpProjectOptions) (file: string) =
    DiagnosticDocument(
        FilePath = NativePaths.NormalizeFullPath file,
        ProjectName = NativePaths.StemOf options.ProjectFileName,
        ProjectPath = NativePaths.NormalizeFullPath options.ProjectFileName
    )

/// Source and project metadata use the same native path identity.
let private distinctDocuments (documents: DiagnosticDocument seq) =
    System.Linq.Enumerable.DistinctBy(
        documents,
        (fun document -> document.FilePath),
        NativePaths.Comparer
    )
    |> Array.ofSeq

/// Real loaded projects, without compiling them or changing the source-only RPC.
/// Implements [DIAG-CATEGORIES-COMPILER].
let projectDocuments (state: FSharpWorkspace.FSharpWorkspaceState) : DiagnosticDocument array =
    state.Projects.Values
    |> Seq.map (fun entry -> documentOf entry.Options entry.Options.ProjectFileName)
    |> distinctDocuments

/// Every source document of every loaded project, the workspace's first, each once —
/// by the one path identity, so a multi-framework build and a file two projects
/// compile are answered once, by their first owner, matching who checks them.
/// Generated sources in build output (`obj/…AssemblyInfo.fs`) are the build's, not
/// the developer's: they are never listed. [DIAG-CONFIG-OWNED-SOURCES]
let sourceDocuments (state: FSharpWorkspace.FSharpWorkspaceState) : DiagnosticDocument array =
    FSharpWorkspace.projectOptions state
    |> Seq.collect (fun options ->
        options.SourceFiles
        |> Array.filter (NativePaths.IsBuildOutput >> not)
        |> Array.map (documentOf options))
    |> distinctDocuments
