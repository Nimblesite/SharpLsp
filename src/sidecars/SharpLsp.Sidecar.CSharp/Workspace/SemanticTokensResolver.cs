using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Classification;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>A span of text and its token type, the legend index.</summary>
internal readonly record struct SemanticSpan(TextSpan Span, int Type);

/// <summary>
/// Computes semantic tokens for a document using Roslyn's Classifier API.
/// Returns LSP-encoded token data (relative line, char, length, type, modifiers).
/// </summary>
internal static class SemanticTokensResolver
{
    /// <summary>The legend index of the <c>class</c> token type.</summary>
    internal const int ClassType = 2;

    /// <summary>The legend index of the <c>property</c> token type.</summary>
    internal const int PropertyType = 9;

    /// <summary>The legend index of the <c>keyword</c> token type.</summary>
    internal const int KeywordType = 15;

    /// <summary>The legend index of the <c>decorator</c> token type.</summary>
    internal const int DecoratorType = 22;

    // LSP semantic token types — index into this array is the token type ID.
    private static readonly string[] TokenTypes =
    [
        "namespace", // 0
        "type", // 1
        "class", // 2
        "enum", // 3
        "interface", // 4
        "struct", // 5
        "typeParameter", // 6
        "parameter", // 7
        "variable", // 8
        "property", // 9
        "enumMember", // 10
        "event", // 11
        "function", // 12
        "method", // 13
        "macro", // 14
        "keyword", // 15
        "modifier", // 16
        "comment", // 17
        "string", // 18
        "number", // 19
        "regexp", // 20
        "operator", // 21
        "decorator", // 22
        // [SHARPLSP-FEATURES-HIGHLIGHTING] "Keyword classes": Roslyn's "keyword - control"
        // (`if`, `for`, `return`) is not a plain keyword, and Visual Studio paints it apart.
        "controlKeyword", // 23
    ];

    /// <summary>Get the token type legend (registered in server capabilities).</summary>
    public static string[] GetTokenTypes()
    {
        return TokenTypes;
    }

    /// <summary>Get the token modifier legend.</summary>
    public static string[] GetTokenModifiers()
    {
        return
        [
            "declaration", // 0
            "definition", // 1
            "readonly", // 2
            "static", // 3
            "deprecated", // 4
            "abstract", // 5
            "async", // 6
        ];
    }

    /// <summary>Compute semantic tokens for the full document.</summary>
    public static async Task<int[]> GetFullAsync(Document document, CancellationToken ct)
    {
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var spans = await Classifier
            .GetClassifiedSpansAsync(document, TextSpan.FromBounds(0, text.Length), ct)
            .ConfigureAwait(false);
        return EncodeTokens(spans, text);
    }

    /// <summary>Compute semantic tokens for a range.</summary>
    public static async Task<int[]> GetRangeAsync(
        Document document,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        CancellationToken ct
    )
    {
        var (text, span) = await DocumentText
            .ResolveSpanAsync(document, startLine, startCharacter, endLine, endCharacter, ct)
            .ConfigureAwait(false);

        var spans = await Classifier
            .GetClassifiedSpansAsync(document, span, ct)
            .ConfigureAwait(false);
        return EncodeTokens(spans, text);
    }

    private static int[] EncodeTokens(IEnumerable<ClassifiedSpan> spans, SourceText text)
    {
        return Encode(
            spans.Select(span => new SemanticSpan(
                span.TextSpan,
                MapClassification(span.ClassificationType)
            )),
            text
        );
    }

    /// <summary>
    /// LSP-encode typed spans of <paramref name="text"/> in document order. A span with no
    /// token type (negative) is skipped. Shared by C# documents and Razor files.
    /// </summary>
    internal static int[] Encode(IEnumerable<SemanticSpan> spans, SourceText text)
    {
        var data = new List<int>();
        var prevLine = 0;
        var prevChar = 0;

        foreach (var span in spans.OrderBy(s => s.Span.Start))
        {
            var tokenType = span.Type;
            if (tokenType < 0)
            {
                continue;
            }

            var linePos = text.Lines.GetLinePosition(span.Span.Start);
            var line = linePos.Line;
            var character = linePos.Character;
            var length = span.Span.Length;

            var deltaLine = line - prevLine;
            var deltaChar = deltaLine == 0 ? character - prevChar : character;

            data.Add(deltaLine);
            data.Add(deltaChar);
            data.Add(length);
            data.Add(tokenType);
            data.Add(0); // modifiers (none for now)

            prevLine = line;
            prevChar = character;
        }

        return [.. data];
    }

    /// <summary>The token type of a Roslyn classification; -1 when it has none.</summary>
    internal static int MapClassification(string classification)
    {
        return classification switch
        {
            ClassificationTypeNames.NamespaceName => 0,
            ClassificationTypeNames.ClassName or ClassificationTypeNames.RecordClassName => 2,
            ClassificationTypeNames.EnumName => 3,
            ClassificationTypeNames.InterfaceName => 4,
            ClassificationTypeNames.StructName or ClassificationTypeNames.RecordStructName => 5,
            ClassificationTypeNames.TypeParameterName => 6,
            ClassificationTypeNames.ParameterName => 7,
            ClassificationTypeNames.LocalName => 8,
            ClassificationTypeNames.PropertyName => 9,
            ClassificationTypeNames.EnumMemberName => 10,
            ClassificationTypeNames.EventName => 11,
            ClassificationTypeNames.DelegateName => 12,
            ClassificationTypeNames.MethodName or ClassificationTypeNames.ExtensionMethodName => 13,
            ClassificationTypeNames.FieldName or ClassificationTypeNames.ConstantName => 8,
            ClassificationTypeNames.Keyword => 15,
            ClassificationTypeNames.ControlKeyword => 23,
            ClassificationTypeNames.StringLiteral
            or ClassificationTypeNames.VerbatimStringLiteral => 18,
            ClassificationTypeNames.NumericLiteral => 19,
            ClassificationTypeNames.Operator => 21,
            ClassificationTypeNames.Comment => 17,
            _ => -1,
        };
    }
}
