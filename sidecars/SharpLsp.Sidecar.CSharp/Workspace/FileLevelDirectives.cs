using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>The five file-level directives recognized by the .NET SDK.</summary>
internal enum FileDirectiveKind
{
    Unknown,
    Sdk,
    Package,
    Project,
    Property,
    Include,
}

/// <summary>
/// A single <c>#:</c> file-level directive. <see cref="Argument"/> is the raw text after the
/// keyword; <see cref="Name"/> and <see cref="Value"/> are its split halves for the directives
/// that carry a <c>name@version</c> or <c>name=value</c> payload.
/// </summary>
internal sealed record FileDirective(
    FileDirectiveKind Kind,
    string Argument,
    string Name,
    string? Value,
    TextSpanLocation Location
);

/// <summary>Span of a directive within its file, for diagnostic reporting.</summary>
internal sealed record TextSpanLocation(int Start, int Length);

/// <summary>
/// Parses .NET file-based app <c>#:</c> directives. Implements [SCRIPT-FILEBASED-DIRECTIVES].
/// </summary>
/// <remarks>
/// Directives are read from the Roslyn CST, never by scanning text: Roslyn lexes <c>#:</c> as
/// <see cref="IgnoredDirectiveTriviaSyntax"/> and <c>#!</c> as
/// <c>ShebangDirectiveTriviaSyntax</c>. Splitting the directive's own payload on the first
/// space, <c>@</c>, or <c>=</c> is not string-matching the source: the payload is a single
/// opaque token in the grammar, and the SDK defines its shape at exactly this granularity.
/// </remarks>
internal static class FileLevelDirectives
{
    private static readonly char[] ArgumentSeparators = [' ', '\t'];

    /// <summary>Extract every file-level directive from a parsed syntax tree.</summary>
    public static IReadOnlyList<FileDirective> Parse(SyntaxNode root)
    {
        return
        [
            .. root.DescendantNodes(descendIntoTrivia: true)
                .OfType<IgnoredDirectiveTriviaSyntax>()
                .Select(ToDirective)
                .OfType<FileDirective>(),
        ];
    }

    private static FileDirective? ToDirective(IgnoredDirectiveTriviaSyntax node)
    {
        var content = node.Content.ValueText?.Trim();
        if (string.IsNullOrEmpty(content))
        {
            return null;
        }

        var (keyword, argument) = SplitFirstWord(content);
        var kind = ClassifyKeyword(keyword);
        var (name, value) = SplitPayload(kind, argument);
        var span = node.Span;
        return new FileDirective(
            kind,
            argument,
            name,
            value,
            new TextSpanLocation(span.Start, span.Length)
        );
    }

    private static (string Keyword, string Argument) SplitFirstWord(string content)
    {
        var index = content.IndexOfAny(ArgumentSeparators);
        return index < 0
            ? (content, string.Empty)
            : (content[..index], content[(index + 1)..].Trim());
    }

    private static FileDirectiveKind ClassifyKeyword(string keyword)
    {
        return keyword switch
        {
            "sdk" => FileDirectiveKind.Sdk,
            "package" => FileDirectiveKind.Package,
            "project" => FileDirectiveKind.Project,
            "property" => FileDirectiveKind.Property,
            "include" => FileDirectiveKind.Include,
            _ => FileDirectiveKind.Unknown,
        };
    }

    // `#:sdk Name@Version` and `#:package Name@Version` split on '@';
    // `#:property Name=Value` splits on '='. `#:include` and `#:project` are whole-value.
    private static (string Name, string? Value) SplitPayload(
        FileDirectiveKind kind,
        string argument
    )
    {
        return kind switch
        {
            FileDirectiveKind.Sdk or FileDirectiveKind.Package => SplitOn(argument, '@'),
            FileDirectiveKind.Property => SplitOn(argument, '='),
            FileDirectiveKind.Project or FileDirectiveKind.Include or FileDirectiveKind.Unknown => (
                argument,
                null
            ),
            _ => (argument, null),
        };
    }

    private static (string Name, string? Value) SplitOn(string argument, char separator)
    {
        var index = argument.IndexOf(separator, StringComparison.Ordinal);
        return index < 0
            ? (argument, null)
            : (argument[..index].Trim(), argument[(index + 1)..].Trim());
    }
}
