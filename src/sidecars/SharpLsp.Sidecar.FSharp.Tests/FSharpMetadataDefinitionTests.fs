/// Go-to-definition on an IMPORTED F# symbol must land in metadata-as-source that
/// exists on this machine. FCS reports a phantom declaration for imported
/// entities — `startup` for a framework type, the build server's path for an
/// FSharp.Core function — and that phantom used to win over the decompiled
/// source, so the editor opened a file the user does not have (GitHub #220).
/// [DEFINITION-CROSSLANG]
module SharpLsp.Sidecar.FSharp.Tests.FSharpMetadataDefinitionTests

open System
open System.IO
open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests

/// Definition two characters into the first `needle` on `line` of `src`.
let private definitionOf (src: string) line (needle: string) = task {
    let! (state, dir, _, paths) = loadWorkspace [ "M.fs", src ]

    try
        let text = src.Split('\n')[line]
        let character = text.IndexOf(needle, StringComparison.Ordinal) + 2
        let! definition = FSharpWorkspace.getDefinition state paths[0] line character
        return definition, paths[0]
    finally
        cleanup dir
}

[<Fact>]
let ``a framework type's definition is decompiled source that exists, not FCS's startup range`` () = task {
    let! (definition, _) =
        definitionOf "module M\nlet started: System.DateTime = System.DateTime.UtcNow\n" 1 "DateTime"

    Assert.True(definition.IsSome, "an imported type must still navigate somewhere")
    let location = definition.Value
    Assert.NotEqual<string>("startup", location.FilePath)
    Assert.True(File.Exists location.FilePath, $"the definition must be a file this machine has: {location.FilePath}")
    Assert.Contains("sharplsp-decompiled", location.FilePath)
    Assert.Contains("struct DateTime", File.ReadAllText location.FilePath)
}

[<Fact>]
let ``an FSharp.Core function's definition is decompiled source that exists, not the build server's path`` () = task {
    let! (definition, _) = definitionOf "module M\nlet total = List.sum [ 1; 2; 3 ]\n" 1 "sum"

    Assert.True(definition.IsSome, "an FSharp.Core function must still navigate somewhere")
    let location = definition.Value
    Assert.True(File.Exists location.FilePath, $"the definition must be a file this machine has: {location.FilePath}")
    Assert.Contains("sharplsp-decompiled", location.FilePath)
    Assert.EndsWith(".cs", location.FilePath)
}

[<Fact>]
let ``a symbol declared in the project's own source still lands in that source`` () = task {
    let! (definition, sourceFile) =
        definitionOf "module M\nlet helper value = value + 1\nlet answer = helper 41\n" 2 "helper"

    Assert.True(definition.IsSome, "a source symbol navigates to its declaration")
    let location = definition.Value
    Assert.Equal(Path.GetFullPath sourceFile, Path.GetFullPath location.FilePath)
    Assert.Equal(1, location.Line)
}
