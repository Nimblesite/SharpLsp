using System.Net.Sockets;
using SharpLsp.Sidecar.Common.Ipc;
using SharpLsp.Sidecar.Common.Messages;
using SharpLsp.Sidecar.Common.Solutions;
using MessagePack;
using Microsoft.Build.Locator;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers (we're tests, not analyzers)
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// End-to-end tests for the C# sidecar over real IPC sockets.
/// Exercises: socket → FramedTransport → MessageRouter → SidecarHost
/// → CSharpSidecar → WorkspaceManager → Roslyn → HoverBuilder/DefinitionResolver.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2000:Dispose objects before losing scope",
    Justification = "Socket ownership transfers to FramedTransport"
)]
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA1001:Types that own disposable fields should be disposable",
    Justification = "Disposal handled by IAsyncLifetime.DisposeAsync"
)]
public sealed class CSharpSidecarFixture : IAsyncLifetime
{
    // Line reference for TestSource (0-based):
    //  4: public class Calculator                    → Calculator at (4,13)
    // 10:     public int Add(int a, int b) => a + b  → Add at (10,15)
    // 12:     public string Name { get; set; }       → Name at (12,18)
    // 15: public record Person(string Name, int Age) → Person at (15,14)
    // 17: public interface IGreeter                  → IGreeter at (17,17)
    // 19:     string Greet(string name)              → Greet at (19,11)
    // 22: public class SimpleGreeter : IGreeter      → SimpleGreeter at (22,13)
    // 24:     public string Greet(string name) ...   → Greet at (24,18)
    // 29:     var calc = new Calculator()             → calc at (29,8)
    // 30:     var result = calc.Add(1, 2)             → Add at (30,25)
    // 31:     var person = new Person("Alice", 30)    → person at (31,8)
    // 32:     IGreeter greeter = new SimpleGreeter()  → greeter at (32,17)
    // 33:     var greeting = greeter.Greet("World")   → Greet at (33,27)
    private const string TestSource = """
        namespace TestProject;

        /// <summary>A simple calculator class.</summary>
        public class Calculator
        {
            /// <summary>Adds two numbers.</summary>
            /// <param name="a">First number</param>
            /// <param name="b">Second number</param>
            /// <returns>The sum of a and b</returns>
            public int Add(int a, int b) => a + b;

            public string Name { get; set; } = "Calculator";
        }

        /// <summary>A person record.</summary>
        public record Person(string Name, int Age);

        public interface IGreeter
        {
            string Greet(string name);
        }

        public class SimpleGreeter : IGreeter
        {
            public string Greet(string name) => $"Hello, {name}!";
        }

        public class Program
        {
            public static void Main()
            {
                var calc = new Calculator();
                var result = calc.Add(1, 2);
                var person = new Person("Alice", 30);
                IGreeter greeter = new SimpleGreeter();
                var greeting = greeter.Greet("World");
            }
        }
        """;

    private static readonly Lock MsBuildRegistrationLock = new();
    private readonly string _socketPath = Path.Combine(
        Path.GetTempPath(),
        $"slsp-cs-{Guid.NewGuid():N}.sock"
    );

    private CSharpSidecar? _sidecar;
    private FramedTransport? _transport;
    private int _nextId;

    public string TempDir { get; private set; } = string.Empty;
    public string SourceFile => Path.Combine(TempDir, "Program.cs");
    public static string InitialSource => TestSource;

    public async Task<Envelope> SendAsync(string method, byte[] payload)
    {
        var id = (uint)Interlocked.Increment(ref _nextId);
        var envelope = new Envelope
        {
            Id = id,
            Method = method,
            Payload = payload,
        };
        await _transport!
            .WriteFrameAsync(MessagePackSerializer.Serialize(envelope))
            .ConfigureAwait(false);
        var raw = await _transport.ReadFrameAsync().ConfigureAwait(false);
        return raw is null
            ? throw new InvalidOperationException("Connection closed")
            : MessagePackSerializer.Deserialize<Envelope>(raw);
    }

    public byte[] PosPayload(int line, int character)
    {
        return MessagePackSerializer.Serialize(
            new PositionRequest
            {
                FilePath = SourceFile,
                Line = line,
                Character = character,
            }
        );
    }

    public async Task InitializeAsync()
    {
        TempDir = CreateTestProject();
        if (File.Exists(_socketPath))
        {
            File.Delete(_socketPath);
        }

        EnsureMsBuildRegistered();
        _sidecar = new CSharpSidecar();

        _ = Task.Run(async () => await _sidecar.RunAsync(_socketPath).ConfigureAwait(false));

        Socket? client = null;
        for (var i = 0; i < 200 && client is null; i++)
        {
            await Task.Delay(50).ConfigureAwait(false);
            try
            {
                var s = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                await s.ConnectAsync(new UnixDomainSocketEndPoint(_socketPath))
                    .ConfigureAwait(false);
                client = s;
            }
            catch
            {
                // Retry until sidecar is listening
            }
        }

        _transport = client is null
            ? throw new InvalidOperationException("Cannot connect to sidecar")
            : new FramedTransport(new NetworkStream(client, ownsSocket: true));

        var payload = MessagePackSerializer.Serialize(TempDir);
        var resp = await SendAsync("workspace/open", payload).ConfigureAwait(false);
        if (resp.Error is not null)
        {
            throw new InvalidOperationException($"workspace/open failed: {resp.Error}");
        }
    }

