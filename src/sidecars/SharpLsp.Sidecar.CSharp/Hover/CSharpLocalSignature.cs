using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SharpLsp.Sidecar.CSharp.Hover;

/// <summary>Render local types at the hovered flow state. [HOVER-CSHARP-RENDERING]</summary>
internal static class CSharpLocalSignature
{
    public static string Render(
        ILocalSymbol local,
        SemanticModel model,
        SyntaxToken token,
        SymbolDisplayFormat format,
        CancellationToken ct
    )
    {
        var type = TypeAt(local, TypeInfo(model, token, ct));
        var parts = type.ToDisplayParts(format.WithKindOptions(SymbolDisplayKindOptions.None));
        return parts
            .Add(new SymbolDisplayPart(SymbolDisplayPartKind.Space, null, " "))
            .AddRange(local.ToDisplayParts(format.WithLocalOptions(SymbolDisplayLocalOptions.None)))
            .ToDisplayString();
    }

    private static TypeInfo TypeInfo(SemanticModel model, SyntaxToken token, CancellationToken ct)
    {
        var expression = token.Parent switch
        {
            VariableDeclaratorSyntax declaration => declaration.Initializer?.Value,
            ExpressionSyntax value => value,
            _ => null,
        };
        return expression is null ? default : model.GetTypeInfo(expression, ct);
    }

    private static ITypeSymbol TypeAt(ILocalSymbol local, TypeInfo info)
    {
        return local.Type.WithNullableAnnotation(
            info.Nullability.FlowState switch
            {
                NullableFlowState.None => local.Type.NullableAnnotation,
                NullableFlowState.NotNull => NullableAnnotation.NotAnnotated,
                NullableFlowState.MaybeNull => NullableAnnotation.Annotated,
                _ => local.Type.NullableAnnotation,
            }
        );
    }
}
