using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// C# signature help: every overload the call around the caret could bind to,
/// the one it binds to, and the parameter the caret is filling. Built from the
/// semantic model directly, because Roslyn's own signature-help providers are
/// MEF components a headless workspace does not have.
/// Implements [SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP] (GitHub #174).
/// </summary>
internal static class SignatureHelpResolver
{
    private const SymbolDisplayMiscellaneousOptions TypeOptions =
        SymbolDisplayMiscellaneousOptions.UseSpecialTypes
        | SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier;

    private static readonly SymbolDisplayFormat TypeFormat = new(
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        miscellaneousOptions: TypeOptions
    );

    private static readonly SymbolDisplayFormat ParameterFormat = new(
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType
            | SymbolDisplayParameterOptions.IncludeName
            | SymbolDisplayParameterOptions.IncludeParamsRefOut
            | SymbolDisplayParameterOptions.IncludeDefaultValue,
        miscellaneousOptions: TypeOptions
    );

    public static async Task<SignatureHelpResult?> ResolveAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        if (root is null || model is null)
        {
            return null;
        }

        var position = text.Lines.GetPosition(new LinePosition(line, character));
        var arguments = EnclosingArgumentList(root, position);
        return arguments is null ? null : Build(model, arguments, position);
    }

    /// <summary>
    /// The innermost argument list the caret sits inside. The token LEFT of the
    /// caret is the one being typed after — the <c>(</c> or <c>,</c> — while the
    /// token at the caret may already belong to whatever follows an unfinished
    /// call.
    /// </summary>
    private static ArgumentListSyntax? EnclosingArgumentList(SyntaxNode root, int position)
    {
        return root.FindToken(Math.Max(0, position - 1))
            .Parent?.AncestorsAndSelf()
            .OfType<ArgumentListSyntax>()
            .FirstOrDefault(list => Inside(list, position));
    }

    /// <summary>After the <c>(</c>, and not past the <c>)</c> — if it is typed yet.</summary>
    private static bool Inside(ArgumentListSyntax list, int position)
    {
        return list.OpenParenToken.Span.End <= position
            && (list.CloseParenToken.IsMissing || position <= list.CloseParenToken.SpanStart);
    }

    private static SignatureHelpResult? Build(
        SemanticModel model,
        ArgumentListSyntax arguments,
        int position
    )
    {
        var methods = Candidates(model, arguments)
            .Where(method => model.IsAccessible(position, method))
            .ToImmutableArray();
        if (methods.IsEmpty)
        {
            return null;
        }

        var active = ActiveSignature(model, arguments, methods);
        return new SignatureHelpResult
        {
            Signatures = [.. methods.Select(Signature)],
            ActiveSignature = active,
            ActiveParameter = ActiveParameter(arguments, methods[active], position),
        };
    }

    /// <summary>What the argument list could call: a method group, a delegate, or constructors.</summary>
    private static ImmutableArray<IMethodSymbol> Candidates(
        SemanticModel model,
        ArgumentListSyntax arguments
    )
    {
        return arguments.Parent switch
        {
            InvocationExpressionSyntax call => Invoked(model, call),
            BaseObjectCreationExpressionSyntax creation => Constructors(model, creation),
            ConstructorInitializerSyntax initializer => Methods(model.GetMemberGroup(initializer)),
            _ => [],
        };
    }

    private static ImmutableArray<IMethodSymbol> Invoked(
        SemanticModel model,
        InvocationExpressionSyntax call
    )
    {
        var group = Methods(model.GetMemberGroup(call.Expression));
        if (!group.IsEmpty)
        {
            return group;
        }

        // A delegate value is called, not a method group: offer its Invoke.
        return
            model.GetTypeInfo(call.Expression).Type
                is INamedTypeSymbol { DelegateInvokeMethod: { } invoke }
            ? [invoke]
            : [];
    }

    private static ImmutableArray<IMethodSymbol> Constructors(
        SemanticModel model,
        BaseObjectCreationExpressionSyntax creation
    )
    {
        return model.GetTypeInfo(creation).Type is INamedTypeSymbol type
            ? type.InstanceConstructors
            : [];
    }

    private static ImmutableArray<IMethodSymbol> Methods(ImmutableArray<ISymbol> group)
    {
        return [.. group.OfType<IMethodSymbol>()];
    }

    /// <summary>
    /// The overload the call binds to; while it binds to none, the first that
    /// takes as many arguments as are typed.
    /// </summary>
    private static int ActiveSignature(
        SemanticModel model,
        ArgumentListSyntax arguments,
        ImmutableArray<IMethodSymbol> methods
    )
    {
        var bound = arguments.Parent is { } call ? model.GetSymbolInfo(call).Symbol : null;
        var match = methods.FirstOrDefault(method => SameOverload(method, bound));
        return match is not null
            ? methods.IndexOf(match)
            : FirstThatFits(methods, arguments.Arguments.Count);
    }

    private static bool SameOverload(IMethodSymbol method, ISymbol? bound)
    {
        return bound is IMethodSymbol target
            && SymbolEqualityComparer.Default.Equals(
                method.OriginalDefinition,
                target.OriginalDefinition
            );
    }

    private static int FirstThatFits(ImmutableArray<IMethodSymbol> methods, int argumentCount)
    {
        var fits = methods.FirstOrDefault(method => method.Parameters.Length >= argumentCount);
        return fits is null ? 0 : methods.IndexOf(fits);
    }

    /// <summary>
    /// The parameter the caret fills: the one a named argument names, else the
    /// argument's position — the last parameter for every extra argument of a
    /// <c>params</c> array.
    /// </summary>
    private static int ActiveParameter(
        ArgumentListSyntax arguments,
        IMethodSymbol method,
        int position
    )
    {
        var ordinal = arguments
            .Arguments.GetSeparators()
            .Count(comma => comma.SpanStart < position);
        var named =
            ordinal < arguments.Arguments.Count
                ? arguments.Arguments[ordinal].NameColon?.Name.Identifier.ValueText
                : null;
        var byName = named is null
            ? -1
            : method.Parameters.Select(parameter => parameter.Name).ToList().IndexOf(named);
        if (byName >= 0)
        {
            return byName;
        }

        var extraParamsArgument =
            method.Parameters is [.., { IsParams: true }] && ordinal >= method.Parameters.Length;
        return extraParamsArgument ? method.Parameters.Length - 1 : ordinal;
    }

    private static SignatureInfoResult Signature(IMethodSymbol method)
    {
        var parameters = method
            .Parameters.Select(parameter => parameter.ToDisplayString(ParameterFormat))
            .ToList();
        return new SignatureInfoResult
        {
            Label = $"{Callee(method)}({string.Join(", ", parameters)})",
            Parameters = parameters,
        };
    }

    /// <summary>What the label calls: <c>Point</c>, <c>string Func&lt;int, string&gt;</c>, <c>void Console.WriteLine</c>.</summary>
    private static string Callee(IMethodSymbol method)
    {
        var owner = method.ContainingType.ToDisplayString(TypeFormat);
        var returns = method.ReturnType.ToDisplayString(TypeFormat);
        return method.MethodKind is MethodKind.Constructor ? owner
            : method.MethodKind is MethodKind.DelegateInvoke ? $"{returns} {owner}"
            : $"{returns} {owner}.{method.Name}{TypeParameters(method)}";
    }

    private static string TypeParameters(IMethodSymbol method)
    {
        return method.IsGenericMethod
            ? $"<{string.Join(", ", method.TypeParameters.Select(parameter => parameter.Name))}>"
            : "";
    }
}
