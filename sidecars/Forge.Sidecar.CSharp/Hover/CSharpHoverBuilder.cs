using Forge.Sidecar.Common.Hover;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using HoverQueryResult = Outcome.Result<Forge.Sidecar.CSharp.HoverResult?, string>;

namespace Forge.Sidecar.CSharp.Hover;

/// <summary>
/// Builds rich Markdown hover content for C# symbols using Roslyn.
/// </summary>
internal static class CSharpHoverBuilder
{
    private static readonly SymbolDisplayFormat SignatureFormat =
        new(
            globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
            typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
            genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters
                | SymbolDisplayGenericsOptions.IncludeTypeConstraints,
            memberOptions: SymbolDisplayMemberOptions.IncludeType
                | SymbolDisplayMemberOptions.IncludeParameters
                | SymbolDisplayMemberOptions.IncludeAccessibility
                | SymbolDisplayMemberOptions.IncludeModifiers
                | SymbolDisplayMemberOptions.IncludeRef
                | SymbolDisplayMemberOptions.IncludeContainingType,
            parameterOptions: SymbolDisplayParameterOptions.IncludeType
                | SymbolDisplayParameterOptions.IncludeName
                | SymbolDisplayParameterOptions.IncludeDefaultValue
                | SymbolDisplayParameterOptions.IncludeParamsRefOut,
            propertyStyle: SymbolDisplayPropertyStyle.ShowReadWriteDescriptor,
            kindOptions: SymbolDisplayKindOptions.IncludeTypeKeyword
                | SymbolDisplayKindOptions.IncludeMemberKeyword
                | SymbolDisplayKindOptions.IncludeNamespaceKeyword,
            miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes
                | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier
        );

    /// <summary>Build a hover result for the symbol at the given position.</summary>
    public static HoverQueryResult Build(SemanticModel model, int position, CancellationToken ct)
    {
        try
        {
            var root = model.SyntaxTree.GetRoot(ct);
            var token = root.FindToken(position);
            var result = token.IsKind(SyntaxKind.None) ? null : ResolveAndBuild(model, token, ct);
            return new HoverQueryResult.Ok<HoverResult?, string>(result);
        }
        catch (Exception ex)
        {
            return HoverQueryResult.Failure(ex.Message);
        }
    }

    private static HoverResult? ResolveAndBuild(
        SemanticModel model,
        SyntaxToken token,
        CancellationToken ct
    )
    {
        if (IsStringLiteral(token))
        {
            return null;
        }

        if (token.IsKind(SyntaxKind.VarKeyword))
        {
            return BuildVarHover(model, token, ct);
        }

        if (IsNumericLiteral(token))
        {
            return BuildTypeHover(model, token, "literal", ct);
        }

        var symbol = ResolveSymbol(model, token, ct);
        if (symbol is not null)
        {
            return BuildFromSymbol(symbol, token);
        }

        // Fallback: lambda params, tuple elements, pattern variables —
        // GetTypeInfo resolves the type when GetSymbolInfo can't.
        return BuildTypeHover(model, token, null, ct);
    }

    private static ISymbol? ResolveSymbol(
        SemanticModel model,
        SyntaxToken token,
        CancellationToken ct
    )
    {
        var parent = token.Parent;
        if (parent is null)
        {
            return null;
        }

        // For declarations (class, method, property, etc.), use
        // GetDeclaredSymbol. GetSymbolInfo only works for references.
        var declared = model.GetDeclaredSymbol(parent, ct);
        if (declared is not null)
        {
            return declared;
        }

        var symbolInfo = model.GetSymbolInfo(parent, ct);
        var symbol = symbolInfo.Symbol ?? symbolInfo.CandidateSymbols.FirstOrDefault();

        if (symbol is not null)
        {
            return symbol;
        }

        var typeInfo = model.GetTypeInfo(parent, ct);
        return typeInfo.Type;
    }

    private static HoverResult? BuildVarHover(
        SemanticModel model,
        SyntaxToken token,
        CancellationToken ct
    )
    {
        var declaration = token.Parent?.Parent;
        if (declaration is not VariableDeclarationSyntax varDecl)
        {
            return null;
        }

        var typeInfo = model.GetTypeInfo(varDecl.Type, ct);
        var type = typeInfo.Type;

        if (type is null or IErrorTypeSymbol)
        {
            return null;
        }

        var signature = type.ToDisplayString(SignatureFormat);
        var markdown = $"```csharp\n(inferred) {signature}\n```";
        return MakeResult(markdown, token);
    }

    private static HoverResult BuildFromSymbol(ISymbol symbol, SyntaxToken token)
    {
        var markdown = BuildMarkdown(symbol);
        return MakeResult(markdown, token);
    }

