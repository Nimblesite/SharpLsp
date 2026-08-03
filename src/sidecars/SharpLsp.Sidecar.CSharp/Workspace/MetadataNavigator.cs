using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Maps a Roslyn metadata symbol to a decompiled source location for
/// go-to-definition navigation. The decompilation itself lives in the shared
/// <see cref="MetadataDecompiler"/> so the C# and F# sidecars produce
/// metadata-as-source the same way.
/// </summary>
internal static class MetadataNavigator
{
    /// <summary>
    /// Try to resolve a metadata symbol to a decompiled source location.
    /// Returns null if decompilation fails or the symbol cannot be found.
    /// </summary>
    public static LocationResult? ResolveMetadataSymbol(ISymbol symbol, Compilation compilation)
    {
        var assemblyPath = GetAssemblyPath(symbol, compilation);
        if (assemblyPath is null)
        {
            return null;
        }

        var containingType = GetContainingType(symbol);
        if (containingType is null)
        {
            return null;
        }

        var typeName = BuildDecompilerTypeName(containingType);
        var displayName = containingType.ToDisplayString();
        var filePath = MetadataDecompiler.DecompileTypeToFile(assemblyPath, typeName, displayName);
        if (string.IsNullOrEmpty(filePath))
        {
            return null;
        }

        var name = symbol.MetadataName;
        var position = MetadataDecompiler.FindDeclaration(
            filePath,
            name,
            BuildSearchPattern(symbol, name)
        );

        return new LocationResult
        {
            FilePath = filePath,
            Line = position.Line,
            Character = position.Character,
            EndLine = position.Line,
            EndCharacter = position.Character + name.Length,
        };
    }

    /// <summary>
    /// Get the assembly file path for a metadata symbol by matching its
    /// containing assembly identity against the compilation's references.
    /// </summary>
    private static string? GetAssemblyPath(ISymbol symbol, Compilation compilation)
    {
        var assemblyIdentity = symbol.ContainingAssembly?.Identity;
        return assemblyIdentity is null
            ? null
            : FindMatchingReference(compilation, assemblyIdentity);
    }

    private static string? FindMatchingReference(Compilation compilation, AssemblyIdentity target)
    {
        foreach (var reference in compilation.References)
        {
            if (reference is not PortableExecutableReference peRef)
            {
                continue;
            }

            var refSymbol = compilation.GetAssemblyOrModuleSymbol(reference);
            if (
                refSymbol is IAssemblySymbol asm
                && string.Equals(asm.Identity.Name, target.Name, StringComparison.OrdinalIgnoreCase)
            )
            {
                return peRef.FilePath;
            }
        }

        return null;
    }

    /// <summary>
    /// Get the top-level containing type for a symbol.
    /// For nested types, walks up to the outermost type.
    /// </summary>
    private static INamedTypeSymbol? GetContainingType(ISymbol symbol)
    {
        var type = symbol as INamedTypeSymbol ?? symbol.ContainingType;
        if (type is null)
        {
            return null;
        }

        while (type.ContainingType is not null)
        {
            type = type.ContainingType;
        }

        return type;
    }

    /// <summary>
    /// Build the type name in the format ICSharpCode.Decompiler expects:
    /// Namespace.TypeName (using metadata name with arity suffix).
    /// </summary>
    private static string BuildDecompilerTypeName(INamedTypeSymbol containingType)
    {
        var ns = containingType.ContainingNamespace?.ToDisplayString();
        var metadataName = containingType.MetadataName;

        return string.IsNullOrEmpty(ns) ? metadataName : $"{ns}.{metadataName}";
    }

    /// <summary>Build a search pattern based on the symbol kind.</summary>
    private static string? BuildSearchPattern(ISymbol symbol, string name)
    {
        var plainName = name.Split('`')[0];
        return symbol switch
        {
            IMethodSymbol { MethodKind: MethodKind.Constructor } => $"{plainName}(",
            IMethodSymbol => $" {plainName}(",
            IPropertySymbol => $" {plainName} ",
            IFieldSymbol => $" {plainName}",
            IEventSymbol => $" {plainName}",
            INamedTypeSymbol => $" {plainName}",
            _ => null,
        };
    }
}
