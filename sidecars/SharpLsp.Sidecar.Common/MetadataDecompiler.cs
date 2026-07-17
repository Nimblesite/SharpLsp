using System.Collections.Concurrent;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.TypeSystem;
using Serilog;

namespace SharpLsp.Sidecar.Common;

/// <summary>Position of a declaration within a decompiled source file (0-based).</summary>
public sealed record DecompiledPosition(int Line, int Character);

/// <summary>
/// Decompiles metadata types to navigable source and locates declarations within
/// the result. Shared by the C# and F# sidecars so metadata-as-source
/// navigation — into the BCL, NuGet dependencies, and the *other language's*
/// compiled assemblies (cross-language go-to-definition) — is implemented once.
/// Decompiled types are cached by (assembly, type) so repeat navigations reuse
/// the same temp file. Implements [DEFINITION-CROSSLANG].
/// </summary>
public static class MetadataDecompiler
{
    /// <summary>Cache key: <c>assemblyPath|typeFullName</c> -> temp file path.</summary>
    private static readonly ConcurrentDictionary<string, string> Cache = new(StringComparer.Ordinal);

    /// <summary>
    /// Decompile <paramref name="typeFullName"/> from <paramref name="assemblyPath"/>
    /// to a temp <c>.cs</c> file named after <paramref name="displayName"/>. Returns
    /// the file path, or <see langword="null"/> on failure. Results are cached.
    /// </summary>
    public static string? DecompileTypeToFile(
        string assemblyPath,
        string typeFullName,
        string displayName
    )
    {
        var cacheKey = $"{assemblyPath}|{typeFullName}";
        var filePath = Cache.GetOrAdd(
            cacheKey,
            _ => DecompileCore(assemblyPath, typeFullName, displayName)
        );
        return string.IsNullOrEmpty(filePath) ? null : filePath;
    }

    private static string DecompileCore(string assemblyPath, string typeFullName, string displayName)
    {
        try
        {
            var decompiler = new CSharpDecompiler(
                assemblyPath,
                new DecompilerSettings { ThrowOnAssemblyResolveErrors = false }
            );
            Log.Debug(
                "[MetadataDecompiler] Decompiling {Type} from {Assembly}",
                typeFullName,
                assemblyPath
            );
            var source = decompiler.DecompileTypeAsString(new FullTypeName(typeFullName));
            return WriteToTempFile(displayName, source);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "[MetadataDecompiler] Decompilation failed for {Type}", typeFullName);
            return "";
        }
    }

    private static string WriteToTempFile(string displayName, string source)
    {
        var dir = Path.Combine(Path.GetTempPath(), "sharplsp-decompiled");
        _ = Directory.CreateDirectory(dir);
        var filePath = Path.Combine(dir, $"{SanitizeFileName(displayName)}.cs");
        File.WriteAllText(filePath, source);
        Log.Debug("[MetadataDecompiler] Wrote decompiled source to {FilePath}", filePath);
        return filePath;
    }

    private static string SanitizeFileName(string name)
    {
        return name.Replace('<', '_')
            .Replace('>', '_')
            .Replace(',', '_')
            .Replace(' ', '_')
            .Replace(':', '_');
    }

    /// <summary>
    /// Locate a declaration in a decompiled file: search <paramref name="pattern"/>
    /// first (when supplied), then the plain <paramref name="name"/> (backtick arity
    /// suffix stripped). Falls back to line 0, column 0 when nothing matches so the
    /// caller still navigates to the file.
    /// </summary>
    public static DecompiledPosition FindDeclaration(string filePath, string name, string? pattern)
    {
        try
        {
            var lines = File.ReadAllLines(filePath);
            var plainName = name.Split('`')[0];
            return SearchLines(lines, pattern, plainName) ?? new DecompiledPosition(0, 0);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "[MetadataDecompiler] FindDeclaration failed in {File}", filePath);
            return new DecompiledPosition(0, 0);
        }
    }

    private static DecompiledPosition? SearchLines(string[] lines, string? pattern, string plainName)
    {
        if (pattern is not null)
        {
            var byPattern = SearchLines(lines, pattern, columnOffset: 1);
            if (byPattern is not null)
            {
                return byPattern;
            }
        }

        return SearchLines(lines, plainName, columnOffset: 0);
    }

    private static DecompiledPosition? SearchLines(string[] lines, string term, int columnOffset)
    {
        for (var i = 0; i < lines.Length; i++)
        {
            var column = lines[i].IndexOf(term, StringComparison.Ordinal);
            if (column >= 0)
            {
                return new DecompiledPosition(i, column + columnOffset);
            }
        }

        return null;
    }
}
