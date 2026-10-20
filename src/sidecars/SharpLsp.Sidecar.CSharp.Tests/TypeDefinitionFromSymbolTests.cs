using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this suite

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Type definition from a declared symbol, as from a use, on the shared query project:
/// a variable's declaration goes to its type, and a method call to the method's return
/// type. Implements [DEFINITION-CSHARP-CASES].
/// </summary>
public sealed class TypeDefinitionFromSymbolTests : IClassFixture<WorkspaceManagerQueryFixture>
{
    private readonly WorkspaceManagerQueryFixture _fixture;

    public TypeDefinitionFromSymbolTests(WorkspaceManagerQueryFixture fixture)
    {
        _fixture = fixture;
        Assert.True(_fixture.OpenError is null, _fixture.OpenError ?? "ok");
    }

    private WorkspaceManager Manager => _fixture.Manager;

    private string SourcePath => _fixture.SourcePath;

    [Fact]
    public async Task Type_definition_from_a_declaration_or_a_call_goes_to_the_symbols_type()
    {
        // Line 29: `var sum = calc.Add(1, 2);` → the use `calc` (char 18) is the baseline.
        var used = AssertOk(await Manager.GetTypeDefinitionAsync(SourcePath, 29, 18));
        Assert.NotNull(used);
        Assert.True(NativePaths.AreEqual(SourcePath, used.FilePath), used.FilePath);
        Assert.Equal((10, 13), (used.Line, used.Character));

        // Line 28: `var calc = new Calculator();` → the declared `calc` (char 12) answers the same.
        var declared = AssertOk(await Manager.GetTypeDefinitionAsync(SourcePath, 28, 13));
        Assert.NotNull(declared);
        Assert.True(NativePaths.AreEqual(SourcePath, declared.FilePath), declared.FilePath);
        Assert.Equal((used.Line, used.Character), (declared.Line, declared.Character));

        // Line 29: the call `Add` (char 23) goes to its return type, int, in metadata.
        var returned = AssertOk(await Manager.GetTypeDefinitionAsync(SourcePath, 29, 24));
        Assert.NotNull(returned);
        Assert.False(NativePaths.AreEqual(SourcePath, returned.FilePath), returned.FilePath);
        Assert.Equal("Int32", TextAt(returned));
    }

    private static TValue AssertOk<TValue>(Outcome.Result<TValue, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        return +result;
    }

    private static string TextAt(LocationResult location)
    {
        var line = File.ReadAllLines(location.FilePath)[location.Line];
        return line[location.Character..location.EndCharacter];
    }
}
