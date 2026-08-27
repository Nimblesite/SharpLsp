using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.DoesNotContain
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Renaming a local, parameter or type parameter to a name that also exists as a
/// member of the enclosing type is legal C# — the local simply shadows the member.
/// The declaration-conflict gate must not treat that as a conflict, because an
/// empty <c>WorkspaceEdit</c> is mapped to LSP <c>null</c> by the host, which makes
/// the rename silently do nothing in the editor.
/// </summary>
public sealed class WorkspaceManagerRenameShadowingTests : IDisposable
{
    // `_counter` is a field; `seed` is a parameter; `total` is a local.
    // Renaming `seed`/`total` onto `_counter` shadows the field — legal.
    private const string Source =
        "namespace S;\n"
        + "\n"
        + "public class Shadow\n"
        + "{\n"
        + "    private int _counter;\n"
        + "\n"
        + "    public int Compute(int seed)\n"
        + "    {\n"
        + "        var total = seed + 1;\n"
        + "        return total;\n"
        + "    }\n"
        + "}\n";

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-rename-shadow-{Guid.NewGuid():N}"
    );

    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public WorkspaceManagerRenameShadowingTests()
    {
        Directory.CreateDirectory(_root);
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
            </Project>
            """;
        _csprojPath = Path.Combine(_root, "Shadow.csproj");
        _sourcePath = Path.Combine(_root, "Shadow.cs");
        File.WriteAllText(_csprojPath, csproj);
        File.WriteAllText(_sourcePath, Source);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    private async Task<WorkspaceManager> OpenAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var openResult = await manager.OpenAsync(_csprojPath).ConfigureAwait(true);
#pragma warning restore CS0618
        Assert.False(openResult.IsError, openResult.Match(_ => "ok", err => err));
        return manager;
    }

    private static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        return result.Match(value => value, _ => throw new InvalidOperationException("error"));
    }

    // Line 6 char 27 -> the `seed` parameter; line 8 char 12 -> the `total` local.
    [Theory]
    [InlineData(6, 27, "seed")]
    [InlineData(8, 12, "total")]
    public async Task Rename_local_or_parameter_onto_member_name_shadows_and_produces_edits(
        int line,
        int character,
        string original
    )
    {
        using var manager = await OpenAsync();

        var result = await manager.RenameAsync(_sourcePath, line, character, "_counter");

        var edit = Unwrap(result);
        Assert.NotEmpty(edit.DocumentChanges);
        var newText = edit.DocumentChanges[0].Edits;
        Assert.NotEmpty(newText);
        Assert.All(newText, e => Assert.Equal("_counter", e.NewText));
        Assert.DoesNotContain(original, string.Join(" ", newText.Select(e => e.NewText)));
    }

    /// <summary>A genuine same-kind collision (member vs member) must still be rejected.</summary>
    [Fact]
    public async Task Rename_field_onto_existing_member_name_is_still_rejected()
    {
        using var manager = await OpenAsync();

        // Line 4 char 16 -> the `_counter` field; `Compute` is an existing method.
        var result = await manager.RenameAsync(_sourcePath, 4, 16, "Compute");

        var edit = Unwrap(result);
        Assert.Empty(edit.DocumentChanges);
    }
}
