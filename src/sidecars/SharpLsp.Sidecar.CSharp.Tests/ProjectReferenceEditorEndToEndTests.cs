// End-to-end tests for `project/addProjectReference`, the edit behind the "Reference project
// P from Q.csproj and add 'using N;'" quick fix ([REFACTOR-IMPORT-REFERENCE]). Drives the real
// sidecar socket — FramedTransport → MessageRouter → CSharpSidecar handler →
// ProjectReferenceEditor → MSBuild's ProjectRootElement on real project files — and pins the
// relative include, the no-op contract for either separator spelling, placement beside the
// existing references, formatting preservation (comments, BOM, line endings) and the failure
// that names a missing project.
//
// The payload is positional (`object[]`) so the suite states the WIRE CONTRACT on its own:
// [Key(0)] FilePath (the project that gains the reference), [Key(1)] ReferencePath (the
// referenced project's absolute path).
using System.Text;
using MessagePack;
using Microsoft.Build.Construction;
using Microsoft.Build.Evaluation;
using SharpLsp.Sidecar.Common;

#pragma warning disable CA1515 // xunit test classes must be public
#pragma warning disable CA1307 // Assert.Contains(string, string) is an ordinal substring check
#pragma warning disable RS1035 // a test that legitimately writes project files on disk
#pragma warning disable IDE0058 // xunit Assert.* return values are intentionally unused
#pragma warning disable CA2007 // xunit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed class ProjectReferenceEditorEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private const string AddProjectReference = "project/addProjectReference";

    private static string Crlf(params string[] lines)
    {
        return string.Join("\r\n", lines) + "\r\n";
    }

    /// <summary>A plain SDK project with a comment, CRLF line endings and no references.</summary>
    private static string AppProject()
    {
        return Crlf(
            "<Project Sdk=\"Microsoft.NET.Sdk\">",
            "  <!-- The app. Its references are added by quick fixes. -->",
            "  <PropertyGroup>",
            "    <TargetFramework>net10.0</TargetFramework>",
            "  </PropertyGroup>",
            "</Project>"
        );
    }

    /// <summary>A solution root holding <c>App/App.csproj</c> and <c>Lib/Lib.csproj</c>.</summary>
    private async Task<(string App, string Lib)> CreateSolutionAsync(string app, bool bom = true)
    {
        var root = NativePaths.Join(fixture.TempDir, Guid.NewGuid().ToString("N"));
        var appPath = NativePaths.Join(root, "App", "App.csproj");
        var libPath = NativePaths.Join(root, "Lib", "Lib.csproj");
        await WriteAsync(appPath, app, bom);
        await WriteAsync(libPath, "<Project Sdk=\"Microsoft.NET.Sdk\" />\r\n", bom: false);
        return (appPath, libPath);
    }

    private static async Task WriteAsync(string path, string content, bool bom)
    {
        Directory.CreateDirectory(NativePaths.DirectoryOf(path));
        var encoding = new UTF8Encoding(bom);
        await File.WriteAllBytesAsync(
                path,
                [.. encoding.GetPreamble(), .. encoding.GetBytes(content)]
            )
            .ConfigureAwait(false);
    }

    private static byte[] Request(string project, string referenced)
    {
        return MessagePackSerializer.Serialize(new object[] { project, referenced });
    }

    private Task<PackageEditResult> AddAsync(string project, string referenced)
    {
        return fixture.SendAndDeserializeAsync<PackageEditResult>(
            AddProjectReference,
            Request(project, referenced)
        );
    }

    /// <summary>The project's ProjectReference includes, grouped by ItemGroup, via the real DOM.</summary>
    private static List<List<string>> ReferenceGroups(string path)
    {
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Open(path, collection, preserveFormatting: true);
        return
        [
            .. root
                .ItemGroups.Select(group =>
                    group
                        .Items.Where(item => item.ItemType == "ProjectReference")
                        .Select(item => item.Include)
                        .ToList()
                )
                .Where(group => group.Count > 0),
        ];
    }

    private static bool StartsWithBom(byte[] bytes)
    {
        return bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
    }

    /// <summary>[REFACTOR-IMPORT-REFERENCE] 1: a relative include, the rest of the file untouched.</summary>
    [Fact]
    public async Task Adds_a_relative_project_reference_and_keeps_the_rest_of_the_file()
    {
        var (app, lib) = await CreateSolutionAsync(AppProject());
        var include = NativePaths.RelativeTo(NativePaths.DirectoryOf(app), lib);

        var result = await AddAsync(app, lib);

        Assert.True(result.Modified);
        Assert.Equal($"Added a reference to {include}", result.Message);
        Assert.Equal(
            [
                [include],
            ],
            ReferenceGroups(app)
        );
        var bytes = await File.ReadAllBytesAsync(app);
        Assert.True(StartsWithBom(bytes), "the byte-order mark survives the edit");
        var text = Encoding.UTF8.GetString(bytes.AsSpan(3));
        Assert.DoesNotContain("\n", text.Replace("\r\n", "", StringComparison.Ordinal));
        Assert.Contains("<!-- The app. Its references are added by quick fixes. -->", text);
        Assert.Contains("<TargetFramework>net10.0</TargetFramework>", text);
        Assert.Contains($"<ProjectReference Include=\"{include}\" />", text);
    }

    /// <summary>[REFACTOR-IMPORT-REFERENCE] 1: a project that already references P changes nothing, either spelling.</summary>
    [Fact]
    public async Task A_project_already_referenced_in_either_separator_spelling_is_left_byte_for_byte()
    {
        var referenced = Crlf(
            "<Project Sdk=\"Microsoft.NET.Sdk\">",
            "  <ItemGroup>",
            "    <ProjectReference Include=\"..\\Lib\\Lib.csproj\" />",
            "  </ItemGroup>",
            "</Project>"
        );
        var (app, lib) = await CreateSolutionAsync(referenced);
        var before = await File.ReadAllBytesAsync(app);

        var first = await AddAsync(app, lib);
        var second = await AddAsync(app, lib);

        Assert.False(first.Modified);
        Assert.False(second.Modified);
        Assert.Equal("App.csproj already references Lib.csproj", first.Message);
        Assert.Equal(first.Message, second.Message);
        Assert.Equal(before, await File.ReadAllBytesAsync(app));
    }

    /// <summary>
    /// [REFACTOR-IMPORT-REFERENCE] 1: the new reference joins the project's other references, and
    /// MSBuild keeps a sorted group sorted, as <c>dotnet add reference</c> does.
    /// </summary>
    [Fact]
    public async Task A_new_reference_joins_the_item_group_that_holds_the_other_references()
    {
        var withOther = Crlf(
            "<Project Sdk=\"Microsoft.NET.Sdk\">",
            "  <ItemGroup>",
            "    <PackageReference Include=\"Serilog\" Version=\"4.4.0\" />",
            "  </ItemGroup>",
            "  <ItemGroup>",
            "    <ProjectReference Include=\"../Other/Other.csproj\" />",
            "  </ItemGroup>",
            "</Project>"
        );
        var (app, lib) = await CreateSolutionAsync(withOther);
        var include = NativePaths.RelativeTo(NativePaths.DirectoryOf(app), lib);

        var result = await AddAsync(app, lib);

        Assert.True(result.Modified);
        Assert.Equal(
            [
                [include, "../Other/Other.csproj"],
            ],
            ReferenceGroups(app)
        );
        var text = await File.ReadAllTextAsync(app);
        Assert.Contains("<PackageReference Include=\"Serilog\" Version=\"4.4.0\" />", text);
        Assert.Equal(2, text.Split("<ItemGroup>").Length - 1);
    }

    /// <summary>[REFACTOR-NEVER-SILENT]: a missing project is a failure that names it, and nothing is written.</summary>
    [Fact]
    public async Task A_reference_to_a_project_file_that_does_not_exist_fails_naming_it()
    {
        var (app, lib) = await CreateSolutionAsync(AppProject());
        var missing = NativePaths.Join(NativePaths.DirectoryOf(lib), "Gone.csproj");
        var before = await File.ReadAllBytesAsync(app);

        var envelope = await fixture.SendAsync(AddProjectReference, Request(app, missing));

        Assert.NotNull(envelope.Error);
        Assert.Contains(missing, envelope.Error);
        Assert.Contains("does not exist", envelope.Error);
        Assert.Equal(before, await File.ReadAllBytesAsync(app));
    }
}
