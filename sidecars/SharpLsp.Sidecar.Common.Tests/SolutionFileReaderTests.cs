using SharpLsp.Sidecar.Common.Solutions;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers - tests own temp fixtures
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.Common.Tests;

public sealed class SolutionFileReaderTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-solution-reader-{Guid.NewGuid():N}"
    );

    public SolutionFileReaderTests()
    {
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    [Fact]
    public async Task Read_sln_returns_project_model()
    {
        WriteProject("src/App/App.csproj");
        var slnPath = Path.Combine(_root, "App.sln");
        await File.WriteAllTextAsync(
            slnPath,
            """
            Microsoft Visual Studio Solution File, Format Version 12.00
            Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\App\App.csproj", "{00000000-0000-0000-0000-000000000001}"
            EndProject
            Global
            EndGlobal
            """
        );

        var result = await SolutionFileReader.ReadAsync(slnPath);
        var model = AssertOk(result);

        Assert.Equal("sln", model.Format);
        var project = Assert.Single(model.Projects);
        Assert.Equal("App", project.DisplayName);
        Assert.EndsWith(
            Path.Combine("src", "App", "App.csproj"),
            project.Path,
            StringComparison.Ordinal
        );
        Assert.Equal("src/App/App.csproj", project.RelativePath);
    }

    [Fact]
    public async Task Read_flat_slnx_returns_project_model()
    {
        WriteProject("src/App/App.csproj");
        var slnxPath = WriteSlnx(
            """
            <Solution>
              <Project Path="src/App/App.csproj" />
            </Solution>
            """
        );

        var model = AssertOk(await SolutionFileReader.ReadAsync(slnxPath));

        Assert.Equal("slnx", model.Format);
        var project = Assert.Single(model.Projects);
        Assert.Equal("App", project.DisplayName);
        Assert.Equal("src/App/App.csproj", project.RelativePath);
        Assert.Equal(".csproj", project.ProjectType);
    }

    [Fact]
    public async Task Read_nested_folder_slnx_preserves_parent_relationships()
    {
        WriteProject("src/App/App.csproj");
        WriteProject("tests/App.Tests/App.Tests.fsproj");
        var slnxPath = WriteSlnx(
            """
            <Solution>
              <Folder Name="/src/">
                <Project Path="src/App/App.csproj" />
              </Folder>
              <Folder Name="/src/tests/">
                <Project Path="tests/App.Tests/App.Tests.fsproj" />
              </Folder>
            </Solution>
            """
        );

        var model = AssertOk(await SolutionFileReader.ReadAsync(slnxPath));

        Assert.Equal(2, model.Folders.Count);
        var childFolder = model.Folders.Single(folder => folder.Path == "/src/tests/");
        Assert.Equal("/src/", childFolder.ParentPath);
        Assert.Equal("src", childFolder.ParentName);

        var fsProject = model.Projects.Single(project =>
            project.RelativePath.EndsWith(".fsproj", StringComparison.OrdinalIgnoreCase)
        );
        Assert.Equal("tests", fsProject.ParentFolder);
        Assert.Equal("/src/tests/", fsProject.ParentFolderPath);
    }

    [Fact]
    public async Task Read_slnx_solution_items_do_not_create_projects()
    {
        WriteProject("src/App/App.csproj");
        await File.WriteAllTextAsync(Path.Combine(_root, "README.md"), "# App");
        var slnxPath = WriteSlnx(
            """
            <Solution>
              <Folder Name="/Solution Items/">
                <File Path="README.md" />
              </Folder>
              <Project Path="src/App/App.csproj" />
            </Solution>
            """
        );

        var model = AssertOk(await SolutionFileReader.ReadAsync(slnxPath));

        Assert.Single(model.Projects);
        var item = Assert.Single(model.Files);
        Assert.Equal("README.md", item.RelativePath);
        Assert.Equal("Solution Items", item.ParentFolder);
    }

    [Fact]
    public async Task Read_slnx_with_configurations_returns_projects()
    {
        WriteProject("src/App/App.csproj");
        var slnxPath = WriteSlnx(
            """
            <Solution>
              <Configurations>
                <Platform Name="Any CPU" />
              </Configurations>
              <Project Path="src/App/App.csproj" />
            </Solution>
            """
        );

        var model = AssertOk(await SolutionFileReader.ReadAsync(slnxPath));

        Assert.Single(model.Projects);
    }

    [Fact]
    public async Task Read_malformed_slnx_returns_structured_error()
    {
        var slnxPath = WriteSlnx("<Solution><Project Path=\"src/App/App.csproj\"></Solution>");

        var result = await SolutionFileReader.ReadAsync(slnxPath);

        Assert.True(result.IsError);
        Assert.Contains(
            "Failed to read solution",
            result.Match(_ => string.Empty, err => err),
            StringComparison.Ordinal
        );
    }

    private string WriteSlnx(string content)
    {
        var path = Path.Combine(_root, "App.slnx");
        File.WriteAllText(path, content);
        return path;
    }

    private void WriteProject(string relativePath)
    {
        var path = Path.Combine(_root, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(
            path,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """
        );
    }

    private static SolutionFileModel AssertOk(Outcome.Result<SolutionFileModel, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => string.Empty, err => err));
        return result.Match(value => value, err => throw new InvalidOperationException(err));
    }
}
