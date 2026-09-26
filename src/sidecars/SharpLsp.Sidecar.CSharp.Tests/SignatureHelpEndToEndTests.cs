using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes.
#pragma warning disable CA1515

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// C# signature help through the real <see cref="WorkspaceManager"/>, against a real
/// file-based program on disk. C# answered <c>null</c> for every call while F# listed
/// its overloads (GitHub #174), so VS Code showed no parameter hints in C# at all.
/// Implements [SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP].
/// </summary>
public sealed class SignatureHelpEndToEndTests : IDisposable
{
    private const string Caret = "$$";

    private const string Greeter = """
        static class Greeter
        {
            public static string Greet(string name) => name;
            public static string Greet(string name, int times) => name;
            public static string Greet(string name, int times, bool shout) => name;
        }
        """;

    private readonly ProjectlessWorkspaceFixture _fixture = new("sighelp");

    public void Dispose()
    {
        _fixture.Dispose();
    }

    [Fact]
    public async Task Every_overload_is_offered_and_the_one_the_call_binds_to_is_active()
    {
        var help = await HelpAtAsync($"Greeter.Greet(\"Ada\", {Caret}3);\n\n{Greeter}\n");

        Assert.NotNull(help);
        Assert.Equal(
            [
                "string Greeter.Greet(string name)",
                "string Greeter.Greet(string name, int times)",
                "string Greeter.Greet(string name, int times, bool shout)",
            ],
            help.Signatures.Select(signature => signature.Label)
        );
        Assert.Equal(1, help.ActiveSignature);
        Assert.Equal(1, help.ActiveParameter);
        Assert.Equal(["string name", "int times"], help.Signatures[1].Parameters);
        Assert.All(
            help.Signatures,
            signature =>
                Assert.All(
                    signature.Parameters,
                    parameter =>
                        Assert.Contains(parameter, signature.Label, StringComparison.Ordinal)
                )
        );
    }

    [Fact]
    public async Task The_active_parameter_follows_the_caret_across_the_commas()
    {
        var first = await HelpAtAsync($"Greeter.Greet({Caret}\"Ada\", 3, true);\n\n{Greeter}\n");
        var third = await HelpAtAsync($"Greeter.Greet(\"Ada\", 3, {Caret}true);\n\n{Greeter}\n");
        var typing = await HelpAtAsync($"Greeter.Greet(\"Ada\", {Caret}\n\n{Greeter}\n");

        Assert.Equal(0, first?.ActiveParameter);
        Assert.Equal(2, first?.ActiveSignature);
        Assert.Equal(2, third?.ActiveParameter);
        Assert.Equal(1, typing?.ActiveParameter);
        Assert.Equal(3, typing?.Signatures.Count);
    }

    [Fact]
    public async Task A_named_argument_activates_the_parameter_it_names()
    {
        var help = await HelpAtAsync(
            $"Greeter.Greet(times: 2, name: {Caret}\"Ada\");\n\n{Greeter}\n"
        );

        Assert.NotNull(help);
        Assert.Equal(1, help.ActiveSignature);
        Assert.Equal(0, help.ActiveParameter);
    }

    [Fact]
    public async Task A_constructor_call_offers_the_constructors_of_the_type_it_creates()
    {
        var explicitNew = await HelpAtAsync(
            $$$"""
            var point = new Point(1, {{{Caret}}}2);

            sealed class Point
            {
                public Point() { }
                public Point(int x, int y) { }
            }

            """
        );

        Assert.NotNull(explicitNew);
        Assert.Equal(
            ["Point()", "Point(int x, int y)"],
            explicitNew.Signatures.Select(s => s.Label)
        );
        Assert.Equal(1, explicitNew.ActiveSignature);
        Assert.Equal(1, explicitNew.ActiveParameter);
    }

    [Fact]
    public async Task A_delegate_call_offers_the_delegates_own_signature()
    {
        var help = await HelpAtAsync(
            $"Func<int, string> describe = value => value.ToString();\ndescribe({Caret}1);\n"
        );

        Assert.NotNull(help);
        var signature = Assert.Single(help.Signatures);
        Assert.Equal(["int arg"], signature.Parameters);
        Assert.Contains("(int arg)", signature.Label, StringComparison.Ordinal);
        Assert.Equal(0, help.ActiveParameter);
    }

    [Fact]
    public async Task A_framework_method_lists_every_overload_it_has()
    {
        var help = await HelpAtAsync($"Console.WriteLine({Caret});\n");

        Assert.NotNull(help);
        Assert.True(help.Signatures.Count >= 10, $"{help.Signatures.Count} overloads");
        Assert.All(
            help.Signatures,
            signature =>
                Assert.StartsWith(
                    "void Console.WriteLine(",
                    signature.Label,
                    StringComparison.Ordinal
                )
        );
        Assert.Contains(help.Signatures, signature => signature.Parameters.Count == 0);
    }

    [Fact]
    public async Task Outside_an_argument_list_there_is_no_signature_help()
    {
        var statement = await HelpAtAsync($"var x = {Caret}1;\nConsole.WriteLine(x);\n");
        var afterCall = await HelpAtAsync($"Console.WriteLine(1){Caret};\n");

        Assert.Null(statement);
        Assert.Null(afterCall);
    }

    /// <summary>Open <paramref name="marked"/> as a program and ask at its caret.</summary>
    private async Task<SignatureHelpResult?> HelpAtAsync(string marked)
    {
        var offset = marked.IndexOf(Caret, StringComparison.Ordinal);
        var text = marked.Remove(offset, Caret.Length);
        var before = text[..offset];
        var line = before.Count(character => character == '\n');
        var character = offset - (before.LastIndexOf('\n') + 1);

        var app = _fixture.Write($"Program{Guid.NewGuid():N}.cs", text);
        using var manager = new WorkspaceManager();
        Assert.False(
            (
                await ProjectlessWorkspaceFixture.OpenAsync(manager, app).ConfigureAwait(false)
            ).IsError
        );
        var result = await manager
            .GetSignatureHelpAsync(app, line, character)
            .ConfigureAwait(false);
        return result.Match(value => value, error => throw new InvalidOperationException(error));
    }
}
