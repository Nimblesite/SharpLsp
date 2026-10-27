using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Messages;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Tests;

#pragma warning disable CA1515 // Public xUnit fixture type

/// <summary>
/// The one real project shared by every <see cref="SolutionDocumentsTests"/> case,
/// restored once by the first workspace open and reused by the rest. Sharing it
/// removes a fresh restore per test method while every assertion still opens its own
/// <see cref="WorkspaceManager"/>.
/// </summary>
public sealed class SolutionDocumentsFixture : IDisposable
{
    private readonly ProjectlessWorkspaceFixture _files = new("docs");

    public SolutionDocumentsFixture()
    {
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
              <ItemGroup>
                <Compile Include="..\Shared\Linked.cs" />
                <AdditionalFiles Include="Components\Page.razor" />
              </ItemGroup>
            </Project>
            """;

        CsprojPath = _files.Write(NativePaths.Join("Proj", "Proj.csproj"), csproj);
        _ = _files.Write(
            NativePaths.Join("Proj", "Alpha.cs"),
            "namespace Proj;\n\npublic class Alpha { }\n"
        );
        _ = _files.Write(
            NativePaths.Join("Proj", "Beta.cs"),
            "namespace Proj;\n\npublic class Beta { }\n"
        );
        _ = _files.Write(
            NativePaths.Join("Shared", "Linked.cs"),
            "namespace Shared;\n\npublic class Linked { }\n"
        );
        _ = _files.Write(NativePaths.Join("Proj", "Components", "Page.razor"), "<h1>Page</h1>");
        // An explicitly compiled file under obj — exactly where Razor's .g.cs and
        // the SDK's generated files land. It is build output, never user source.
        _ = _files.Write(
            NativePaths.Join("Proj", "obj", "Generated", "Widget.g.cs"),
            "namespace Proj.Generated;\n\npublic class Widget { }\n"
        );
    }

    /// <summary>The shared project's path, restored by the first test that opens it.</summary>
    public string CsprojPath { get; }

    public void Dispose()
    {
        _files.Dispose();
    }
}

/// <summary>
/// <c>workspace/diagnostics/documents</c> enumeration for the C# sidecar
/// ([DIAG-ARCHITECTURE-PULL-REFRESH]): every user source and Razor document of
/// the loaded solution with its owning project's metadata — no eager
/// compilation, no diagnostic caches, and no generated build output.
/// </summary>
public sealed class SolutionDocumentsTests : IClassFixture<SolutionDocumentsFixture>
{
    private readonly SolutionDocumentsFixture _files;

    public SolutionDocumentsTests(SolutionDocumentsFixture files)
    {
        _files = files;
    }

    [Fact]
    public async Task Every_user_source_document_is_listed_with_owner_metadata()
    {
        using var manager = await OpenAsync();

        var alpha = Single(await DocumentsAsync(manager), "Alpha.cs");

        Assert.Equal("Proj", alpha.ProjectName);
        Assert.Equal(_files.CsprojPath, alpha.ProjectPath);
        _ = Single(await DocumentsAsync(manager), "Beta.cs");
    }

    [Fact]
    public async Task A_linked_source_file_outside_the_project_directory_is_kept()
    {
        using var manager = await OpenAsync();

        var linked = Single(await DocumentsAsync(manager), "Linked.cs");

        Assert.Equal("Proj", linked.ProjectName);
        Assert.Equal(_files.CsprojPath, linked.ProjectPath);
    }

    [Fact]
    public async Task A_razor_document_is_listed_like_a_source_document()
    {
        using var manager = await OpenAsync();

        var razor = Single(await DocumentsAsync(manager), "Page.razor");

        Assert.Equal("Proj", razor.ProjectName);
        Assert.Equal(_files.CsprojPath, razor.ProjectPath);
    }

    [Fact]
    public async Task Generated_build_output_is_not_reported_as_user_source()
    {
        using var manager = await OpenAsync();

        var documents = await DocumentsAsync(manager);

        Assert.DoesNotContain(
            documents,
            document => NativePaths.SameName(document.FilePath, "Widget.g.cs")
        );
        Assert.DoesNotContain(
            documents,
            document => NativePaths.HasDirectory(document.FilePath, "obj")
        );
    }

    [Fact]
    public async Task Each_document_is_reported_once()
    {
        using var manager = await OpenAsync();

        var documents = await DocumentsAsync(manager);
        var paths = documents.Select(document => document.FilePath).ToList();

        Assert.Equal(paths.Count, paths.Distinct(NativePaths.Comparer).Count());
    }

    private async Task<WorkspaceManager> OpenAsync()
    {
        var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture
            .OpenAsync(manager, _files.CsprojPath)
            .ConfigureAwait(false);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded, "workspace must be loaded for enumeration");
        return manager;
    }

    private static async Task<List<DiagnosticDocument>> DocumentsAsync(WorkspaceManager manager)
    {
        var result = await manager.GetDocumentsAsync().ConfigureAwait(false);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }

    private static DiagnosticDocument Single(List<DiagnosticDocument> documents, string fileName)
    {
        var matches = documents
            .Where(document =>
                NativePaths.Comparer.Equals(NativePaths.NameOf(document.FilePath), fileName)
            )
            .ToList();
        Assert.True(
            matches.Count == 1,
            $"expected exactly one {fileName}, got {matches.Count}: {string.Join(", ", matches.Select(d => d.FilePath))}"
        );
        return matches[0];
    }
}
