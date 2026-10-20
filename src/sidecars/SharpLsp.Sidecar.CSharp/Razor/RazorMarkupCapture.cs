using Microsoft.AspNetCore.Razor.Language;
using Microsoft.AspNetCore.Razor.Language.Intermediate;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Reads markup facts out of the compiler's IR while it is built. Directives are read first
/// in the directive-classifier phase, before <c>@code</c> becomes plain C#; tags and
/// attributes first in the optimization phase, before components are lowered and attribute
/// names lose their spans; diagnostics last. The IR is mutated after each read, so each
/// pass copies what it needs at once. Implements [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
internal sealed class RazorMarkupCapture
{
    private readonly List<MarkupDirective> _directives = [];
    private readonly List<MarkupTag> _tags = [];
    private readonly List<MarkupAttribute> _attributes = [];
    private readonly List<MarkupDiagnostic> _diagnostics = [];
    private readonly List<string> _namespaces = [];
    private RazorCodeDocument? _codeDocument;
    private string _htmlText = "";

    /// <summary>Add the capture passes to an engine.</summary>
    public void Register(RazorProjectEngineBuilder builder)
    {
        builder.Features.Add(new DirectivePass(this));
        builder.Features.Add(new TagPass(this));
        builder.Features.Add(new DiagnosticPass(this));
    }

    /// <summary>The facts captured while the engine processed one file.</summary>
    public RazorMarkup? ToMarkup(TagHelperCollection tagHelpers)
    {
        return _codeDocument is not { } document
            ? null
            : new RazorMarkup(
                document.Source.Text,
                document.FileKind,
                document.TryGetNamespace(true, out var ns) ? ns : null,
                [.. _namespaces.Distinct(StringComparer.Ordinal)],
                [.. _tags],
                [.. _attributes],
                [.. _directives],
                [.. _diagnostics.Distinct()],
                document.ParserOptions.Directives,
                tagHelpers
            )
            {
                HtmlText = _htmlText,
            };
    }

    private void ReadDirectives(RazorCodeDocument document, DocumentIntermediateNode root)
    {
        var text = document.Source.Text;
        _htmlText = RazorHtmlProjection.Create(text, root);
        foreach (var node in RazorIr.Descendants(root).Where(node => !node.IsImported))
        {
            if (RazorIr.Directive(node, text) is { } directive)
            {
                _directives.Add(directive);
            }
        }
    }

    private void ReadTags(RazorCodeDocument document, DocumentIntermediateNode root)
    {
        _codeDocument = document;
        var text = document.Source.Text;
        foreach (var node in RazorIr.Descendants(root))
        {
            if (node is UsingDirectiveIntermediateNode use && RazorIr.Namespace(use) is { } ns)
            {
                _namespaces.Add(ns);
            }
            else if (!node.IsImported && RazorIr.Tag(node, text) is { } tag)
            {
                _tags.Add(tag);
                _attributes.AddRange(RazorIr.Attributes(node, tag, text));
            }
        }
    }

    private void ReadDiagnostics(RazorCodeDocument document, DocumentIntermediateNode root)
    {
        var path = document.Source.FilePath;
        _diagnostics.AddRange(
            RazorIr
                .Descendants(root)
                .SelectMany(node => node.Diagnostics)
                .Where(diagnostic => RazorIr.IsIn(diagnostic, path, document.Source.Text))
                .Select(diagnostic => new MarkupDiagnostic(
                    diagnostic.Id,
                    diagnostic.GetMessage(System.Globalization.CultureInfo.InvariantCulture),
                    diagnostic.Severity,
                    new TextSpan(diagnostic.Span.AbsoluteIndex, diagnostic.Span.Length)
                ))
        );
    }

    private sealed class DirectivePass(RazorMarkupCapture capture)
        : IntermediateNodePassBase,
            IRazorDirectiveClassifierPass
    {
        public override int Order => int.MinValue;

        protected override void ExecuteCore(
            RazorCodeDocument codeDocument,
            DocumentIntermediateNode documentNode,
            CancellationToken cancellationToken
        )
        {
            capture.ReadDirectives(codeDocument, documentNode);
        }
    }

    private sealed class TagPass(RazorMarkupCapture capture)
        : IntermediateNodePassBase,
            IRazorOptimizationPass
    {
        public override int Order => int.MinValue;

        protected override void ExecuteCore(
            RazorCodeDocument codeDocument,
            DocumentIntermediateNode documentNode,
            CancellationToken cancellationToken
        )
        {
            capture.ReadTags(codeDocument, documentNode);
        }
    }

    private sealed class DiagnosticPass(RazorMarkupCapture capture)
        : IntermediateNodePassBase,
            IRazorOptimizationPass
    {
        public override int Order => int.MaxValue - 1;

        protected override void ExecuteCore(
            RazorCodeDocument codeDocument,
            DocumentIntermediateNode documentNode,
            CancellationToken cancellationToken
        )
        {
            capture.ReadDiagnostics(codeDocument, documentNode);
        }
    }
}
