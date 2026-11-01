using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace.MoveTypeOut;

/// <summary>
/// The nested type one "Move out" action is about: its declaration, its symbol,
/// the chain of types enclosing it, and the file it moves to.
/// Implements [REFACTOR-MOVE-TYPE-OUT].
/// </summary>
internal sealed record MoveTypeOutTarget(
    Document Document,
    BaseTypeDeclarationSyntax Declaration,
    INamedTypeSymbol Symbol
)
{
    /// <summary>The type that directly contains the moved one.</summary>
    public INamedTypeSymbol Container => Symbol.ContainingType;

    /// <summary>Every type enclosing the moved one, innermost first.</summary>
    public ImmutableArray<INamedTypeSymbol> Enclosing { get; } = EnclosingTypes(Symbol);

    /// <summary>The new file's name: the type's, as Roslyn's own move names it.</summary>
    public string FileName => Symbol.Name + ".cs";

    /// <summary>The new file's path, beside the source file.</summary>
    public string FilePath =>
        NativePaths.Join(NativePaths.DirectoryOf(Document.FilePath ?? ""), FileName);

    public string Title => $"Move '{Symbol.Name}' out of '{Container.Name}' to {FileName}";

    /// <summary>The prefix of every failure the move reports.</summary>
    public string FailurePrefix =>
        $"Moving '{Symbol.Name}' out of '{Container.Name}' would not compile:";

    /// <summary>Whether <paramref name="type"/> is one of the types enclosing the moved one.</summary>
    public bool IsEnclosing(INamedTypeSymbol type)
    {
        return Enclosing.Any(enclosing =>
            SymbolEqualityComparer.Default.Equals(enclosing, type.OriginalDefinition)
        );
    }

    /// <summary>
    /// Whether <paramref name="symbol"/> is the moved type or declared somewhere inside it:
    /// such a symbol moves along, and is never a reason to refuse.
    /// </summary>
    public bool IsInsideMoved(ISymbol symbol)
    {
        for (var current = symbol; current is not null; current = current.ContainingType)
        {
            if (SymbolEqualityComparer.Default.Equals(current.OriginalDefinition, Symbol))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Whether <paramref name="symbol"/> belongs to an enclosing type: it is one, or a
    /// member or nested type of one, at any depth.
    /// </summary>
    public bool TouchesEnclosing(ISymbol symbol)
    {
        for (var current = symbol; current is not null; current = current.ContainingType)
        {
            if (current is INamedTypeSymbol type && IsEnclosing(type))
            {
                return true;
            }
        }

        return false;
    }

    private static ImmutableArray<INamedTypeSymbol> EnclosingTypes(INamedTypeSymbol symbol)
    {
        var builder = ImmutableArray.CreateBuilder<INamedTypeSymbol>();
        for (var type = symbol.ContainingType; type is not null; type = type.ContainingType)
        {
            builder.Add(type.OriginalDefinition);
        }

        return builder.ToImmutable();
    }
}
