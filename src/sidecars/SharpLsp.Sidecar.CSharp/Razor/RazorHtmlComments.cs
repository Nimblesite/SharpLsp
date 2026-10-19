using Microsoft.AspNetCore.Razor.Language;
using Microsoft.AspNetCore.Razor.Language.Intermediate;
using Microsoft.CodeAnalysis.Razor;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Component lowering discards HTML comments. A markup-only compiler pass retains their
/// token boundaries; only those spans are restored. Implements [RAZOR-ARCHITECTURE-HTML].
/// </summary>
internal static class RazorHtmlComments
{
    public static RazorMarkup Restore(
        RazorProjectEngine original,
        RazorCodeDocument document,
        RazorMarkup markup,
        CancellationToken ct
    )
    {
        if (!document.FileKind.IsComponent())
        {
            return markup;
        }

        var spans = ReadComments(original, document, ct);
        return markup with
        {
            HtmlText = RestoreSpans(document.Source.Text, markup.HtmlText, spans),
        };
    }

    private static List<TextSpan> ReadComments(
        RazorProjectEngine original,
        RazorCodeDocument document,
        CancellationToken ct
    )
    {
        var comments = new CommentPass();
        var engine = CreateEngine(original, comments);
        var input = RazorCodeDocument.Create(
            document.Source,
            document.Imports,
            document.ParserOptions.WithFlags(allowComponentFileKind: false),
            document.CodeGenerationOptions
        );
        _ = engine.Engine.Process(input, ct);
        return comments.Spans;
    }

    private static string RestoreSpans(SourceText source, string html, IEnumerable<TextSpan> spans)
    {
        var chars = html.ToCharArray();
        foreach (var span in spans)
        {
            source.CopyTo(span.Start, chars, span.Start, span.Length);
        }
        return new string(chars);
    }

    private static RazorProjectEngine CreateEngine(
        RazorProjectEngine original,
        CommentPass comments
    )
    {
        return RazorProjectEngine.Create(
            original.Configuration,
            original.FileSystem,
            builder =>
            {
                CompilerFeatures.Register(builder);
                builder.Features.Add(comments);
            }
        );
    }

    private sealed class CommentPass : IntermediateNodePassBase, IRazorDirectiveClassifierPass
    {
        public override int Order => int.MinValue;
        public List<TextSpan> Spans { get; } = [];

        protected override void ExecuteCore(
            RazorCodeDocument document,
            DocumentIntermediateNode root,
            CancellationToken ct
        )
        {
            int? start = null;
            foreach (var token in RazorIr.Descendants(root).OfType<HtmlIntermediateToken>())
            {
                start = ReadToken(token, start);
            }
            if (start is { } remaining)
            {
                Spans.Add(TextSpan.FromBounds(remaining, document.Source.Text.Length));
            }
        }

        private int? ReadToken(HtmlIntermediateToken token, int? start)
        {
            if (token.IsImported || token.Source is not { } source)
            {
                return start;
            }
            if (start is null && token.Content == "<!--")
            {
                return source.AbsoluteIndex;
            }
            if (start is { } first && token.Content == "-->")
            {
                Spans.Add(TextSpan.FromBounds(first, source.AbsoluteIndex + source.Length));
                return null;
            }
            return start;
        }
    }
}
