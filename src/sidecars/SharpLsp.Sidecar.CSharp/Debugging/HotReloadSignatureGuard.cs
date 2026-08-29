using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SharpLsp.Sidecar.CSharp.Debugging;

/// <summary>
/// The spec-pinned signature refusal. [DEBUG-FEATURES-HOT-RELOAD] pins
/// "Change method signature | No — requires restart", while newer runtimes let
/// Roslyn APPLY a signature change by adding a new method — so the change is
/// caught syntactically before emit. Everything this guard is not certain
/// about falls through to Roslyn's real Edit-and-Continue analysis:
/// deletions, additions, parameter renames, attribute edits, and
/// nullable-annotation tweaks are NOT signature changes here.
/// </summary>
internal static class HotReloadSignatureGuard
{
    /// <summary>
    /// The method whose signature changed between the two documents, if any.
    /// A change means an existing signature disappeared AND a new signature
    /// with the same container-qualified name appeared: a deleted method
    /// leaves no new signature behind, and an added overload removes nothing,
    /// so both fall through to Roslyn's own verdict.
    /// </summary>
    public static async Task<string?> ChangedMethodSignatureAsync(
        Document current,
        Document candidate,
        CancellationToken ct
    )
    {
        var currentShapes = await ShapesAsync(current, ct).ConfigureAwait(false);
        var candidateShapes = await ShapesAsync(candidate, ct).ConfigureAwait(false);
        return ChangedSignature(currentShapes, candidateShapes);
    }

    private static string? ChangedSignature(List<MethodShape> current, List<MethodShape> candidate)
    {
        var currentSignatures = current
            .Select(shape => shape.Signature)
            .ToHashSet(StringComparer.Ordinal);
        var candidateSignatures = candidate
            .Select(shape => shape.Signature)
            .ToHashSet(StringComparer.Ordinal);
        var reshapedNames = candidate
            .Where(shape => !currentSignatures.Contains(shape.Signature))
            .Select(shape => shape.Name)
            .ToHashSet(StringComparer.Ordinal);
        return current
            .FirstOrDefault(shape =>
                !candidateSignatures.Contains(shape.Signature) && reshapedNames.Contains(shape.Name)
            )
            ?.Identifier;
    }

    /// <summary>
    /// The identifying shapes of one method declaration: its
    /// container-qualified name and its normalized signature.
    /// </summary>
    private sealed record MethodShape(string Name, string Signature, string Identifier);

    private static async Task<List<MethodShape>> ShapesAsync(
        Document document,
        CancellationToken ct
    )
    {
        var root =
            await document.GetSyntaxRootAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Hot reload requires a parsed syntax tree.");
        return [.. root.DescendantNodes().OfType<MethodDeclarationSyntax>().Select(ShapeOf)];
    }

    private static MethodShape ShapeOf(MethodDeclarationSyntax method)
    {
        var container = ContainerOf(method);
        var declaration = Normalize(method);
        return new MethodShape(
            $"{container}:{method.Identifier.ValueText}",
            $"{container}:{declaration.NormalizeWhitespace().ToFullString()}",
            method.Identifier.ValueText
        );
    }

    /// <summary>
    /// Strip everything that is legal to edit under hot reload from the
    /// declaration: the body, attributes, parameter names, parameter
    /// defaults, and nullable annotations (reference-type annotations are
    /// metadata-only; value-type ones that DO change the signature still fall
    /// through to Roslyn's real analysis).
    /// </summary>
    private static MethodDeclarationSyntax Normalize(MethodDeclarationSyntax method)
    {
        var stripped = method
            .WithBody(null)
            .WithExpressionBody(null)
            .WithSemicolonToken(SyntaxFactory.Token(SyntaxKind.SemicolonToken))
            .WithAttributeLists(default);
        var parameters = stripped.ParameterList.Parameters.Select(NormalizeParameter);
        stripped = stripped.WithParameterList(
            stripped.ParameterList.WithParameters(SyntaxFactory.SeparatedList(parameters))
        );
        return (MethodDeclarationSyntax)new NullableAnnotationStripper().Visit(stripped);
    }

    private static ParameterSyntax NormalizeParameter(ParameterSyntax parameter)
    {
        return parameter
            .WithAttributeLists(default)
            .WithIdentifier(SyntaxFactory.Identifier("_"))
            .WithDefault(null);
    }

    private static string ContainerOf(MethodDeclarationSyntax method)
    {
        return string.Join(
            ".",
            method
                .Ancestors()
                .Where(node => node is TypeDeclarationSyntax or BaseNamespaceDeclarationSyntax)
                .Reverse()
                .Select(node =>
                    node switch
                    {
                        TypeDeclarationSyntax type => type.Identifier.ValueText,
                        BaseNamespaceDeclarationSyntax space => space.Name.ToString(),
                        _ => "",
                    }
                )
        );
    }

    /// <summary>Replace every `T?` with `T`, recursively.</summary>
    private sealed class NullableAnnotationStripper : CSharpSyntaxRewriter
    {
        public override SyntaxNode? VisitNullableType(NullableTypeSyntax node)
        {
            return Visit(node.ElementType);
        }
    }
}
