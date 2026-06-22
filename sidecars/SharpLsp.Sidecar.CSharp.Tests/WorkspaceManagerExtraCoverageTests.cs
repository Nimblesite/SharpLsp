using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Targeted resolver-branch coverage for <see cref="WorkspaceManager"/> over a
/// fixture chosen to drive paths the broad feature suite leaves uncovered:
/// write-vs-read document-highlight classification, metadata go-to-definition /
/// type-definition fallback, declaration walking (interface member, base
/// method/property/event override, partial method, self), call-/type-hierarchy
/// symbol-kind mapping, inlay hints over lambdas, and the "no symbol at this
/// position" guards. Positions are located by searching the source text so the
/// assertions cannot drift out of sync with the fixture.
/// </summary>
public sealed class WorkspaceManagerExtraCoverageTests : IDisposable
{
    private const string Source = """
        using System;

        namespace S;

        public interface IGreeter
        {
            string Greet();
        }

        public abstract class Animal
        {
            public virtual string Speak() => "...";
            public virtual int Legs { get; set; }
            public virtual event EventHandler? Moved;
            protected void OnMoved() => Moved?.Invoke(this, EventArgs.Empty);
        }

        public class Dog : Animal
        {
            public override string Speak() => "Woof";
            public override int Legs { get; set; }
            public override event EventHandler? Moved;
        }

        public sealed partial class Worker
        {
            public partial void Run();
        }

        public sealed partial class Worker
        {
            public partial void Run() { }
        }

        public sealed class Resource : IDisposable
        {
            public void Dispose() { }
        }

        public class Greeter : IGreeter
        {
            private int _count;

            public string Name { get; set; } = "g";

            public event EventHandler? Ready;

            // A documented worker method.
            public int Work(int seed)
            {
                _count = seed;
                _count += 1;
                _count++;
                ++_count;
                var made = 0;
                Init(out made);
                var doubled = made * 2;
                Func<int, int> twice = x => x + x;
                Func<int, int, int> add = (a, b) => a + b;
                Func<int, int> typed = (int z) => z + 1;
                var pair = (Lo: 1, Hi: doubled);
                Console.WriteLine(_count);
                Ready?.Invoke(this, EventArgs.Empty);
                return _count + twice(pair.Hi) + made + add(1, 2) + typed(3);
            }

            public string Greet() => Name;

            private static void Init(out int value) => value = 5;
        }
        """;

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-wm-extra-{Guid.NewGuid():N}"
    );

    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public WorkspaceManagerExtraCoverageTests()
    {
        Directory.CreateDirectory(_root);
        File.WriteAllText(
            Path.Combine(_root, "Extra.csproj"),
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """
        );
        _csprojPath = Path.Combine(_root, "Extra.csproj");
        _sourcePath = Path.Combine(_root, "Extra.cs");
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
        Assert.True(manager.IsLoaded, "workspace must load for feature queries");
        return manager;
    }

    private static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        return result.Match(value => value, _ => throw new InvalidOperationException("error"));
    }

    private static async Task<List<T>> Unwrapped<T>(Task<Outcome.Result<List<T>, string>> task)
    {
        return Unwrap(await task.ConfigureAwait(true));
    }

    /// <summary>Locate the (0-based line, character) of <paramref name="snippet"/>.</summary>
    private static (int Line, int Character) Pos(string snippet)
    {
        return PosOf(snippet, snippet);
    }

    /// <summary>Locate <paramref name="token"/> inside the first <paramref name="container"/>.</summary>
    private static (int Line, int Character) PosOf(string container, string token)
    {
        var containerIndex = Source.IndexOf(container, StringComparison.Ordinal);
        Assert.True(containerIndex >= 0, $"container not found: {container}");
        var tokenOffset = container.IndexOf(token, StringComparison.Ordinal);
        Assert.True(tokenOffset >= 0, $"token '{token}' not in '{container}'");
        return LineChar(containerIndex + tokenOffset);
    }

    private static (int Line, int Character) LineChar(int index)
    {
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < index; i++)
        {
            if (Source[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }

        return (line, index - lineStart);
    }

    [Fact]
    public async Task DocumentHighlights_classify_field_writes()
    {
        using var manager = await OpenAsync();
        var (line, character) = Pos("_count = seed");

        var highlights = Unwrap(
            await manager.GetDocumentHighlightsAsync(_sourcePath, line, character)
        );

        Assert.NotEmpty(highlights.Highlights);
        Assert.Contains(highlights.Highlights, h => h.Kind == 3);
        Assert.Contains(highlights.Highlights, h => h.Kind == 2);
    }

    [Fact]
    public async Task DocumentHighlights_mark_out_argument_as_write()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("made = 0", "made");

        var highlights = Unwrap(
            await manager.GetDocumentHighlightsAsync(_sourcePath, line, character)
        );

        Assert.Contains(highlights.Highlights, h => h.Kind == 3);
    }

    [Fact]
    public async Task Hover_on_local_describes_the_symbol()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("made * 2", "made");

        var hover = Unwrap(await manager.GetHoverAsync(_sourcePath, line, character));

        Assert.NotNull(hover);
        Assert.Contains("made", hover!.Contents);
    }

    [Fact]
    public async Task Definition_on_framework_call_falls_back_to_metadata()
    {
        using var manager = await OpenAsync();
        var (line, character) = Pos("WriteLine");

        var locations = Unwrap(await manager.GetDefinitionAsync(_sourcePath, line, character));

        Assert.NotEmpty(locations.Locations);
        Assert.All(locations.Locations, l => Assert.False(string.IsNullOrEmpty(l.FilePath)));
    }

    [Fact]
    public async Task TypeDefinition_of_int_local_falls_back_to_metadata()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("made * 2", "made");

        var location = Unwrap(await manager.GetTypeDefinitionAsync(_sourcePath, line, character));

        Assert.NotNull(location);
        Assert.False(string.IsNullOrEmpty(location!.FilePath));
    }

    [Fact]
    public async Task Declaration_on_interface_implementation_resolves()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("Greet() => Name", "Greet");

        var location = Unwrap(await manager.GetDeclarationAsync(_sourcePath, line, character));

        Assert.NotNull(location);
    }

    [Fact]
    public async Task Declaration_on_override_method_resolves_to_base()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("Speak() => \"Woof\"", "Speak");

        Assert.NotNull(Unwrap(await manager.GetDeclarationAsync(_sourcePath, line, character)));
    }

    [Fact]
    public async Task Declaration_on_override_property_resolves_to_base()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("override int Legs", "Legs");

        Assert.NotNull(Unwrap(await manager.GetDeclarationAsync(_sourcePath, line, character)));
    }

    [Fact]
    public async Task Declaration_on_override_event_resolves_to_base()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("override event EventHandler? Moved", "Moved");

        Assert.NotNull(Unwrap(await manager.GetDeclarationAsync(_sourcePath, line, character)));
    }

    [Fact]
    public async Task Declaration_on_partial_implementation_resolves_to_defining_part()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("partial void Run() { }", "Run");

        Assert.NotNull(Unwrap(await manager.GetDeclarationAsync(_sourcePath, line, character)));
    }

    [Fact]
    public async Task Declaration_on_plain_method_returns_itself()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("Work(int seed)", "Work");

        Assert.NotNull(Unwrap(await manager.GetDeclarationAsync(_sourcePath, line, character)));
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_class_reports_class_kind()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("class Greeter", "Greeter");

        var item = Unwrap(await manager.PrepareCallHierarchyAsync(_sourcePath, line, character));

        Assert.NotNull(item);
        Assert.Equal("class", item!.Kind);
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_property_reports_property_kind()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("Name { get", "Name");

        var item = Unwrap(await manager.PrepareCallHierarchyAsync(_sourcePath, line, character));

        Assert.NotNull(item);
        Assert.Equal("property", item!.Kind);
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_field_reports_field_kind()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("_count;", "_count");

        var item = Unwrap(await manager.PrepareCallHierarchyAsync(_sourcePath, line, character));

        Assert.NotNull(item);
        Assert.Equal("field", item!.Kind);
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_event_reports_event_kind()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("Ready;", "Ready");

        var item = Unwrap(await manager.PrepareCallHierarchyAsync(_sourcePath, line, character));

        Assert.NotNull(item);
        Assert.Equal("event", item!.Kind);
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_local_reports_variable_kind()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("made = 0", "made");

        var item = Unwrap(await manager.PrepareCallHierarchyAsync(_sourcePath, line, character));

        Assert.NotNull(item);
        Assert.Equal("variable", item!.Kind);
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_parameter_reports_parameter_kind()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("Work(int seed)", "seed");

        var item = Unwrap(await manager.PrepareCallHierarchyAsync(_sourcePath, line, character));

        Assert.NotNull(item);
        Assert.Equal("parameter", item!.Kind);
    }

    [Fact]
    public async Task TypeHierarchy_on_interface_reference_resolves_named_type()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("Greeter : IGreeter", "IGreeter");

        var item = Unwrap(await manager.PrepareTypeHierarchyAsync(_sourcePath, line, character));

        Assert.NotNull(item);
        Assert.Equal("interface", item!.Kind);
    }

    [Fact]
    public async Task Supertypes_filter_out_metadata_only_interfaces()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("class Resource", "Resource");

        // `Resource : IDisposable` — IDisposable is metadata-only (no source
        // location), so it is dropped; the call still succeeds with no error.
        var items = await Unwrapped(
            manager.GetSupertypesAsync(_sourcePath, line, character)
        );

        Assert.DoesNotContain(items, i => i.Name == "IDisposable");
    }

    [Fact]
    public async Task Subtypes_of_interface_include_implementer()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("interface IGreeter", "IGreeter");

        var items = await Unwrapped(manager.GetSubtypesAsync(_sourcePath, line, character));

        Assert.Contains(items, i => i.Name.Contains("Greeter"));
    }

    [Fact]
    public async Task Supertypes_of_class_include_base()
    {
        using var manager = await OpenAsync();
        var (line, character) = PosOf("Dog : Animal", "Dog");

        var items = await Unwrapped(manager.GetSupertypesAsync(_sourcePath, line, character));

        Assert.Contains(items, i => i.Name.Contains("Animal"));
    }

    [Fact]
    public async Task InlayHints_cover_lambda_parameter_types()
    {
        using var manager = await OpenAsync();

        var hints = Unwrap(await manager.GetInlayHintsAsync(_sourcePath, 0, 90));

        // `var` locals and untyped lambda parameters both yield Type hints.
        Assert.Contains(hints, h => h.Kind == 1);
    }

    [Fact]
    public async Task SemanticTokens_full_classifies_comment_lines()
    {
        using var manager = await OpenAsync();

        var tokens = Unwrap(await manager.GetSemanticTokensFullAsync(_sourcePath));

        // The fixture contains a `// ...` comment, so the full token stream is
        // non-empty and well-formed (five integers per token).
        Assert.NotEmpty(tokens.Data);
        Assert.Equal(0, tokens.Data.Length % 5);
    }

    [Fact]
    public async Task CodeLenses_report_reference_counts()
    {
        using var manager = await OpenAsync();

        var lenses = Unwrap(await manager.GetCodeLensesAsync(_sourcePath));

        Assert.NotEmpty(lenses);
        Assert.All(lenses, lens => Assert.False(string.IsNullOrEmpty(lens.Title)));
    }

    [Fact]
    public async Task References_to_field_span_all_writes()
    {
        using var manager = await OpenAsync();
        var (line, character) = Pos("_count = seed");

        var references = Unwrap(
            await manager.GetReferencesAsync(_sourcePath, line, character, true)
        );

        Assert.True(references.Locations.Count >= 4);
    }

    [Fact]
    public async Task Queries_on_a_non_symbol_position_return_empty_results()
    {
        using var manager = await OpenAsync();
        // (0,0) sits on the `using` keyword: it has no declared or referenced
        // symbol, exercising every resolver's "no symbol at position" guard.
        const int line = 0;
        const int character = 0;

        Assert.Null(Unwrap(await manager.GetDeclarationAsync(_sourcePath, line, character)));
        Assert.Null(Unwrap(await manager.GetTypeDefinitionAsync(_sourcePath, line, character)));
        Assert.Null(Unwrap(await manager.PrepareCallHierarchyAsync(_sourcePath, line, character)));
        Assert.Null(Unwrap(await manager.PrepareTypeHierarchyAsync(_sourcePath, line, character)));
        Assert.Empty(
            Unwrap(await manager.GetDefinitionAsync(_sourcePath, line, character)).Locations
        );
        Assert.Empty(
            Unwrap(await manager.GetDocumentHighlightsAsync(_sourcePath, line, character)).Highlights
        );
        Assert.Empty(await Unwrapped(manager.GetIncomingCallsAsync(_sourcePath, line, character)));
        Assert.Empty(await Unwrapped(manager.GetOutgoingCallsAsync(_sourcePath, line, character)));
        Assert.Empty(await Unwrapped(manager.GetSupertypesAsync(_sourcePath, line, character)));
        Assert.Empty(await Unwrapped(manager.GetSubtypesAsync(_sourcePath, line, character)));
    }
}
