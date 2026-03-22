using System.Collections.Concurrent;
using System.Reflection.Metadata;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.ProjectDecompiler;
using ICSharpCode.Decompiler.TypeSystem;
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
    public static LocationResult? ResolveMetadataSymbol(ISymbol symbol)
    {
        try
        {
            return ResolveMetadataSymbolCore(symbol);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"[MetadataNav] Decompilation failed: {ex.Message}");
            return null;
        }
    }

    private static LocationResult? ResolveMetadataSymbolCore(ISymbol symbol)
    {
        var assemblyPath = GetAssemblyPath(symbol);
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

        if (string.IsNullOrEmpty(filePath))
        {
            return null;
        }

        return FindSymbolInDecompiledSource(filePath, symbol);
    }

    /// <summary>Get the assembly file path for a metadata symbol.</summary>
    private static string? GetAssemblyPath(ISymbol symbol)
    {
        var metadataRef = symbol.ContainingAssembly?.MetadataReferences()
            .OfType<PortableExecutableReference>()
            .FirstOrDefault();

        return metadataRef?.FilePath;
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
        var fullTypeName = new FullTypeName(typeName);

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
        Directory.CreateDirectory(dir);

        var safeName = type.ToDisplayString()
            .Replace('<', '_')
            .Replace('>', '_')
            .Replace(',', '_')
            .Replace(' ', '_')
            .Replace(':', '_');

        var filePath = Path.Combine(dir, $"{safeName}.cs");
        File.WriteAllText(filePath, source);

        Console.Error.WriteLine(
            $"[MetadataNav] Wrote decompiled source to {filePath}");

        return filePath;
    }

    /// <summary>
    /// Find a symbol's position within decompiled source.
    /// Uses the symbol name to locate the declaration line.
    /// </summary>
    private static LocationResult? FindSymbolInDecompiledSource(
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

    private static LocationResult? FindSymbolInDecompiledSourceCore(
        string filePath,
        ISymbol symbol)
    {
        var lines = File.ReadAllLines(filePath);
        var name = symbol.MetadataName;

        var pattern = BuildSearchPattern(symbol, name);
        var position = SearchLines(lines, pattern, name);

        if (position is not null)
        {
            return new LocationResult
            {
                FilePath = filePath,
                Line = position.Value.line,
                Character = position.Value.column,
                EndLine = position.Value.line,
                EndCharacter = position.Value.column + name.Length,
            };
        }

        return FallbackLocation(filePath);
    }

    /// <summary>Build a search pattern based on the symbol kind.</summary>
    private static string? BuildSearchPattern(ISymbol symbol, string name)
    {
        return symbol switch
        {
            IMethodSymbol method when method.MethodKind
                is MethodKind.Constructor => "(" + name.Split('`')[0] + "(",
            IMethodSymbol => " " + name.Split('`')[0] + "(",
            IPropertySymbol => " " + name + " ",
            IFieldSymbol => " " + name + ";",
            IEventSymbol => " " + name + ";",
            INamedTypeSymbol => " " + name.Split('`')[0] + " ",
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
        var plainName = name.Split('`')[0];

        // First pass: try the specific pattern.
        if (pattern is not null)
        {
            var result = SearchLinesForPattern(lines, pattern);
            if (result is not null)
            {
                return result;
            }
        }

        // Second pass: fall back to plain name.
        return SearchLinesForName(lines, plainName);
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
            var col = lines[i].IndexOf(name, StringComparison.Ordinal);
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
