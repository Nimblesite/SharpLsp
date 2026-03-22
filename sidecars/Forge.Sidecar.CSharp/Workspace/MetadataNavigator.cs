using System.Collections.Concurrent;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using Microsoft.CodeAnalysis;

namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Decompiles metadata symbols for go-to-definition navigation.
/// Caches decompiled source to avoid repeated decompilation of the same type.
/// </summary>
internal static class MetadataNavigator
{
    /// <summary>Cache key: (assemblyPath, typeFullName) -> temp file path.</summary>
    private static readonly ConcurrentDictionary<string, string> Cache = new();

    /// <summary>
    /// Try to resolve a metadata symbol to a decompiled source location.
    /// Returns null if decompilation fails or the symbol cannot be found.
    /// </summary>
    public static LocationResult? ResolveMetadataSymbol(
        ISymbol symbol,
        Compilation compilation)
    {
        try
        {
            return ResolveMetadataSymbolCore(symbol, compilation);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[MetadataNav] Decompilation failed: {ex.Message}");
            return null;
        }
    }

    private static LocationResult? ResolveMetadataSymbolCore(
        ISymbol symbol,
        Compilation compilation)
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

        var typeFullName = containingType.ToDisplayString(
            SymbolDisplayFormat.FullyQualifiedFormat);
        var cacheKey = $"{assemblyPath}|{typeFullName}";

        var filePath = Cache.GetOrAdd(
            cacheKey, _ => DecompileType(assemblyPath, containingType));

