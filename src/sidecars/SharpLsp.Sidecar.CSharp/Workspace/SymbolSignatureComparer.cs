using System.Collections.Immutable;
using Microsoft.CodeAnalysis;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>Compares overload signatures for Roslyn rename and override operations.</summary>
internal static class SymbolSignatureComparer
{
    // Implements [RENAME-CSHARP] and [REFACTOR-OVERRIDE-HEADLESS].
    internal static bool SameMethod(IMethodSymbol left, IMethodSymbol right)
    {
        return left.Arity == right.Arity && SameParameters(left.Parameters, right.Parameters);
    }

    internal static bool SameProperty(IPropertySymbol left, IPropertySymbol right)
    {
        return left.IsIndexer == right.IsIndexer
            && SameParameters(left.Parameters, right.Parameters);
    }

    private static bool SameParameters(
        ImmutableArray<IParameterSymbol> left,
        ImmutableArray<IParameterSymbol> right
    )
    {
        return left.Length == right.Length
            && left.Zip(right).All(pair => SameParameter(pair.First, pair.Second));
    }

    private static bool SameParameter(IParameterSymbol left, IParameterSymbol right)
    {
        // C# overloads cannot differ only by ref/out/in (CS0663).
        var byReference = left.RefKind != RefKind.None;
        return byReference == (right.RefKind != RefKind.None) && SameType(left.Type, right.Type);
    }

    // dynamic and object share one runtime signature (CS0111).
    private static bool IsObject(ITypeSymbol type)
    {
        return type.TypeKind == TypeKind.Dynamic || type.SpecialType == SpecialType.System_Object;
    }

    private static bool SameType(ITypeSymbol left, ITypeSymbol right)
    {
        return SymbolEqualityComparer.Default.Equals(left, right)
            || (IsObject(left) && IsObject(right))
            || (left, right) switch
            {
                (ITypeParameterSymbol a, ITypeParameterSymbol b) => SameTypeParameter(a, b),
                (IArrayTypeSymbol a, IArrayTypeSymbol b) => a.Rank == b.Rank
                    && SameType(a.ElementType, b.ElementType),
                (IPointerTypeSymbol a, IPointerTypeSymbol b) => SameType(
                    a.PointedAtType,
                    b.PointedAtType
                ),
                (INamedTypeSymbol a, INamedTypeSymbol b) => SameNamedType(a, b),
                _ => false,
            };
    }

    private static bool SameTypeParameter(ITypeParameterSymbol left, ITypeParameterSymbol right)
    {
        return left.TypeParameterKind == right.TypeParameterKind && left.Ordinal == right.Ordinal;
    }

    private static bool SameNamedType(INamedTypeSymbol left, INamedTypeSymbol right)
    {
        return SymbolEqualityComparer.Default.Equals(
                left.OriginalDefinition,
                right.OriginalDefinition
            )
            && left.TypeArguments.Length == right.TypeArguments.Length
            && left.TypeArguments.Zip(right.TypeArguments)
                .All(pair => SameType(pair.First, pair.Second));
    }
}
