using System.Security.Cryptography;
using System.Text;
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
/// Implements [DEFINITION-CROSSLANG].
/// <para>
/// Every sidecar process on the machine decompiles into one temp directory, so
/// the disk is the cache: a type decompiles into a directory keyed by the
/// assembly build and the type, and is published by renaming a finished file
/// into place. Another process — the other language's sidecar, another editor
/// window — therefore never overwrites a different type's source, never trips a
/// sharing violation on the same one, and never reads a half-written file; a
/// file removed behind the cache is simply written again (GitHub #173).
/// </para>
/// </summary>
public static class MetadataDecompiler
{
    /// <summary>
    /// Decompile <paramref name="typeFullName"/> from <paramref name="assemblyPath"/>
    /// to a temp <c>.cs</c> file named after <paramref name="displayName"/>. Returns
    /// the file path, or <see langword="null"/> on failure. A type already on disk
    /// is reused rather than decompiled again.
    /// </summary>
    public static string? DecompileTypeToFile(
        string assemblyPath,
        string typeFullName,
        string displayName
    )
    {
        var target = DecompiledPath(assemblyPath, typeFullName, displayName);
        return
            target is not null
            && (File.Exists(target) || Publish(assemblyPath, typeFullName, target))
            ? target
            : null;
    }

    /// <summary>
    /// Where a type decompiles to: one directory per assembly build and type, so
    /// no two types — or two builds of one assembly — ever share a file, and a
    /// rebuilt assembly is decompiled afresh. <see langword="null"/> when the
    /// assembly is not on disk.
    /// </summary>
    private static string? DecompiledPath(
        string assemblyPath,
        string typeFullName,
        string displayName
    )
    {
        var assembly = new FileInfo(assemblyPath);
        if (!assembly.Exists)
        {
            return null;
        }

        var identity =
            $"{assembly.FullName}|{assembly.Length}|{assembly.LastWriteTimeUtc.Ticks}|{typeFullName}";
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)), 0, 8);
        var fileName = $"{NativePaths.SafeName(displayName)}.cs";
        return NativePaths.Temp("sharplsp-decompiled", key, fileName);
    }

    /// <summary>
    /// Decompile and publish to <paramref name="target"/>. True when the file is
    /// there afterwards — including when another process published it first.
    /// </summary>
    private static bool Publish(string assemblyPath, string typeFullName, string target)
    {
        try
        {
            Log.Debug(
                "[MetadataDecompiler] Decompiling {Type} from {Assembly}",
                typeFullName,
                assemblyPath
            );
            PublishAtomically(target, Decompile(assemblyPath, typeFullName));
            return true;
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "[MetadataDecompiler] Decompilation failed for {Type}", typeFullName);
            return File.Exists(target);
        }
    }

    private static readonly DecompilerSettings Settings = new()
    {
        ThrowOnAssemblyResolveErrors = false,
    };

    /// <summary>
    /// Decompile <paramref name="typeFullName"/> from the assembly that declares it:
    /// <paramref name="assemblyPath"/>, or the assembly a type forwarder there points
    /// to. FCS names the facade an assembly was compiled against (<c>netstandard.dll</c>
    /// for FSharp.Core's <c>string</c>), which only forwards the type to the runtime's
    /// <c>System.Private.CoreLib</c>; the decompiler reads type definitions from one
    /// module, so the forwarded-to file is opened in its place.
    /// </summary>
    private static string Decompile(string assemblyPath, string typeFullName)
    {
        var typeName = new FullTypeName(typeFullName);
        var decompiler = new CSharpDecompiler(assemblyPath, Settings);
        var declaring = DeclaringAssembly(decompiler, typeName) ?? assemblyPath;
        var declaringDecompiler = NativePaths.AreEqual(declaring, assemblyPath)
            ? decompiler
            : new CSharpDecompiler(declaring, Settings);
        return declaringDecompiler.DecompileTypeAsString(typeName);
    }

    /// <summary>The file whose module defines <paramref name="typeName"/>, through any forwarder; null when unresolved.</summary>
    private static string? DeclaringAssembly(CSharpDecompiler decompiler, FullTypeName typeName)
    {
        var declared = decompiler.TypeSystem.FindType(typeName).GetDefinition()?.ParentModule?.MetadataFile?.FileName;
        return string.IsNullOrEmpty(declared) ? null : declared;
    }

    /// <summary>
    /// Write to a private staging file beside <paramref name="target"/>, then
    /// rename it into place: a reader sees no file or the whole file, never a
    /// partial one. Losing the race to another process's identical file is
    /// success.
    /// </summary>
    internal static void PublishAtomically(string target, string source)
    {
        var directory = NativePaths.DirectoryOf(target) is { Length: > 0 } holder ? holder : NativePaths.Temp();
        _ = Directory.CreateDirectory(directory);
        var staging = NativePaths.Resolve(directory, $"{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(staging, source);
            MoveUnlessPublished(staging, target);
        }
        finally
        {
            // A no-op once the rename has consumed it.
            File.Delete(staging);
        }
    }

    private static void MoveUnlessPublished(string staging, string target)
    {
        try
        {
            File.Move(staging, target, overwrite: false);
            Log.Debug("[MetadataDecompiler] Published decompiled source to {FilePath}", target);
        }
        catch (IOException) when (File.Exists(target))
        {
            Log.Debug("[MetadataDecompiler] {FilePath} was published by another process", target);
        }
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

    private static DecompiledPosition? SearchLines(
        string[] lines,
        string? pattern,
        string plainName
    )
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