        return string.IsNullOrEmpty(filePath)
            ? null
            : FindSymbolInDecompiledSource(filePath, symbol);
    }

    /// <summary>
    /// Get the assembly file path for a metadata symbol by matching its
    /// containing assembly identity against the compilation's references.
    /// </summary>
    private static string? GetAssemblyPath(
        ISymbol symbol,
        Compilation compilation)
    {
        var assemblyIdentity = symbol.ContainingAssembly?.Identity;
        return assemblyIdentity is null
            ? null
            : FindMatchingReference(compilation, assemblyIdentity);
    }

    private static string? FindMatchingReference(
        Compilation compilation,
        AssemblyIdentity target)
    {
        foreach (var reference in compilation.References)
        {
            if (reference is not PortableExecutableReference peRef)
            {
                continue;
            }

            var refSymbol = compilation.GetAssemblyOrModuleSymbol(reference);
            if (refSymbol is IAssemblySymbol asm
                && string.Equals(
                    asm.Identity.Name, target.Name,
                    StringComparison.OrdinalIgnoreCase))
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
    /// Decompile a type and write it to a temp file.
    /// Returns the temp file path, or empty string on failure.
    /// </summary>
    private static string DecompileType(
        string assemblyPath,
        INamedTypeSymbol containingType)
    {
        try
        {
            return DecompileTypeCore(assemblyPath, containingType);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[MetadataNav] DecompileType failed: {ex.Message}");
            return "";
        }
    }

    private static string DecompileTypeCore(
        string assemblyPath,
        INamedTypeSymbol containingType)
    {
        var decompiler = new CSharpDecompiler(
            assemblyPath,
            new DecompilerSettings
            {
                ThrowOnAssemblyResolveErrors = false,
            });

        var typeName = BuildDecompilerTypeName(containingType);
        var fullTypeName =
            new ICSharpCode.Decompiler.TypeSystem.FullTypeName(typeName);

        Console.Error.WriteLine(
            $"[MetadataNav] Decompiling {fullTypeName} from {assemblyPath}");

        var source = decompiler.DecompileTypeAsString(fullTypeName);
        return WriteToTempFile(containingType, source);
    }

    /// <summary>
    /// Build the type name in the format ICSharpCode.Decompiler expects:
    /// Namespace.TypeName (using metadata name with arity suffix).
    /// </summary>
    private static string BuildDecompilerTypeName(
        INamedTypeSymbol containingType)
    {
        var ns = containingType.ContainingNamespace?.ToDisplayString();
        var metadataName = containingType.MetadataName;

        return string.IsNullOrEmpty(ns)
            ? metadataName
            : $"{ns}.{metadataName}";
    }

    /// <summary>Write decompiled source to a temp file and return path.</summary>
    private static string WriteToTempFile(
        INamedTypeSymbol type,
        string source)
    {
        var dir = Path.Combine(
            Path.GetTempPath(), "forge-decompiled");
        _ = Directory.CreateDirectory(dir);

        var safeName = SanitizeFileName(type.ToDisplayString());
        var filePath = Path.Combine(dir, $"{safeName}.cs");
        File.WriteAllText(filePath, source);

        Console.Error.WriteLine(
            $"[MetadataNav] Wrote decompiled source to {filePath}");

        return filePath;
    }

    /// <summary>Replace characters not allowed in file names.</summary>
    private static string SanitizeFileName(string name)
    {
        return name
            .Replace('<', '_')
            .Replace('>', '_')
            .Replace(',', '_')
            .Replace(' ', '_')
            .Replace(':', '_');
    }

    /// <summary>
    /// Find a symbol's position within decompiled source.
    /// Uses the symbol name to locate the declaration line.
    /// </summary>
    private static LocationResult FindSymbolInDecompiledSource(
        string filePath,
        ISymbol symbol)
    {
        try
        {
            return FindSymbolInDecompiledSourceCore(filePath, symbol);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[MetadataNav] FindSymbol failed: {ex.Message}");
            return FallbackLocation(filePath);
        }
    }

    private static LocationResult FindSymbolInDecompiledSourceCore(
        string filePath,
        ISymbol symbol)
    {
        var lines = File.ReadAllLines(filePath);
        var name = symbol.MetadataName;
        var pattern = BuildSearchPattern(symbol, name);
        var position = SearchLines(lines, pattern, name);

        return position is not null
            ? new LocationResult
            {
                FilePath = filePath,
                Line = position.Value.line,
                Character = position.Value.column,
                EndLine = position.Value.line,
                EndCharacter = position.Value.column + name.Length,
            }
            : FallbackLocation(filePath);
    }

    /// <summary>Build a search pattern based on the symbol kind.</summary>
    private static string? BuildSearchPattern(ISymbol symbol, string name)
    {
        var plainName = name.Split('`')[0];
        return symbol switch
        {
            IMethodSymbol { MethodKind: MethodKind.Constructor }
                => $"{plainName}(",
            IMethodSymbol => $" {plainName}(",
            IPropertySymbol => $" {plainName} ",
            IFieldSymbol => $" {plainName}",
            IEventSymbol => $" {plainName}",
            INamedTypeSymbol => $" {plainName}",
            _ => null,
        };
    }

    /// <summary>
    /// Search lines for a pattern, falling back to plain name match.
    /// Returns (line, column) or null.
    /// </summary>
    private static (int line, int column)? SearchLines(
        string[] lines,
        string? pattern,
        string name)
    {
        if (pattern is not null)
        {
            var result = SearchLinesForPattern(lines, pattern);
            if (result is not null)
            {
                return result;
            }
        }

        return SearchLinesForName(lines, name.Split('`')[0]);
    }

    private static (int line, int column)? SearchLinesForPattern(
        string[] lines,
        string pattern)
    {
        for (var i = 0; i < lines.Length; i++)
        {
            var col = lines[i].IndexOf(
                pattern, StringComparison.Ordinal);
            if (col >= 0)
            {
                return (i, col + 1);
            }
        }

        return null;
    }

    private static (int line, int column)? SearchLinesForName(
        string[] lines,
        string name)
    {
        for (var i = 0; i < lines.Length; i++)
        {
            var col = lines[i].IndexOf(
                name, StringComparison.Ordinal);
            if (col >= 0)
            {
                return (i, col);
            }
        }

        return null;
    }

    /// <summary>Fall back to line 0, col 0 of the decompiled file.</summary>
    private static LocationResult FallbackLocation(string filePath)
    {
        return new LocationResult
        {
            FilePath = filePath,
            Line = 0,
            Character = 0,
            EndLine = 0,
            EndCharacter = 0,
        };
    }
}
