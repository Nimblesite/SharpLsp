using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // File IO is banned for analyzers — these are tests

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// [RENAME-COVERAGE] Turning an implicit conversion explicit casts only the uses that were
/// implicit: a cast already written stays one cast, and a conversion nested inside another
/// converted argument gets its own cast without the two edits overlapping. [RENAME-ERRORS]
/// </summary>
public sealed class WorkspaceManagerRenameConversionCastsTests : IAsyncLifetime, IDisposable
{
    private const string Source = """
        namespace Casts;

        public readonly struct Money
        {
            public Money(int cents) => Cents = cents;
            public int Cents { get; }
            public static implicit operator int(Money value) => value.Cents;
        }

        public static class Uses
        {
            public static int Spelled(Money a) => (int)a;
            public static Money Pass(int cents) => new(cents);
            public static int Twice(int cents) => cents * 2;
            public static int Nested(Money a) => Twice(Pass(a));
        }

        """;

    private readonly string _root = NativePaths.Temp($"sharplsp-rename-casts-{Guid.NewGuid():N}");
    private readonly WorkspaceManager _manager = new();
    private string SourcePath => NativePaths.Join(_root, "Money.cs");

    public async Task InitializeAsync()
    {
        _ = Directory.CreateDirectory(_root);
        var project = NativePaths.Join(_root, "Casts.csproj");
        await File.WriteAllTextAsync(
                project,
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Library</OutputType></PropertyGroup></Project>"
            )
            .ConfigureAwait(false);
        await File.WriteAllTextAsync(SourcePath, Source).ConfigureAwait(false);
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var opened = await _manager.OpenAsync(project).ConfigureAwait(false);
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
    }

    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _manager.Dispose();
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, true);
        }
    }

    [Fact]
    public async Task Implicit_to_explicit_casts_a_conversion_nested_in_a_converted_argument_without_overlapping_edits()
    {
        const string marker = "implicit operator int";
        var offset = Source.IndexOf(marker, StringComparison.Ordinal);
        var at = SourceText.From(Source).Lines.GetLinePosition(offset);

        var result = await _manager.RenameAsync(SourcePath, at.Line, at.Character, "explicit");

        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        var edits = (+result).DocumentChanges.SelectMany(change => change.Edits);
        var renamed = TextEditing.ApplyEdits(Source, edits);
        Assert.Contains("explicit operator int", renamed, StringComparison.Ordinal);
        Assert.Contains("Spelled(Money a) => (int)a;", renamed, StringComparison.Ordinal);
        Assert.DoesNotContain("(int)(int)", renamed, StringComparison.Ordinal);
        Assert.DoesNotContain("(int)((int)", renamed, StringComparison.Ordinal);
        Assert.Contains("Twice((int)(Pass((int)(a))))", renamed, StringComparison.Ordinal);
    }
}
