using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace.MoveTypeOut;

/// <summary>
/// The reasons a nested type cannot be moved out mechanically. Each is a sentence
/// for the log; the action is withheld when any applies.
/// Implements [REFACTOR-MOVE-TYPE-REFUSED].
/// </summary>
internal static class MoveTypeOutBlockers
{
    /// <summary>The first reason the move is refused, or null when it may go ahead.</summary>
    public static string? Find(MoveTypeOutTarget target, SemanticModel model, CancellationToken ct)
    {
        return IsPartial(target)
            ?? NameTaken(target, model)
            ?? FileExists(target)
            ?? UsesEnclosing(target, model, ct);
    }

    private static string? IsPartial(MoveTypeOutTarget target)
    {
        return target.Declaration.Modifiers.Any(SyntaxKind.PartialKeyword)
            ? $"'{target.Symbol.Name}' is partial; its other parts would stay behind"
            : null;
    }

    /// <summary>
    /// A type of the same name and arity visible where the moved one will be declared
    /// would capture every shortened reference.
    /// </summary>
    private static string? NameTaken(MoveTypeOutTarget target, SemanticModel model)
    {
        var position = OutermostDeclaration(target.Declaration).SpanStart;
        var clash = model
            .LookupNamespacesAndTypes(position, name: target.Symbol.Name)
            .OfType<INamedTypeSymbol>()
            .FirstOrDefault(type =>
                type.Arity == target.Symbol.Arity
                && !SymbolEqualityComparer.Default.Equals(type.OriginalDefinition, target.Symbol)
            );
        return clash is null
            ? null
            : $"a type named '{target.Symbol.Name}' is already visible in namespace "
                + $"'{target.Symbol.ContainingNamespace.ToDisplayString()}'";
    }

    private static string? FileExists(MoveTypeOutTarget target)
    {
        var taken = target.Document.Project.Documents.Any(document =>
            NativePaths.AreEqual(document.FilePath, target.FilePath)
        );
        return taken ? $"{target.FileName} already exists beside {target.Document.Name}" : null;
    }

    /// <summary>
    /// Every name the moved type binds to something of an enclosing type must survive
    /// the move: a type parameter cannot, nor can anything not reachable from outside.
    /// </summary>
    private static string? UsesEnclosing(
        MoveTypeOutTarget target,
        SemanticModel model,
        CancellationToken ct
    )
    {
        return target
            .Declaration.DescendantNodes()
            .OfType<SimpleNameSyntax>()
            .Select(name => Blocker(target, Bound(model, name, ct)))
            .FirstOrDefault(blocker => blocker is not null);
    }

    private static ISymbol? Bound(SemanticModel model, SimpleNameSyntax name, CancellationToken ct)
    {
        var info = model.GetSymbolInfo(name, ct);
        return info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
    }

    private static string? Blocker(MoveTypeOutTarget target, ISymbol? symbol)
    {
        return symbol switch
        {
            null => null,
            ITypeParameterSymbol parameter => TypeParameterBlocker(target, parameter),
            _ when target.IsInsideMoved(symbol) || !target.TouchesEnclosing(symbol) => null,
            _ => Hidden(symbol) is { } hidden ? HiddenBlocker(target, hidden) : null,
        };
    }

    private static string? TypeParameterBlocker(
        MoveTypeOutTarget target,
        ITypeParameterSymbol parameter
    )
    {
        return
            parameter.TypeParameterKind == TypeParameterKind.Type
            && parameter.ContainingType is { } owner
            && target.IsEnclosing(owner)
            ? $"'{target.Symbol.Name}' uses type parameter '{parameter.Name}' of '{owner.Name}'"
            : null;
    }

    /// <summary>
    /// The symbol itself, or the first of its containing types up to the namespace, that
    /// cannot be reached from namespace level.
    /// </summary>
    private static ISymbol? Hidden(ISymbol symbol)
    {
        for (
            var current = symbol;
            current is not null and not INamespaceSymbol;
            current = current.ContainingType
        )
        {
            if (
                current.DeclaredAccessibility
                is Accessibility.Private
                    or Accessibility.Protected
                    or Accessibility.ProtectedAndInternal
            )
            {
                return current;
            }
        }

        return null;
    }

    private static string HiddenBlocker(MoveTypeOutTarget target, ISymbol hidden)
    {
        var owner = hidden.ContainingType?.Name ?? target.Container.Name;
        var accessibility = SyntaxFacts.GetText(hidden.DeclaredAccessibility);
        return $"'{target.Symbol.Name}' uses '{owner}.{hidden.Name}', which is {accessibility}";
    }

    /// <summary>The top-level declaration that holds <paramref name="declaration"/>.</summary>
    internal static BaseTypeDeclarationSyntax OutermostDeclaration(
        BaseTypeDeclarationSyntax declaration
    )
    {
        var outermost = declaration;
        for (
            var parent = declaration.Parent;
            parent is BaseTypeDeclarationSyntax enclosing;
            parent = parent.Parent
        )
        {
            outermost = enclosing;
        }

        return outermost;
    }
}
