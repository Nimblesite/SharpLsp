using System.Diagnostics;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes. RS1035: these tests deliberately touch the real
// filesystem — the repo mandates testing against real files, not mocks.
#pragma warning disable CA1515
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A file-based app's closure tells files apart the way their directory does. Two names that
/// differ only in case are two files in a case-sensitive directory — Linux, a case-sensitive
/// APFS volume, a Windows directory with the flag set — and one file in a case-insensitive
/// one. Folding case everywhere dropped the second of two such files with no issue at all, so
/// every symbol it declared reported CS0246 (GitHub #190). Implements [SCRIPT-CLOSURE].
/// </summary>
public sealed class DocumentClosureCaseTests : IDisposable
{
    private readonly string _root = Directory
        .CreateDirectory(NativePaths.Temp($"sharplsp-case-{Guid.NewGuid():N}"))
        .FullName;

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException)
        {
            // Best-effort cleanup: an indexer or scanner can hold a transient handle.
        }
    }

    /// <summary>
    /// The app, including <c>Helpers/Foo.cs</c> and <c>Helpers/foo.cs</c>, and the
    /// <c>Helpers</c> directory it includes them from.
    /// </summary>
    private (string App, string Helpers) AppIncludingBothSpellings()
    {
        var helpers = Directory.CreateDirectory(NativePaths.Join(_root, "Helpers")).FullName;
        var app = NativePaths.Join(_root, "App.cs");
        File.WriteAllText(
            app,
            "#:include Helpers/Foo.cs\n#:include Helpers/foo.cs\nConsole.WriteLine(1);\n"
        );
        return (app, helpers);
    }

    /// <summary>Whether a file written under one case is missing under the other.</summary>
    private static bool TellsCaseApart(string directory)
    {
        var probe = NativePaths.Join(directory, "Probe.txt");
        File.WriteAllText(probe, string.Empty);
        try
        {
            return !File.Exists(NativePaths.Join(directory, "PROBE.TXT"));
        }
        finally
        {
            File.Delete(probe);
        }
    }

    /// <summary>
    /// Make the empty <paramref name="directory"/> case-sensitive where the platform lets a
    /// directory choose; Linux directories already are.
    /// </summary>
    private static bool MakeCaseSensitive(string directory)
    {
        if (OperatingSystem.IsWindows())
        {
            using var fsutil = Process.Start(
                new ProcessStartInfo(
                    "fsutil",
                    ["file", "setCaseSensitiveInfo", directory, "enable"]
                )
                {
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                }
            );
            fsutil?.WaitForExit();
        }

        return TellsCaseApart(directory);
    }

    [Fact]
    public async Task In_a_case_sensitive_directory_both_files_are_in_the_closure()
    {
        var (app, helpers) = AppIncludingBothSpellings();
        if (!MakeCaseSensitive(helpers))
        {
            return; // A default macOS volume cannot hold two such files at all.
        }

        var upper = NativePaths.Join(helpers, "Foo.cs");
        var lower = NativePaths.Join(helpers, "foo.cs");
        await File.WriteAllTextAsync(upper, "internal static class Upper { }\n")
            .ConfigureAwait(true);
        await File.WriteAllTextAsync(lower, "internal static class Lower { }\n")
            .ConfigureAwait(true);

        var closure = await DocumentClosure.ExpandFileBasedAsync(
            app,
            live: null,
            CancellationToken.None
        );

        Assert.Equal(3, closure.Files.Count);
        Assert.Contains(
            closure.Files,
            file => string.Equals(file.Path, upper, StringComparison.Ordinal)
        );
        Assert.Contains(
            closure.Files,
            file => string.Equals(file.Path, lower, StringComparison.Ordinal)
        );
        Assert.Empty(closure.Issues);

        // Unsaved text belongs to the file it was typed into, never its case-twin.
        var edited = await DocumentClosure.ExpandFileBasedAsync(
            app,
            new LiveText(lower, "internal static class Edited { }\n"),
            CancellationToken.None
        );
        var byPath = edited.Files.ToDictionary(
            file => file.Path,
            file => file.Text,
            StringComparer.Ordinal
        );
        Assert.Equal("internal static class Edited { }\n", byPath[lower]);
        Assert.Equal("internal static class Upper { }\n", byPath[upper]);
    }

    [Fact]
    public async Task In_a_case_insensitive_directory_one_file_spelled_two_ways_is_in_the_closure_once()
    {
        var (app, helpers) = AppIncludingBothSpellings();
        if (TellsCaseApart(helpers))
        {
            return; // A Linux directory cannot fold case at all.
        }

        await File.WriteAllTextAsync(
                NativePaths.Join(helpers, "Foo.cs"),
                "internal static class Upper { }\n"
            )
            .ConfigureAwait(true);

        var closure = await DocumentClosure.ExpandFileBasedAsync(
            app,
            live: null,
            CancellationToken.None
        );

        Assert.Equal(2, closure.Files.Count);
        _ = Assert.Single(closure.Files, file => NativePaths.SameName(file.Path, "Foo.cs"));
        Assert.Empty(closure.Issues);
    }
}
