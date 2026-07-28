using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515
#pragma warning disable RS1035
#pragma warning disable IDE0058

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed class WorkspaceManagerSingleFileTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-sf-tests-{Guid.NewGuid():N}"
    );

    public WorkspaceManagerSingleFileTests()
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
    public async Task OpenAsync_without_project_loads_single_file_mode()
    {
        var sourcePath = Path.Combine(_root, "Program.cs");
        await File.WriteAllTextAsync(sourcePath, "public class C { }");

        using var manager = new WorkspaceManager();

        // Pass a directory that does NOT contain a csproj.
        // The WorkspaceManager should fallback to SingleFileMode.
#pragma warning disable CS0618
        var result = await manager.OpenAsync(_root);
#pragma warning restore CS0618

        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        Assert.True(manager.IsLoaded);

        // Verify the document was loaded successfully by requesting diagnostics
        var diags = await manager.GetDiagnosticsAsync(sourcePath);
        Assert.False(diags.IsError);
    }
}
