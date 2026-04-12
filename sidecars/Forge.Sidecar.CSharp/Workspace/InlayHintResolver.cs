using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Computes inlay hints (parameter names, type inference) via Roslyn.
/// </summary>
internal static class InlayHintResolver
{
    /// <summary>Get inlay hints for a document range.</summary>
    public static async Task<List<InlayHintResult>> GetHintsAsync(
        Document document,
        int startLine,
        int endLine,
        CancellationToken ct
    )
    {
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (model is null || root is null)
        {
            return [];
        }

        var start = text.Lines.GetPosition(new LinePosition(startLine, 0));
        var endPos = text.Lines.GetPosition(
            new LinePosition(Math.Min(endLine, text.Lines.Count - 1), 0)
        );
        var span = TextSpan.FromBounds(start, Math.Max(start, endPos));

        var hints = new List<InlayHintResult>();
        CollectParameterHints(root, model, span, hints, ct);
        CollectTypeHints(root, model, text, span, hints, ct);
        CollectLambdaTypeHints(root, model, text, span, hints, ct);
        return hints;
    }

    private static void CollectParameterHints(
        SyntaxNode root,
        SemanticModel model,
        TextSpan span,
        List<InlayHintResult> hints,
        CancellationToken ct
    )
    {
        foreach (var invocation in root.DescendantNodes(span).OfType<InvocationExpressionSyntax>())
        {
            ct.ThrowIfCancellationRequested();
            AddParameterHintsForArgs(invocation.ArgumentList, model, hints, ct);
        }

        foreach (
            var creation in root.DescendantNodes(span).OfType<ObjectCreationExpressionSyntax>()
        )
        {
            ct.ThrowIfCancellationRequested();
            if (creation.ArgumentList is not null)
            {
                AddParameterHintsForArgs(creation.ArgumentList, model, hints, ct);
            }
        }
    }

    private static void AddParameterHintsForArgs(
        ArgumentListSyntax argList,
        SemanticModel model,
        List<InlayHintResult> hints,
        CancellationToken ct
    )
    {
        foreach (var arg in argList.Arguments)
        {
            if (arg.NameColon is not null)
            {
                continue; // Already has explicit parameter name.
            }

            var paramSymbol = DetermineParameter(arg, model, ct);
            if (paramSymbol is null || paramSymbol.Name.Length == 0)
            {
                continue;
            }

            var pos = arg.Expression.GetLocation().GetMappedLineSpan();
            if (!pos.IsValid)
            {
                continue;
            }

            hints.Add(
                new InlayHintResult
                {
                    Line = pos.StartLinePosition.Line,
                    Character = pos.StartLinePosition.Character,
                    Label = $"{paramSymbol.Name}:",
                    Kind = 2, // Parameter
                }
            );
        }
    }

    private static IParameterSymbol? DetermineParameter(
        ArgumentSyntax arg,
        SemanticModel model,
        CancellationToken ct
    )
    {
        if (arg.Parent?.Parent is not ExpressionSyntax expr)
        {
            return null;
        }

        var symbolInfo = model.GetSymbolInfo(expr, ct);
        if (symbolInfo.Symbol is not IMethodSymbol method)
        {
            return null;
        }

        var argList = arg.Parent as ArgumentListSyntax;
        var index = argList?.Arguments.IndexOf(arg) ?? -1;
        return index >= 0 && index < method.Parameters.Length ? method.Parameters[index] : null;
    }

    private static void CollectLambdaTypeHints(
        SyntaxNode root,
        SemanticModel model,
        SourceText text,
        TextSpan span,
        List<InlayHintResult> hints,
        CancellationToken ct
    )
    {
        foreach (var lambda in root.DescendantNodes(span).OfType<SimpleLambdaExpressionSyntax>())
        {
            ct.ThrowIfCancellationRequested();
            AddLambdaParamHint(lambda.Parameter, model, text, hints);
        }

        foreach (
            var lambda in root.DescendantNodes(span).OfType<ParenthesizedLambdaExpressionSyntax>()
        )
        {
            ct.ThrowIfCancellationRequested();
            foreach (var param in lambda.ParameterList.Parameters)
            {
                if (param.Type is not null)
                {
                    continue; // Already has explicit type.
                }

                AddLambdaParamHint(param, model, text, hints);
            }
        }
    }

    private static void AddLambdaParamHint(
        ParameterSyntax param,
        SemanticModel model,
        SourceText text,
        List<InlayHintResult> hints
    )
    {
        if (param.Type is not null)
        {
            return; // Already has explicit type.
        }

        var symbol = model.GetDeclaredSymbol(param);
        if (symbol?.Type is null or IErrorTypeSymbol)
        {
            return;
        }

        var typeName = symbol.Type.ToMinimalDisplayString(
            model,
            param.SpanStart,
            SymbolDisplayFormat.MinimallyQualifiedFormat
        );
        var endPos = text.Lines.GetLinePosition(param.Identifier.Span.End);
        hints.Add(
            new InlayHintResult
            {
                Line = endPos.Line,
                Character = endPos.Character,
                Label = $": {typeName}",
                Kind = 1, // Type
            }
        );
    }

    private static void CollectTypeHints(
        SyntaxNode root,
        SemanticModel model,
        SourceText text,
        TextSpan span,
        List<InlayHintResult> hints,
        CancellationToken ct
    )
    {
        foreach (var varDecl in root.DescendantNodes(span).OfType<VariableDeclarationSyntax>())
        {
            ct.ThrowIfCancellationRequested();
            if (varDecl.Type is not IdentifierNameSyntax { Identifier.Text: "var" } varId)
            {
                continue;
            }

            var typeInfo = model.GetTypeInfo(varDecl.Type, ct);
            if (typeInfo.Type is null or IErrorTypeSymbol)
            {
                continue;
            }

            var typeName = typeInfo.Type.ToMinimalDisplayString(
                model,
                varId.SpanStart,
                SymbolDisplayFormat.MinimallyQualifiedFormat
            );

            var endPos = text.Lines.GetLinePosition(varId.Span.End);
            hints.Add(
                new InlayHintResult
                {
                    Line = endPos.Line,
                    Character = endPos.Character,
                    Label = $": {typeName}",
                    Kind = 1, // Type
                }
            );
        }
    }
}
