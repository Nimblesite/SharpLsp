#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers - tests own temp fixtures
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Coverage for <see cref="MetadataDecompiler"/>, the shared metadata-as-source
/// decompiler used by cross-language and framework go-to-definition
/// ([DEFINITION-CROSSLANG]). Decompiles real BCL types on disk and searches real
/// decompiled files.
/// </summary>
public sealed class MetadataDecompilerTests
{
    // A real, always-present, decompilable assembly: the BCL core.
    private static readonly string CoreLib = typeof(string).Assembly.Location;

    [Fact]
    public void DecompileTypeToFile_writes_navigable_source_for_a_real_type()
    {
        var path = MetadataDecompiler.DecompileTypeToFile(CoreLib, "System.String", "String");

        Assert.NotNull(path);
        Assert.EndsWith(".cs", path!, StringComparison.Ordinal);
        Assert.True(File.Exists(path));
        Assert.Contains("String", File.ReadAllText(path!), StringComparison.Ordinal);
    }

    [Fact]
    public void DecompileTypeToFile_caches_repeat_navigations()
    {
        var first = MetadataDecompiler.DecompileTypeToFile(
            CoreLib,
            "System.Text.StringBuilder",
            "StringBuilder"
        );
        var second = MetadataDecompiler.DecompileTypeToFile(
            CoreLib,
            "System.Text.StringBuilder",
            "StringBuilder"
        );

        Assert.NotNull(first);
        Assert.Equal(first, second);
    }

    [Fact]
    public void DecompileTypeToFile_sanitizes_special_characters_in_display_name()
    {
        var path = MetadataDecompiler.DecompileTypeToFile(
            CoreLib,
            "System.Collections.Generic.List`1",
            "List<int>, System"
        );

        Assert.NotNull(path);
        var fileName = Path.GetFileName(path!);
        Assert.False(fileName.Contains('<', StringComparison.Ordinal), fileName);
        Assert.False(fileName.Contains('>', StringComparison.Ordinal), fileName);
        Assert.False(fileName.Contains(',', StringComparison.Ordinal), fileName);
        Assert.False(fileName.Contains(' ', StringComparison.Ordinal), fileName);
    }

    [Fact]
    public void DecompileTypeToFile_returns_null_for_a_missing_assembly()
    {
        var path = MetadataDecompiler.DecompileTypeToFile(
            Path.Combine(Path.GetTempPath(), $"nope-{Guid.NewGuid():N}.dll"),
            "System.String",
            "String"
        );

        Assert.Null(path);
    }

    [Fact]
    public void FindDeclaration_matches_pattern_then_name_then_falls_back_to_origin()
    {
        var file = Path.Combine(Path.GetTempPath(), $"decompiled-{Guid.NewGuid():N}.cs");
        File.WriteAllText(file, "namespace N;\npublic class Widget\n{\n    public int Value;\n}\n");
        try
        {
            // Pattern hit uses columnOffset 1.
            var byPattern = MetadataDecompiler.FindDeclaration(file, "Widget", "class Widget");
            Assert.Equal(1, byPattern.Line);
            Assert.True(byPattern.Character > 0);

            // Name-only hit strips the backtick arity suffix (`Widget`1` -> `Widget`).
            var byName = MetadataDecompiler.FindDeclaration(file, "Widget`1", pattern: null);
            Assert.Equal(1, byName.Line);

            // Nothing matches -> navigate to the file origin.
            var origin = MetadataDecompiler.FindDeclaration(file, "Absent", "also absent");
            Assert.Equal(new DecompiledPosition(0, 0), origin);
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public void FindDeclaration_on_missing_file_returns_origin()
    {
        var pos = MetadataDecompiler.FindDeclaration(
            Path.Combine(Path.GetTempPath(), $"gone-{Guid.NewGuid():N}.cs"),
            "X",
            null
        );

        Assert.Equal(new DecompiledPosition(0, 0), pos);
    }
}
