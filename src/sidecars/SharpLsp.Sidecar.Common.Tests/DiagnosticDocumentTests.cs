using MessagePack;
using SharpLsp.Sidecar.Common.Messages;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Wire contract for <see cref="DiagnosticDocument"/> — the shared
/// <c>workspace/diagnostics/documents</c> response item both sidecars emit
/// ([DIAG-LSP-PULL]). The positional MessagePack keys are the Rust host's
/// contract: a key reorder must break a test, not the host.
/// </summary>
public sealed class DiagnosticDocumentTests
{
    [Fact]
    public void Round_trips_every_field_through_messagepack()
    {
        var document = new DiagnosticDocument
        {
            FilePath = @"C:\src\App\Service.cs",
            ProjectName = "App",
            ProjectPath = @"C:\src\App\App.csproj",
        };

        var bytes = MessagePackSerializer.Serialize(document);
        var decoded = MessagePackSerializer.Deserialize<DiagnosticDocument>(bytes);

        Assert.Equal(document.FilePath, decoded.FilePath);
        Assert.Equal(document.ProjectName, decoded.ProjectName);
        Assert.Equal(document.ProjectPath, decoded.ProjectPath);
    }

    [Fact]
    public void Wire_layout_is_filepath_then_projectname_then_projectpath()
    {
        var bytes = MessagePackSerializer.Serialize(
            new DiagnosticDocument
            {
                FilePath = "a.cs",
                ProjectName = "Proj",
                ProjectPath = "Proj.csproj",
            }
        );

        var fields = MessagePackSerializer.Deserialize<string[]>(bytes);

        Assert.Equal(3, fields.Length);
        Assert.Equal("a.cs", fields[0]);
        Assert.Equal("Proj", fields[1]);
        Assert.Equal("Proj.csproj", fields[2]);
    }
}
