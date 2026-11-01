using SharpLsp.Sidecar.Common.Messages;
using static SharpLsp.Sidecar.CSharp.Tests.TextEditing;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0058 // Assert.Single's returned element is not always needed

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// The C# quick fixes that bring an unresolved name into scope, driven against a real restored
/// solution ([REFACTOR-IMPORT], [REFACTOR-IMPORT-CSHARP], [REFACTOR-IMPORT-REFERENCE]). Every
/// row is offered under the exact title the spec gives it, which states the edit and what it
/// brings into scope, and applying it produces exactly that edit. A row in reach clears the
/// error; a reference row carries the exact reference the host adds before the import.
/// </summary>
public sealed class ImportQuickFixTests(ImportSolutionFixture fixture)
    : IClassFixture<ImportSolutionFixture>
{
    private const string BuilderProbe = """
        namespace App;

        public class Probe
        {
            public object Make() => new StringBuilder();
        }
        """;

    private const string ListProbe = """
        namespace App;

        public class Probe
        {
            public object Make() => new List<int>();
        }
        """;

    private const string SelectProbe = """
        namespace App;

        public class Probe
        {
            public object Project(int[] values) => values.Select(value => value);
        }
        """;

    private const string WriteProbe = """
        namespace App;

        public class Probe
        {
            public void Write() => WriteLine("x");
        }
        """;

    private const string SqrtProbe = """
        namespace App;

        public class Probe
        {
            public double Root() => Sqrt(2.0);
        }
        """;

    private const string FolderProbe = """
        namespace App;

        public class Probe
        {
            public object Folder() => SpecialFolder.Desktop;
        }
        """;

    private const string PolygonProbe = """
        namespace App;

        public class Probe
        {
            public object Shape() => new Polygon();
        }
        """;

    private const string JsonProbe = """
        namespace App;

        public class Probe
        {
            public object Json() => new JObject();
        }
        """;

    private const string FakerProbe = """
        namespace App;

        public class Probe
        {
            public object Fake() => new Faker();
        }
        """;

    private const string PluginProbe = """
        namespace App;

        public class Probe
        {
            public object Host() => new PluginHost();
        }
        """;

    private const string ImportBuilder =
        "Add 'using System.Text;' — imports every type in namespace System.Text";
    private const string AliasBuilder =
        "Add 'using StringBuilder = System.Text.StringBuilder;' — imports only the type System.Text.StringBuilder";
    private const string QualifyBuilder =
        "Change 'StringBuilder' to 'System.Text.StringBuilder' — qualifies this one use; no using added";

    private static string StaticRow(string type)
    {
        return $"Add 'using static {type};' — imports the static members and nested types of {type}";
    }

    /// <summary>[REFACTOR-IMPORT]: the namespace, only the type, or only this use — each exact, each clearing CS0246.</summary>
    [Fact]
    public async Task An_unresolved_type_offers_its_namespace_the_type_alone_and_its_full_name_under_exact_titles()
    {
        var fixes = await QuickFixesAtAsync(BuilderProbe, "StringBuilder()");
        foreach (var title in new[] { ImportBuilder, AliasBuilder, QualifyBuilder })
        {
            var fix = Assert.Single(fixes, fix => fix.Title == title);
            Assert.Null(fix.Reference);
        }
        // Roslyn's own terse titles never reach the user, and nothing in reach needs a reference.
        Assert.DoesNotContain(fixes, fix => fix.Title == "using System.Text;");
        Assert.DoesNotContain(fixes, fix => fix.Title == "System.Text.StringBuilder");
        Assert.DoesNotContain(fixes, fix => fix.Reference is not null);

        var imported = await ApplyAsync(BuilderProbe, "StringBuilder()", ImportBuilder);
        Assert.Equal("using System.Text;\n\n" + BuilderProbe, imported);
        Assert.Empty(await ErrorsAsync(imported, "CS0246"));

        var aliased = await ApplyAsync(BuilderProbe, "StringBuilder()", AliasBuilder);
        Assert.Equal(
            "using StringBuilder = System.Text.StringBuilder;\n\n" + BuilderProbe,
            aliased
        );
        Assert.Empty(await ErrorsAsync(aliased, "CS0246"));

        var qualified = await ApplyAsync(BuilderProbe, "StringBuilder()", QualifyBuilder);
        Assert.Equal(
            BuilderProbe.Replace("new StringBuilder()", "new System.Text.StringBuilder()"),
            qualified
        );
        Assert.Empty(await ErrorsAsync(qualified, "CS0246"));
    }

    /// <summary>[REFACTOR-IMPORT-CSHARP]: a generic type has no alias row, and its full name keeps its arguments.</summary>
    [Fact]
    public async Task A_generic_type_is_imported_or_qualified_with_its_type_arguments_and_never_aliased()
    {
        const string import =
            "Add 'using System.Collections.Generic;' — imports every type in namespace System.Collections.Generic";
        const string qualify =
            "Change 'List<int>' to 'System.Collections.Generic.List<int>' — qualifies this one use; no using added";
        var fixes = await QuickFixesAtAsync(ListProbe, "List<int>()");
        Assert.Single(fixes, fix => fix.Title == import);
        Assert.Single(fixes, fix => fix.Title == qualify);
        Assert.DoesNotContain(
            fixes,
            fix => fix.Title.StartsWith("Add 'using List", StringComparison.Ordinal)
        );

        var imported = await ApplyAsync(ListProbe, "List<int>()", import);
        Assert.Equal("using System.Collections.Generic;\n\n" + ListProbe, imported);
        Assert.Empty(await ErrorsAsync(imported, "CS0246"));

        var qualified = await ApplyAsync(ListProbe, "List<int>()", qualify);
        Assert.Contains("new System.Collections.Generic.List<int>()", qualified);
        Assert.DoesNotContain("using", qualified);
        Assert.Empty(await ErrorsAsync(qualified, "CS0246"));
    }

    /// <summary>[REFACTOR-IMPORT-CSHARP]: an extension method's namespace is imported under the same exact title.</summary>
    [Fact]
    public async Task An_extension_method_receiver_offers_the_namespace_that_declares_the_extension()
    {
        const string import =
            "Add 'using System.Linq;' — imports every type in namespace System.Linq";
        var fixes = await QuickFixesAtAsync(SelectProbe, "Select(");
        Assert.Single(fixes, fix => fix.Title == import);
        Assert.DoesNotContain(fixes, fix => fix.Title == "using System.Linq;");
        Assert.DoesNotContain(
            fixes,
            fix => fix.Title.StartsWith("Add 'using Select", StringComparison.Ordinal)
        );

        var imported = await ApplyAsync(SelectProbe, "Select(", import);
        Assert.Equal("using System.Linq;\n\n" + SelectProbe, imported);
        Assert.Empty(await ErrorsAsync(imported, "CS1061"));
    }

    /// <summary>
    /// [REFACTOR-IMPORT-CSHARP]: `using static` for each static class whose static member the call
    /// would bind to, by full name. `Trace.WriteLine` is not one: `Trace` is not a static class,
    /// and Roslyn's declaration index holds only static classes' members.
    /// </summary>
    [Fact]
    public async Task An_unresolved_call_offers_using_static_for_each_static_class_whose_member_it_would_bind_to()
    {
        var fixes = await QuickFixesAtAsync(WriteProbe, "WriteLine(");
        Assert.Equal(
            [StaticRow("System.Console"), StaticRow("System.Diagnostics.Debug")],
            StaticTitles(fixes)
        );
        Assert.DoesNotContain(fixes, fix => fix.Reference is not null);

        var console = await ApplyAsync(WriteProbe, "WriteLine(", StaticRow("System.Console"));
        Assert.Equal("using static System.Console;\n\n" + WriteProbe, console);
        Assert.Empty(await ErrorsAsync(console, "CS0103"));

        var debug = await ApplyAsync(
            WriteProbe,
            "WriteLine(",
            StaticRow("System.Diagnostics.Debug")
        );
        Assert.Equal("using static System.Diagnostics.Debug;\n\n" + WriteProbe, debug);
        Assert.Empty(await ErrorsAsync(debug, "CS0103"));
    }

    /// <summary>[REFACTOR-IMPORT-CSHARP]: a call that binds to exactly one static class gets exactly that row.</summary>
    [Fact]
    public async Task An_unresolved_math_call_offers_using_static_on_math_alone()
    {
        var fixes = await QuickFixesAtAsync(SqrtProbe, "Sqrt(");
        Assert.Equal([StaticRow("System.Math")], StaticTitles(fixes));

        var imported = await ApplyAsync(SqrtProbe, "Sqrt(", StaticRow("System.Math"));
        Assert.Equal("using static System.Math;\n\n" + SqrtProbe, imported);
        Assert.Empty(await ErrorsAsync(imported, "CS0103"));
    }

    private static List<string> StaticTitles(List<CodeActionItem> fixes)
    {
        return
        [
            .. fixes
                .Where(fix => fix.Title.StartsWith("Add 'using static ", StringComparison.Ordinal))
                .Select(fix => fix.Title),
        ];
    }

    /// <summary>[REFACTOR-IMPORT-CSHARP]: a nested type comes into scope through `using static` on its container.</summary>
    [Fact]
    public async Task An_unresolved_nested_type_offers_using_static_on_the_type_that_contains_it()
    {
        var fixes = await QuickFixesAtAsync(FolderProbe, "SpecialFolder.");
        Assert.Single(fixes, fix => fix.Title == StaticRow("System.Environment"));
        Assert.DoesNotContain(fixes, fix => fix.Reference is not null);

        var opened = await ApplyAsync(
            FolderProbe,
            "SpecialFolder.",
            StaticRow("System.Environment")
        );
        Assert.Equal("using static System.Environment;\n\n" + FolderProbe, opened);
        Assert.Empty(await ErrorsAsync(opened, "CS0103"));
    }

    /// <summary>[REFACTOR-IMPORT-REFERENCE] 1: a type another project of the solution declares.</summary>
    [Fact]
    public async Task A_type_another_project_declares_offers_the_project_reference_and_the_using_together()
    {
        const string title =
            "Reference project Lib from App.csproj and add 'using Shapes.Geometry;' — Lib declares Shapes.Geometry.Polygon";
        var fixes = await QuickFixesAtAsync(PolygonProbe, "Polygon()");
        var fix = Assert.Single(fixes, fix => fix.Title == title);
        AssertReference(fix.Reference, ReferenceImport.ProjectKind, fixture.LibProject, "");
        Assert.Single(fixes, fix => fix.Reference is not null);

        var imported = await ApplyAsync(PolygonProbe, "Polygon()", title);
        Assert.Equal("using Shapes.Geometry;\n\n" + PolygonProbe, imported);
    }

    /// <summary>[REFACTOR-IMPORT-REFERENCE] 2: a package another project uses, at that project's version.</summary>
    [Fact]
    public async Task A_type_from_a_package_another_project_uses_offers_that_package_at_the_same_version()
    {
        var title =
            $"Add package Newtonsoft.Json {ImportSolutionFixture.NewtonsoftVersion} to App.csproj (as in Tool.csproj) and add 'using Newtonsoft.Json.Linq;'";
        var fixes = await QuickFixesAtAsync(JsonProbe, "JObject()");
        var fix = Assert.Single(fixes, fix => fix.Title == title);
        AssertReference(
            fix.Reference,
            ReferenceImport.PackageKind,
            "Newtonsoft.Json",
            ImportSolutionFixture.NewtonsoftVersion
        );
        // The solution already uses the package, so nuget.org is never offered for it.
        Assert.DoesNotContain(
            fixes,
            fix => fix.Title.StartsWith("Install package", StringComparison.Ordinal)
        );

        var imported = await ApplyAsync(JsonProbe, "JObject()", title);
        Assert.Equal("using Newtonsoft.Json.Linq;\n\n" + JsonProbe, imported);
    }

    /// <summary>[REFACTOR-IMPORT-REFERENCE] 3: a well-known package no project uses yet.</summary>
    [Fact]
    public async Task A_type_a_well_known_package_ships_offers_to_install_its_latest_stable_version()
    {
        const string title =
            "Install package Bogus (latest stable from nuget.org) in App.csproj and add 'using Bogus;'";
        var fixes = await QuickFixesAtAsync(FakerProbe, "Faker()");
        var fix = Assert.Single(fixes, fix => fix.Title == title);
        AssertReference(fix.Reference, ReferenceImport.PackageKind, "Bogus", "");

        var imported = await ApplyAsync(FakerProbe, "Faker()", title);
        Assert.Equal("using Bogus;\n\n" + FakerProbe, imported);
    }

    /// <summary>[REFACTOR-IMPORT-REFERENCE] 1: a project that references this one is never offered — that is a cycle.</summary>
    [Fact]
    public async Task A_type_only_a_dependent_project_declares_offers_no_reference_that_would_make_a_cycle()
    {
        var fixes = await QuickFixesAtAsync(PluginProbe, "PluginHost()");
        Assert.DoesNotContain(fixes, fix => fix.Reference is not null);
        Assert.DoesNotContain(
            fixes,
            fix => fix.Title.StartsWith("Reference project", StringComparison.Ordinal)
        );
        Assert.DoesNotContain(
            fixes,
            fix => fix.Title.Contains("using Plugins;", StringComparison.Ordinal)
        );
        Assert.NotEmpty(await ErrorsAsync(PluginProbe, "CS0246"));
    }

    private void AssertReference(
        ReferenceImport? reference,
        string kind,
        string target,
        string version
    )
    {
        Assert.NotNull(reference);
        Assert.Equal(kind, reference.Kind);
        Assert.Equal(fixture.AppProject, reference.ProjectPath);
        Assert.Equal(target, reference.Reference);
        Assert.Equal(version, reference.Version);
    }

    /// <summary>The quick fixes at the start of <paramref name="token"/> once the probe holds <paramref name="source"/>.</summary>
    private async Task<List<CodeActionItem>> QuickFixesAtAsync(string source, string token)
    {
        Unwrap(await fixture.Manager.UpdateDocumentTextAsync(fixture.ProbeFile, source));
        var (line, character) = Locate(source, token);
        var actions = Unwrap(
            await fixture.Manager.GetCodeActionsAsync(
                fixture.ProbeFile,
                line,
                character,
                line,
                character
            )
        );
        return [.. actions.Where(action => action.Kind == "quickfix")];
    }

    /// <summary>Offer the fixes afresh, resolve the one titled <paramref name="title"/>, and apply it.</summary>
    private async Task<string> ApplyAsync(string source, string token, string title)
    {
        var fix = Assert.Single(await QuickFixesAtAsync(source, token), fix => fix.Title == title);
        var edit = Unwrap(await fixture.Manager.ResolveCodeActionAsync(fix.Id));
        var change = Assert.Single(edit.DocumentChanges);
        Assert.Equal(fixture.ProbeFile, change.FilePath);
        return ApplyEdits(source, change.Edits).ReplaceLineEndings("\n");
    }

    /// <summary>The <paramref name="code"/> diagnostics once the probe holds <paramref name="text"/>.</summary>
    private async Task<List<DiagnosticResult>> ErrorsAsync(string text, string code)
    {
        Unwrap(await fixture.Manager.UpdateDocumentTextAsync(fixture.ProbeFile, text));
        var diagnostics = Unwrap(await fixture.Manager.GetDiagnosticsAsync(fixture.ProbeFile));
        return [.. diagnostics.Where(diagnostic => diagnostic.Code == code)];
    }

    private static (int Line, int Character) Locate(string source, string token)
    {
        var offset = source.IndexOf(token, StringComparison.Ordinal);
        Assert.True(offset >= 0, $"token not found: {token}");
        var before = source[..offset];
        var line = before.Count(c => c == '\n');
        return (line, offset - (before.LastIndexOf('\n') + 1));
    }

    private static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }
}