    private static string BuildMarkdown(ISymbol symbol)
    {
        var sb = new System.Text.StringBuilder();
        AppendSignature(sb, symbol);
        AppendContainingType(sb, symbol);
        AppendDeprecation(sb, symbol);
        AppendDocumentation(sb, symbol);
        return sb.ToString().TrimEnd();
    }

    private static void AppendSignature(System.Text.StringBuilder sb, ISymbol symbol)
    {
        var signature = symbol.ToDisplayString(SignatureFormat);
        _ = sb.AppendLine("```csharp");
        _ = sb.AppendLine(signature);
        _ = sb.AppendLine("```");
    }

    private static void AppendContainingType(System.Text.StringBuilder sb, ISymbol symbol)
    {
        if (symbol.ContainingType is null)
        {
            return;
        }

        if (symbol is IMethodSymbol or IPropertySymbol or IFieldSymbol or IEventSymbol)
        {
            var container = symbol.ContainingType.ToDisplayString(
                SymbolDisplayFormat.MinimallyQualifiedFormat
            );
            _ = sb.Append("*in* `").Append(container).Append('`').AppendLine();
        }
    }

    private static void AppendDeprecation(System.Text.StringBuilder sb, ISymbol symbol)
    {
        var obsolete = symbol.GetAttributes().FirstOrDefault(IsObsoleteAttribute);

        if (obsolete is null)
        {
            return;
        }

        var message =
            obsolete.ConstructorArguments.Length > 0
                ? obsolete.ConstructorArguments[0].Value?.ToString()
                : ExtractObsoleteMessageFromSyntax(obsolete);

        _ = sb.AppendLine();
        _ = sb.Append("**Deprecated**");
        if (message is not null)
        {
            _ = sb.Append(": ").Append(message);
        }

        _ = sb.AppendLine();
    }

    private static void AppendDocumentation(System.Text.StringBuilder sb, ISymbol symbol)
    {
        var xmlDoc = symbol.GetDocumentationCommentXml();
        var rendered = XmlDocRenderer.Render(xmlDoc);
        if (rendered.Length > 0)
        {
            _ = sb.AppendLine();
            _ = sb.Append(rendered);
        }
    }

    private static HoverResult MakeResult(string markdown, SyntaxToken token)
    {
        var span = token.GetLocation().GetMappedLineSpan();
        return new HoverResult
        {
            Contents = markdown,
            StartLine = span.StartLinePosition.Line,
            StartCharacter = span.StartLinePosition.Character,
            EndLine = span.EndLinePosition.Line,
            EndCharacter = span.EndLinePosition.Character,
        };
    }

    /// Build hover showing the inferred type (for literals, lambdas, tuples, patterns).
    private static HoverResult? BuildTypeHover(
        SemanticModel model,
        SyntaxToken token,
        string? prefix,
        CancellationToken ct
    )
    {
        var parent = token.Parent;
        if (parent is null)
        {
            return null;
        }

        var typeInfo = model.GetTypeInfo(parent, ct);
        var type = typeInfo.Type ?? typeInfo.ConvertedType;
        if (type is null or IErrorTypeSymbol)
        {
            return null;
        }

        var sig = type.ToDisplayString(SignatureFormat);
        var label = prefix is not null ? $"({prefix}) {sig}" : sig;
        var markdown = $"```csharp\n{label}\n```";
        return MakeResult(markdown, token);
    }

    private static bool IsStringLiteral(SyntaxToken token)
    {
        return token.IsKind(SyntaxKind.StringLiteralToken)
            || token.IsKind(SyntaxKind.InterpolatedStringTextToken)
            || token.IsKind(SyntaxKind.CharacterLiteralToken)
            || token.IsKind(SyntaxKind.Utf8StringLiteralToken);
    }

    private static bool IsNumericLiteral(SyntaxToken token)
    {
        return token.IsKind(SyntaxKind.NumericLiteralToken);
    }

    /// Fallback: extract the obsolete message from the attribute syntax tree
    /// when ConstructorArguments is empty (unresolved reference to System.ObsoleteAttribute).
    private static string? ExtractObsoleteMessageFromSyntax(AttributeData attr)
    {
        var args = (attr.ApplicationSyntaxReference?.GetSyntax() as AttributeSyntax)
            ?.ArgumentList
            ?.Arguments;
        return args is { Count: > 0 } && args.Value[0].Expression is LiteralExpressionSyntax literal
            ? literal.Token.ValueText
            : null;
    }

    private static bool IsObsoleteAttribute(AttributeData attr)
    {
        var name = attr.AttributeClass?.Name;
        return name is "ObsoleteAttribute" or "Obsolete";
    }
}
