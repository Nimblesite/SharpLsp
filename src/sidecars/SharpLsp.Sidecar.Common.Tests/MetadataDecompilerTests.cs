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
    public void DecompileTypeToFile_sanitizes_colons_identically_on_every_platform()
    {
        // `Path.GetInvalidFileNameChars()` omits ':' on Unix (it returns only
        // { '\0', '/' } there), so a sanitizer that delegates to it alone strips
        // `global::`-style names on Windows and leaves them intact on Linux. The
        // decompiled file name must not depend on the host OS, so this asserts the
        // exact name rather than merely the absence of a colon.
        // Implements [DEFINITION-CROSSLANG].
        var path = MetadataDecompiler.DecompileTypeToFile(
            CoreLib,
            "System.Int32",
            "global::System.Int32"
        );

        Assert.NotNull(path);
        var fileName = Path.GetFileName(path!);
        Assert.False(fileName.Contains(':', StringComparison.Ordinal), fileName);
        Assert.Equal("global__System.Int32.cs", fileName);
    }

    [Fact]
    public void Types_sharing_a_display_name_never_overwrite_each_others_source()
    {
        // Every sidecar process — C# and F#, in every editor window — decompiles
        // into one shared temp directory. Keyed by display name alone, the second
        // type overwrote the first one's file, and navigating into the first then
        // showed the second's code (GitHub #173).
        var guid = MetadataDecompiler.DecompileTypeToFile(CoreLib, "System.Guid", "Shared173");
        var version = MetadataDecompiler.DecompileTypeToFile(
            CoreLib,
            "System.Version",
            "Shared173"
        );

        Assert.NotNull(guid);
        Assert.NotNull(version);
        Assert.NotEqual(guid, version);
        Assert.Equal("Shared173.cs", Path.GetFileName(guid!));
        Assert.Contains("struct Guid", File.ReadAllText(guid!), StringComparison.Ordinal);
        Assert.Contains("class Version", File.ReadAllText(version!), StringComparison.Ordinal);
    }

    [Fact]
    public void A_decompiled_file_deleted_behind_the_cache_is_written_again()
    {
        // Temp cleaners, and other sidecars, can remove the shared file at any
        // time; a remembered path to a file that no longer exists navigates
        // nowhere (GitHub #173).
        var first = MetadataDecompiler.DecompileTypeToFile(CoreLib, "System.TimeSpan", "TimeSpan");
        Assert.NotNull(first);
        File.Delete(first!);

        var second = MetadataDecompiler.DecompileTypeToFile(CoreLib, "System.TimeSpan", "TimeSpan");

        Assert.Equal(first, second);
        Assert.True(File.Exists(second), "the file is written again, not a dangling path");
        Assert.Contains("struct TimeSpan", File.ReadAllText(second!), StringComparison.Ordinal);
    }

    [Fact]
    public void A_file_another_process_holds_open_is_reused_and_left_whole()
    {
        // Another sidecar reading the published file must neither make this one
        // fail on a sharing violation nor let it rewrite the file under the
        // reader (GitHub #173).
        var path = MetadataDecompiler.DecompileTypeToFile(
            CoreLib,
            "System.DateTimeOffset",
            "DateTimeOffset"
        );
        Assert.NotNull(path);
        var complete = File.ReadAllText(path!);

        using (new FileStream(path!, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var again = MetadataDecompiler.DecompileTypeToFile(
                CoreLib,
                "System.DateTimeOffset",
                "DateTimeOffset"
            );
            Assert.Equal(path, again);
        }

        Assert.Equal(complete, File.ReadAllText(path!));
        Assert.Contains("struct DateTimeOffset", complete, StringComparison.Ordinal);
    }

    [Fact]
    public void Losing_the_publish_race_keeps_the_winners_file_and_no_staging_file()
    {
        // Two sidecars decompiling one type both stage a file; the second rename
        // finds the first one's published file. It must keep that file, succeed,
        // and leave no staging file behind (GitHub #173).
        var directory = Path.Combine(Path.GetTempPath(), $"sharplsp-publish-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var target = Path.Combine(directory, "Winner.cs");
            File.WriteAllText(target, "// published first");

            MetadataDecompiler.PublishAtomically(target, "// published second");

            Assert.Equal("// published first", File.ReadAllText(target));
            Assert.Equal([target], Directory.GetFiles(directory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void A_type_the_assembly_does_not_define_publishes_nothing()
    {
        var path = MetadataDecompiler.DecompileTypeToFile(
            CoreLib,
            "System.NoSuchType173",
            "NoSuchType173"
        );

        Assert.Null(path);
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