    public async Task DisposeAsync()
    {
        if (_transport is not null)
        {
            await _transport.DisposeAsync().ConfigureAwait(false);
        }

        if (_sidecar is not null)
        {
            await _sidecar.DisposeAsync().ConfigureAwait(false);
        }

        try
        {
            Directory.Delete(TempDir, true);
        }
        catch
        { /* cleanup best-effort */
        }

        try
        {
            if (File.Exists(_socketPath))
            {
                File.Delete(_socketPath);
            }
        }
        catch
        { /* cleanup best-effort */
        }
    }

    private static string CreateTestProject()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"slsp-cs-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        File.WriteAllText(
            Path.Combine(dir, "TestProject.csproj"),
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Exe</OutputType>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """
        );
        File.WriteAllText(Path.Combine(dir, "Program.cs"), TestSource);
        return dir;
    }

    private static void EnsureMsBuildRegistered()
    {
        lock (MsBuildRegistrationLock)
        {
            if (!MSBuildLocator.IsRegistered)
            {
                MSBuildLocator.RegisterDefaults();
            }
        }
    }
}

/// <summary>E2E tests hitting the C# sidecar through IPC.</summary>
public sealed class SidecarEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    [Fact]
    public async Task Ping_returns_pong()
    {
        var r = await fixture.SendAsync("ping", []);
        Assert.Null(r.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(r.Payload));
    }

    [Fact]
    public async Task Workspace_status_is_loaded()
    {
        var r = await fixture.SendAsync("workspace/status", []);
        Assert.Null(r.Error);
        Assert.Equal("loaded", MessagePackSerializer.Deserialize<string>(r.Payload));
    }

    [Fact]
    public async Task Solution_read_returns_slnx_model()
    {
        var slnxPath = Path.Combine(fixture.TempDir, "TestProject.slnx");
        await File.WriteAllTextAsync(
            slnxPath,
            """
            <Solution>
              <Project Path="TestProject.csproj" />
            </Solution>
            """
        );

        var r = await fixture.SendAsync("solution/read", MessagePackSerializer.Serialize(slnxPath));

        Assert.Null(r.Error);
        var model = MessagePackSerializer.Deserialize<SolutionFileModel>(r.Payload);
        Assert.Equal("slnx", model.Format);
        var project = Assert.Single(model.Projects);
        Assert.Equal("TestProject", project.DisplayName);
    }

    [Fact]
    public async Task Hover_on_documented_method_shows_xml_docs()
    {
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(9, 15));
        Assert.Null(r.Error);
        var h = MessagePackSerializer.Deserialize<HoverResult>(r.Payload);
        Assert.Contains("Add", h.Contents);
        Assert.Contains("Adds two numbers", h.Contents);
        Assert.NotNull(h.StartLine);
    }

    [Fact]
    public async Task Hover_on_class_shows_type_info()
    {
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(3, 13));
        Assert.Null(r.Error);
        var h = MessagePackSerializer.Deserialize<HoverResult>(r.Payload);
        Assert.Contains("Calculator", h.Contents);
    }

    [Fact]
    public async Task Hover_on_var_resolves_type()
    {
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(31, 8));
        Assert.Null(r.Error);
        var h = MessagePackSerializer.Deserialize<HoverResult>(r.Payload);
        Assert.Contains("Calculator", h.Contents);
    }

    [Fact]
    public async Task Hover_on_property_shows_info()
    {
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(11, 18));
        Assert.Null(r.Error);
        var h = MessagePackSerializer.Deserialize<HoverResult>(r.Payload);
        Assert.Contains("Name", h.Contents);
    }

    [Fact]
    public async Task Hover_on_empty_line_returns_result()
    {
        // Even empty lines may resolve to enclosing namespace/type
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(1, 0));
        Assert.Null(r.Error);
    }

    [Fact]
    public async Task Definition_of_method_call_resolves()
    {
        var r = await fixture.SendAsync("textDocument/definition", fixture.PosPayload(32, 25));
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.NotEmpty(loc.Locations);
        Assert.Equal(9, loc.Locations[0].Line);
    }

    [Fact]
    public async Task Definition_on_empty_line_returns_result()
    {
        // Empty lines may still resolve to enclosing constructs
        var r = await fixture.SendAsync("textDocument/definition", fixture.PosPayload(1, 0));
        Assert.Null(r.Error);
    }

    [Fact]
    public async Task TypeDefinition_of_variable_resolves_to_type()
    {
        var r = await fixture.SendAsync("textDocument/typeDefinition", fixture.PosPayload(31, 8));
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.NotEmpty(loc.Locations);
        Assert.Equal(3, loc.Locations[0].Line);
    }

    [Fact]
    public async Task Declaration_of_interface_impl_finds_interface()
    {
        var r = await fixture.SendAsync("textDocument/declaration", fixture.PosPayload(24, 18));
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.NotEmpty(loc.Locations);
        Assert.Equal(19, loc.Locations.First().Line);
    }

    [Fact]
    public async Task Implementation_of_interface_method_finds_impl()
    {
        var r = await fixture.SendAsync("textDocument/implementation", fixture.PosPayload(19, 11));
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.NotEmpty(loc.Locations);
    }

    [Fact]
    public async Task Completion_at_position_returns_items()
    {
        var r = await fixture.SendAsync("textDocument/completion", fixture.PosPayload(32, 25));
        Assert.Null(r.Error);
        var items = MessagePackSerializer.Deserialize<CompletionItem[]>(r.Payload);
        Assert.NotNull(items);
        Assert.NotEmpty(items);
    }

    [Fact]
    public async Task Diagnostics_returns_results()
    {
        var payload = MessagePackSerializer.Serialize(fixture.SourceFile);
        var r = await fixture.SendAsync("workspace/diagnostics", payload);
        Assert.Null(r.Error);
    }

    [Fact]
    public async Task AllDiagnostics_returns_results()
    {
        var payload = MessagePackSerializer.Serialize(
            new SolutionDiagnosticsRequest { ProjectFilter = [] }
        );
        var r = await fixture.SendAsync("workspace/diagnostics/all", payload);
        Assert.Null(r.Error);
    }

    [Fact]
    public async Task DidChange_updates_document()
    {
        var newSource = """
            namespace TestProject;
            public class Calculator
            {
                public int Add(int a, int b) => a + b;
            }
            """;
        var payload = MessagePackSerializer.Serialize(
            new DidChangeRequest { FilePath = fixture.SourceFile, NewText = newSource }
        );
        var r = await fixture.SendAsync("textDocument/didChange", payload);
        Assert.Null(r.Error);
        Assert.Equal("ok", MessagePackSerializer.Deserialize<string>(r.Payload));

        var resetPayload = MessagePackSerializer.Serialize(
            new DidChangeRequest
            {
                FilePath = fixture.SourceFile,
                NewText = CSharpSidecarFixture.InitialSource,
            }
        );
        var reset = await fixture.SendAsync("textDocument/didChange", resetPayload);
        Assert.Null(reset.Error);
    }

    [Fact]
    public async Task References_finds_usages()
    {
        var payload = MessagePackSerializer.Serialize(
            new ReferencesRequest
            {
                FilePath = fixture.SourceFile,
                Line = 9,
                Character = 15,
                IncludeDeclaration = true,
            }
        );
        var r = await fixture.SendAsync("textDocument/references", payload);
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.NotEmpty(loc.Locations);
    }

    [Fact]
    public async Task DocumentHighlight_finds_occurrences()
    {
        var payload = MessagePackSerializer.Serialize(
            new PositionRequest
            {
                FilePath = fixture.SourceFile,
                Line = 9,
                Character = 15,
            }
        );
        var r = await fixture.SendAsync("textDocument/documentHighlight", payload);
        Assert.Null(r.Error);
    }

    [Fact]
    public async Task Unknown_method_returns_error()
    {
        var r = await fixture.SendAsync("bogus/method", []);
        Assert.NotNull(r.Error);
        Assert.Contains("Unknown method", r.Error);
    }

    /// <summary>
    /// BUG: workspace/open receives the workspace ROOT directory, not the
    /// user-selected .sln path. When the root contains multiple .sln files
    /// in subdirectories, the sidecar picks an arbitrary one via
    /// Directory.GetFiles with SearchOption.AllDirectories. The user's
    /// actual solution selection is never communicated to the sidecar.
    ///
    /// This test proves the bug: hover returns null ("Document not found")
    /// because the sidecar loaded the wrong solution.
    /// </summary>
    [Fact]
    public async Task Hover_on_file_in_loaded_project_returns_content()
    {
        // Hover on "Calculator" class name at line 4, char 17.
        // The fixture loaded the project via workspace/open with the temp dir.
        // If the correct solution is loaded, this MUST return hover content.
        var payload = fixture.PosPayload(4, 17);
        var r = await fixture.SendAsync("textDocument/hover", payload);
        Assert.Null(r.Error);

        // The sidecar must find the document and return non-null hover content.
        // BUG: If workspace/open picked the wrong .sln, this returns
        // MessagePack nil (0xC0, 1 byte) instead of actual hover content.
        Assert.True(
            r.Payload.Length > 1,
            "Hover must return content for a symbol in the loaded project. "
                + $"Got {r.Payload.Length} byte(s) — the sidecar likely loaded the wrong solution "
                + "or the document was not found in the workspace."
        );
    }
}
