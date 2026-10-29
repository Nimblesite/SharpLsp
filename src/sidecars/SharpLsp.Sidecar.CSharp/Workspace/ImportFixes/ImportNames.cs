using Microsoft.CodeAnalysis;

namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>How the import fixes spell a symbol and a project. [REFACTOR-IMPORT]</summary>
internal static class ImportNames
{
    private static readonly SymbolDisplayFormat FullNameFormat =
        SymbolDisplayFormat.FullyQualifiedFormat.WithGlobalNamespaceStyle(
            SymbolDisplayGlobalNamespaceStyle.Omitted
        );

    /// <summary>The symbol's full name, namespace included, without <c>global::</c>.</summary>
    public static string FullName(ISymbol symbol)
    {
        return symbol.ToDisplayString(FullNameFormat);
    }

    /// <summary>The namespace that declares <paramref name="type"/>, or null for the global one.</summary>
    public static string? NamespaceOf(INamedTypeSymbol type)
    {
        return type.ContainingNamespace is { IsGlobalNamespace: false } ns ? FullName(ns) : null;
    }
}
