using SharpLsp.Sidecar.Common;
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
        + "\n"
        + "    public int Other(string value) => value.Length;\n"
        + "    public int SameSignature(int value) => value;\n"
        + "}\n"
        + "\n"
        + "public class Original { }\n"
        + "public class Target<T> { }\n"
        + "public class Refs\n"
        + "{\n"
        + "    public void ByRef(ref int value) { }\n"
        + "    public void ByOut(out int value) => value = 0;\n"
        + "    public void ByObject(object value) { }\n"
        + "    public void ByDynamic(dynamic value) { }\n"
        + "}\n";

    private readonly string _root = NativePaths.Temp($"sharplsp-rename-shadow-{Guid.NewGuid():N}");

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
        _csprojPath = NativePaths.Join(_root, "Shadow.csproj");
        _sourcePath = NativePaths.Join(_root, "Shadow.cs");
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

    [Fact]
    public async Task Rename_method_onto_existing_different_signature_preserves_valid_overload()
    {
        // [RENAME-CSHARP] Roslyn allows Compute(int) and Other(string) to share a name.
        using var manager = await OpenAsync();

        var result = await manager.RenameAsync(_sourcePath, 6, 16, "Other");

        var edit = Unwrap(result);
        var document = Assert.Single(edit.DocumentChanges);
        Assert.Contains(document.Edits, item => item.NewText == "Other");
        Assert.All(document.Edits, item => Assert.Equal("Other", item.NewText));
    }

    [Fact]
    public async Task Rename_method_onto_existing_same_signature_is_rejected()
    {
        // [RENAME-CSHARP] A method rename cannot create a second (int) overload.
        using var manager = await OpenAsync();

        var result = await manager.RenameAsync(_sourcePath, 6, 16, "SameSignature");

        Assert.Empty(Unwrap(result).DocumentChanges);
    }

    [Fact]
    public async Task Rename_type_onto_existing_different_arity_is_allowed()
    {
        // [RENAME-CSHARP] Target and Target<T> are distinct C# type declarations.
        using var manager = await OpenAsync();

        var result = await manager.RenameAsync(_sourcePath, 16, 13, "Target");

        var document = Assert.Single(Unwrap(result).DocumentChanges);
        Assert.Contains(document.Edits, item => item.NewText == "Target");
    }

    // [RENAME-CSHARP] C# overloads cannot differ only by ref/out or by dynamic/object
    // (CS0663, CS0111), so these renames would create duplicate signatures.
    [Theory]
    [InlineData(21, 16, "ByRef")]
    [InlineData(23, 16, "ByObject")]
    public async Task Rename_method_onto_signature_differing_only_by_ref_kind_or_dynamic_is_rejected(
        int line,
        int character,
        string target
    )
    {
        using var manager = await OpenAsync();

        var result = await manager.RenameAsync(_sourcePath, line, character, target);

        Assert.Empty(Unwrap(result).DocumentChanges);
    }
}
