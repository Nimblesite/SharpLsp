using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // File IO is banned for analyzers — these are tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// [SHARPLSP-FEATURES-HIGHLIGHTING-REGEX] A regex pattern in a string literal is not one flat
/// string: its syntax comes back as <c>regexp</c> tokens, through the real semantic-token
/// pipeline over a real project, for verbatim, escaped and raw literals.
/// </summary>
public sealed class RegexHighlightingTests : IAsyncLifetime, IDisposable
{
    private const string Source = """"
        using System.Text.RegularExpressions;

        namespace R;

        public static class Patterns
        {
            public static readonly Regex Verbatim = new(@"^\d+(?<word>[a-z]+)?$");
            public static readonly Regex Escaped = new("\\w+\\.\"x\"|y{2,3}");
            public static bool Raw(string input) => Regex.IsMatch(input, """a.b*?""");
            public static bool Quoted(string input) => Regex.IsMatch(input, @"""(?:x)""");
            public const string Plain = @"^\d+$";
            public static string Shown() => string.Concat(@"^\d+$", "(a|b)");
        }

        """";

    private readonly string _root = NativePaths.Temp($"sharplsp-regex-{Guid.NewGuid():N}");
    private readonly WorkspaceManager _manager = new();
    private string SourcePath => NativePaths.Join(_root, "Patterns.cs");

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_root);
        var project = NativePaths.Join(_root, "R.csproj");
        await File.WriteAllTextAsync(
                project,
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Library</OutputType></PropertyGroup></Project>"
            )
            .ConfigureAwait(false);
        await File.WriteAllTextAsync(SourcePath, Source).ConfigureAwait(false);
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var opened = await _manager.OpenAsync(project).ConfigureAwait(false);
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
    }

    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _manager.Dispose();
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, true);
        }
    }

    /// <summary>The string and regexp tokens of the line holding <paramref name="marker"/>, as text and type.</summary>
    private static List<(string Text, string Type)> LiteralTokens(int[] data, string marker)
    {
        var lines = Source.Split('\n');
        var wanted = Array.FindIndex(lines, line =>
            line.Contains(marker, StringComparison.Ordinal)
        );
        var types = SemanticTokensResolver.GetTokenTypes();
        var tokens = new List<(string, string)>();
        var (line, character) = (0, 0);
        for (var index = 0; index < data.Length; index += 5)
        {
            character = data[index] == 0 ? character + data[index + 1] : data[index + 1];
            line += data[index];
            var type = types[data[index + 3]];
            if (line == wanted && type is "string" or "regexp")
            {
                tokens.Add((lines[line].Substring(character, data[index + 2]), type));
            }
        }
        return tokens;
    }

    private static (string, string) Regexp(string text)
    {
        return (text, "regexp");
    }

    private static (string, string) Text(string text)
    {
        return (text, "string");
    }

    [Fact]
    public async Task Regex_literals_split_into_pattern_syntax_and_literal_text()
    {
        var full = await _manager.GetSemanticTokensFullAsync(SourcePath);
        Assert.False(full.IsError, full.Match(_ => "ok", error => error));
        var data = (+full).Data;
        Assert.Equal(0, data.Length % 5);

        // Interaction 1 — a verbatim pattern: anchors, an escape, quantifiers, a named group, a class.
        Assert.Equal(
            [
                Text("@\""),
                Regexp("^"),
                Regexp(@"\d"),
                Regexp("+"),
                Regexp("(?<word>"),
                Regexp("[a-z]"),
                Regexp("+"),
                Regexp(")"),
                Regexp("?"),
                Regexp("$"),
                Text("\""),
            ],
            LiteralTokens(data, "Verbatim =")
        );

        // Interaction 2 — an escaped literal: a C# escape is one pattern character, so `\\w` is
        // the regex escape `\w`, `\\.` an escaped dot, and `\"` a literal quote.
        Assert.Equal(
            [
                Text("\""),
                Regexp(@"\\w"),
                Regexp("+"),
                Regexp(@"\\."),
                Text("\\\"x\\\""),
                Regexp("|"),
                Text("y"),
                Regexp("{2,3}"),
                Text("\""),
            ],
            LiteralTokens(data, "Escaped =")
        );

        // Interaction 3 — a raw literal and a verbatim one whose `""` is one quote.
        Assert.Equal(
            [Text("\"\"\"a"), Regexp("."), Text("b"), Regexp("*?"), Text("\"\"\"")],
            LiteralTokens(data, "Raw(string")
        );
        Assert.Equal(
            [Text("@\"\"\""), Regexp("(?:"), Text("x"), Regexp(")"), Text("\"\"\"")],
            LiteralTokens(data, "Quoted(string")
        );

        // Interaction 4 — a string that is not a regex argument stays one string, whatever it holds.
        Assert.Equal([Text("@\"^\\d+$\"")], LiteralTokens(data, "Plain ="));
        Assert.Equal([Text("@\"^\\d+$\""), Text("\"(a|b)\"")], LiteralTokens(data, "Shown()"));

        // Interaction 5 — a range request carves the same tokens for the lines it covers.
        var range = await _manager.GetSemanticTokensRangeAsync(SourcePath, 6, 0, 7, 0);
        Assert.False(range.IsError, range.Match(_ => "ok", error => error));
        var ranged = (+range).Data;
        Assert.Contains(RegexLiteralTokens.RegexpType, ranged.Where((_, index) => index % 5 == 3));
        Assert.True(ranged.Length < data.Length);
    }

    /// <summary>The pattern's syntax pieces, in order, joined by spaces.</summary>
    private static string Syntax(string pattern)
    {
        return string.Join(
            ' ',
            RegexPatternTokens.Of(pattern).Select(range => pattern[range.Start..range.End])
        );
    }

    [Theory]
    [InlineData("abc", "")]
    [InlineData(@"\d\w\s\b\.", @"\d \w \s \b \.")]
    [InlineData(@"\p{Lu}\P{L}x", @"\p{Lu} \P{L}")]
    [InlineData(@"\k<name>\1\12a", @"\k<name> \1 \12")]
    [InlineData(@"\u0041\x41\cA", @"\u0041 \x41 \cA")]
    [InlineData("[a-z][^0-9]", "[a-z] [^0-9]")]
    [InlineData(@"[]a][\]][a-z-[aeiou]]x", @"[]a] [\]] [a-z-[aeiou]]")]
    [InlineData("(a)(?:b)(?=c)(?!d)(?<=e)(?<!f)(?>g)", "( ) (?: ) (?= ) (?! ) (?<= ) (?<! ) (?> )")]
    [InlineData("(?<n>x)(?'m'y)(?i)(?i-m:z)(?#note)", "(?<n> ) (?'m' ) (?i ) (?i-m: ) (?#note)")]
    [InlineData("a*b+c?d*?e+?f??", "* + ? *? +? ??")]
    [InlineData("a{2}b{2,}c{2,3}d{2,3}?e{x}f{", "{2} {2,} {2,3} {2,3}?")]
    [InlineData("^a|b.$", "^ | . $")]
    [InlineData(@"a\", @"\")]
    [InlineData("[abc", "[abc")]
    [InlineData("(?<name", "(?<name")]
    [InlineData("", "")]
    public void Pattern_syntax_is_tokenized(string pattern, string expected)
    {
        Assert.Equal(expected, Syntax(pattern));
        // Ranges are in order, inside the pattern, and never overlap.
        var ranges = RegexPatternTokens.Of(pattern);
        Assert.All(ranges, range =>
            Assert.True(range.Start < range.End && range.End <= pattern.Length)
        );
        Assert.All(ranges.Zip(ranges.Skip(1)), pair =>
            Assert.True(pair.First.End <= pair.Second.Start)
        );
    }
}
