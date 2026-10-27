/// A wildcard `<Compile Include="*.fs" />` is MSBuild's to expand: the sidecar must
/// read the project's evaluated `Compile` items, in project order, never resolve
/// the `Include` attribute as a literal path (GitHub #455). Exclude, Remove,
/// Condition and `Directory.Build.props` imports are all MSBuild evaluation, so a
/// file matched only by the glob is owned and analysed, and its real FCS
/// diagnostics (FS0001) surface.
/// Implements [NETFX-PROJECTS-FSHARP].
module SharpLsp.Sidecar.FSharp.Tests.FSharpWildcardCompileTests

open System
open System.IO
open System.Threading
open System.Xml.Linq
open FSharp.Compiler.Diagnostics
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

let private element (name: string) (children: obj list) = XElement(XName.Get name, Array.ofList children)

let private attribute (name: string) (value: string) = XAttribute(XName.Get name, value) :> obj

/// `sources` as their file names only, in order.
let private sourceNames (options: FSharp.Compiler.CodeAnalysis.FSharpProjectOptions) =
    options.SourceFiles |> Array.map NativePaths.NameOf

/// A real wildcard project: the explicit `Helper.fs`, a glob that excludes two
/// files, a `Remove`, a conditioned item, and an item imported from
/// `Directory.Build.props`. Every source file is self-contained so the only
/// error is the FS0001 planted in `Alpha.fs` (matched only by the glob).
let private writeWildcardProject (root: string) (includeConditional: bool) =
    Directory.CreateDirectory(NativePaths.Resolve(root, "Sources")) |> ignore

    let property (name: string) (value: string) = element name [ value :> obj ]

    let properties: obj list =
        [ property "TargetFramework" "net10.0"
          property "DisableImplicitFSharpCoreReference" "true"
          property "IncludeConditional" (string includeConditional) ]

    let compile (includePath: string) : obj =
        element "Compile" [ attribute "Include" includePath ]

    let items: obj list =
        [ compile "Helper.fs"
          element "Compile" [ attribute "Include" "Sources/*.fs"; attribute "Exclude" "Sources/Removed.fs;Sources/Conditional.fs" ]
          element "Compile" [ attribute "Remove" "Sources/Beta.fs" ]
          element "Compile" [ attribute "Include" "Sources/Conditional.fs"; attribute "Condition" "'$(IncludeConditional)' == 'true'" ] ]

    XDocument(
        element
            "Project"
            [ attribute "Sdk" "Microsoft.NET.Sdk"
              element "PropertyGroup" properties
              element "ItemGroup" items ]
    )
        .Save(NativePaths.Resolve(root, "Wild.fsproj"))

    XDocument(
        element
            "Project"
            [ element "ItemGroup" [ compile "Imported.fs" ] ]
    )
        .Save(NativePaths.Resolve(root, "Directory.Build.props"))

    File.WriteAllText(NativePaths.Resolve(root, "Imported.fs"), "module Imported\nlet imported = 1\n")
    File.WriteAllText(NativePaths.Resolve(root, "Helper.fs"), "module Helper\nlet helper = 2\n")

    File.WriteAllText(
        NativePaths.Resolve(root, "Sources", "Alpha.fs"),
        "module Alpha\n\nlet value = 42\n\nlet broken: int = \"oops\"\n"
    )

    File.WriteAllText(NativePaths.Resolve(root, "Sources", "Gamma.fs"), "module Gamma\nlet gamma = 3\n")
    File.WriteAllText(NativePaths.Resolve(root, "Sources", "Beta.fs"), "module Beta\nlet beta = 4\n")
    File.WriteAllText(NativePaths.Resolve(root, "Sources", "Removed.fs"), "module Removed\nlet removed = 5\n")
    File.WriteAllText(NativePaths.Resolve(root, "Sources", "Conditional.fs"), "module Conditional\nlet conditional = 6\n")

    let fsproj = NativePaths.Resolve(root, "Wild.fsproj")
    fsproj, NativePaths.Resolve(root, "Sources", "Alpha.fs")

/// The wildcard-only file is owned by the loaded project and checks with FCS:
/// its FS0001 must surface, and its `value` must answer hover.
let private assertOwnedAndAnalysed (state: FSharpWorkspace.FSharpWorkspaceState) (alpha: string) = task {
    Assert.Contains(alpha, state.ProjectOptions.Value.SourceFiles)

    let! checkedFile = FSharpWorkspace.checkFile state alpha
    let diagnostics = checkedFile |> Option.map (fun (results, _) -> results.Diagnostics) |> Option.defaultValue [||]
    Assert.Contains(diagnostics, fun diagnostic -> diagnostic.Severity = FSharpDiagnosticSeverity.Error && diagnostic.ErrorNumber = 1)

    let! hover = FSharpWorkspace.getHover state alpha 2 5
    Assert.True(hover.IsSome, $"the wildcard-only file {alpha} must answer hover")
    let markdown, _, _, _, _ = hover.Value
    Assert.Contains("int", markdown)
}

[<Fact>]
let ``a wildcard fsproj loads MSBuild's ordered Compile items and analyses the glob-only file`` () = task {
    let root = NativePaths.Temp($"sharplsp-wildcard-{Guid.NewGuid():N}")

    try
        let fsproj, alpha = writeWildcardProject root true
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspaceLoading.loadProject state root
        Assert.Equal(Ok(), loaded)

        // Glob expansion, Exclude, Remove, Condition and the Directory.Build.props
        // import are all MSBuild evaluation, in project order.
        Assert.Equal<string array>(
            [| "Imported.fs"; "Helper.fs"; "Alpha.fs"; "Gamma.fs"; "Conditional.fs" |],
            sourceNames state.ProjectOptions.Value
        )

        do! assertOwnedAndAnalysed state alpha
    finally
        cleanup root
}

[<Fact>]
let ``a false Condition omits its compile item from the evaluated order`` () = task {
    let root = NativePaths.Temp($"sharplsp-wildcard-off-{Guid.NewGuid():N}")

    try
        let _fsproj, _alpha = writeWildcardProject root false
        let state = FSharpWorkspace.create ()
        let! loaded = FSharpWorkspaceLoading.loadProject state root
        Assert.Equal(Ok(), loaded)

        Assert.Equal<string array>(
            [| "Imported.fs"; "Helper.fs"; "Alpha.fs"; "Gamma.fs" |],
            sourceNames state.ProjectOptions.Value
        )
        Assert.DoesNotContain(state.ProjectOptions.Value.SourceFiles, fun source -> NativePaths.NameOf source = "Conditional.fs")
    finally
        cleanup root
}
