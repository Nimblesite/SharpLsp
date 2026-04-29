using MessagePack;

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed class SerializationTests
{
    [Fact]
    public void PositionRequest_roundtrip()
    {
        var original = new PositionRequest
        {
            FilePath = "/src/Program.cs",
            Line = 10,
            Character = 5,
        };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<PositionRequest>(bytes);

        Assert.Equal(original.FilePath, result.FilePath);
        Assert.Equal(original.Line, result.Line);
        Assert.Equal(original.Character, result.Character);
    }

    [Fact]
    public void DidChangeRequest_roundtrip()
    {
        var original = new DidChangeRequest { FilePath = "/src/Foo.cs", NewText = "class Foo { }" };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<DidChangeRequest>(bytes);

        Assert.Equal(original.FilePath, result.FilePath);
        Assert.Equal(original.NewText, result.NewText);
    }

    [Fact]
    public void CompletionItem_roundtrip_with_nullable_fields()
    {
        var original = new CompletionItem
        {
            Label = "ToString",
            Kind = "Method",
            Detail = "string Object.ToString()",
            InsertText = null,
        };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<CompletionItem>(bytes);

        Assert.Equal("ToString", result.Label);
        Assert.Equal("Method", result.Kind);
        Assert.Equal("string Object.ToString()", result.Detail);
        Assert.Null(result.InsertText);
    }

    [Fact]
    public void HoverResult_roundtrip_with_range()
    {
        var original = new HoverResult
        {
            Contents = "```csharp\nint x\n```",
            StartLine = 5,
            StartCharacter = 8,
            EndLine = 5,
            EndCharacter = 9,
        };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<HoverResult>(bytes);

        Assert.Equal(original.Contents, result.Contents);
        Assert.Equal(5, result.StartLine);
        Assert.Equal(9, result.EndCharacter);
    }

    [Fact]
    public void HoverResult_roundtrip_without_range()
    {
        var original = new HoverResult { Contents = "hover text" };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<HoverResult>(bytes);

        Assert.Equal("hover text", result.Contents);
        Assert.Null(result.StartLine);
        Assert.Null(result.EndLine);
    }

    [Fact]
    public void LocationResult_roundtrip()
    {
        var original = new LocationResult
        {
            FilePath = "/src/Foo.cs",
            Line = 20,
            Character = 4,
            EndLine = 20,
            EndCharacter = 7,
        };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<LocationResult>(bytes);

        Assert.Equal("/src/Foo.cs", result.FilePath);
        Assert.Equal(20, result.Line);
        Assert.Equal(7, result.EndCharacter);
    }

    [Fact]
    public void LocationListResult_roundtrip_with_multiple_locations()
    {
        var original = new LocationListResult
        {
            Locations =
            [
                new LocationResult
                {
                    FilePath = "/a.cs",
                    Line = 1,
                    Character = 0,
                    EndLine = 1,
                    EndCharacter = 5,
                },
                new LocationResult
                {
                    FilePath = "/b.cs",
                    Line = 10,
                    Character = 2,
                    EndLine = 10,
                    EndCharacter = 8,
                },
            ],
        };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<LocationListResult>(bytes);

        Assert.Equal(2, result.Locations.Count);
        Assert.Equal("/a.cs", result.Locations[0].FilePath);
        Assert.Equal("/b.cs", result.Locations[1].FilePath);
    }

    [Fact]
    public void LocationListResult_roundtrip_empty()
    {
        var original = new LocationListResult();
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<LocationListResult>(bytes);

        Assert.Empty(result.Locations);
    }

    [Fact]
    public void DiagnosticResult_roundtrip()
    {
        var original = new DiagnosticResult
        {
            FilePath = "/src/Bad.cs",
            StartLine = 3,
            StartCharacter = 0,
            EndLine = 3,
            EndCharacter = 10,
            Message = "CS0246: The type 'Foo' could not be found",
            Severity = "Error",
            Code = "CS0246",
        };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<DiagnosticResult>(bytes);

        Assert.Equal("CS0246", result.Code);
        Assert.Equal("Error", result.Severity);
        Assert.Equal(3, result.StartLine);
    }

    [Fact]
    public void SolutionDiagnosticsRequest_roundtrip()
    {
        var original = new SolutionDiagnosticsRequest { ProjectFilter = ["MyApp", "MyLib"] };
        var bytes = MessagePackSerializer.Serialize(original);
        var result = MessagePackSerializer.Deserialize<SolutionDiagnosticsRequest>(bytes);

        Assert.Equal(2, result.ProjectFilter.Length);
        Assert.Equal("MyApp", result.ProjectFilter[0]);
    }
}
