using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves a C# script's <c>#r "assembly.dll"</c> against the directory of the file that
/// names it. A reference that is not there resolves to nothing, which the compiler reports as
/// CS0006 on the directive. Implements [SCRIPT-CSX-RESOLVERS].
/// </summary>
internal sealed class ScriptAssemblyResolver(string baseDirectory) : MetadataReferenceResolver
{
    public override ImmutableArray<PortableExecutableReference> ResolveReference(
        string reference,
        string? baseFilePath,
        MetadataReferenceProperties properties
    )
    {
        if (ScriptReferences.PackageOf(reference) is not null)
        {
            return [];
        }

        var directory = baseFilePath is null
            ? BaseDirectory
            : NativePaths.DirectoryOf(baseFilePath);
        var path = NativePaths.Resolve(directory, reference);
        return File.Exists(path) ? [MetadataReference.CreateFromFile(path, properties)] : [];
    }

    public override bool Equals(object? other)
    {
        return other is ScriptAssemblyResolver resolver
            && NativePaths.AreEqual(resolver.BaseDirectory, BaseDirectory);
    }

    public override int GetHashCode()
    {
        return NativePaths.Comparer.GetHashCode(BaseDirectory);
    }

    private string BaseDirectory { get; } = baseDirectory;
}

/// <summary>
/// What a C# script's <c>#r "nuget: …"</c> is told: scripts do not restore packages, so the
/// directive gets its own notice instead of the compiler's "metadata file could not be found",
/// which would describe a package as a missing file. Implements [SCRIPT-CSX-RESOLVERS].
/// </summary>
internal static class ScriptReferences
{
    /// <summary>The notice for a <c>#r "nuget: …"</c> a script cannot resolve.</summary>
    public const string NuGetReferenceCode = "SLSPC0003";

    /// <summary>The compiler's "metadata file could not be found".</summary>
    private const string MetadataFileNotFound = "CS0006";

    private const string NuGetPrefix = "nuget:";

    /// <summary>
    /// The package a <c>#r</c> value names when it is a NuGet reference
    /// (<c>nuget: Package, Version</c>); null for an assembly path.
    /// </summary>
    public static string? PackageOf(string reference)
    {
        var value = reference.TrimStart();
        if (!value.StartsWith(NuGetPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var package = value[NuGetPrefix.Length..].Split(',')[0].Trim();
        return package.Length == 0 ? "the package" : package;
    }

    /// <summary>
    /// The compiler's CS0006 for each <c>#r</c> of this script that resolved to nothing. It is
    /// a declaration diagnostic of the compilation, so a document's semantic model never
    /// carries it; without this an unresolved reference says nothing at all.
    /// </summary>
    public static IEnumerable<Diagnostic> Unresolved(SemanticModel model, CancellationToken ct)
    {
        return model.SyntaxTree.Options.Kind != SourceCodeKind.Script
            ? []
            : model
                .Compilation.GetDeclarationDiagnostics(ct)
                .Where(diagnostic =>
                    diagnostic.Id == MetadataFileNotFound
                    && diagnostic.Location.SourceTree == model.SyntaxTree
                );
    }

    /// <summary>
    /// Replace the compiler's CS0006 on each NuGet reference directive of
    /// <paramref name="root"/> with the notice that says what is actually wrong.
    /// </summary>
    public static void Explain(string filePath, SyntaxNode root, List<DiagnosticResult> diagnostics)
    {
        if (root is not CompilationUnitSyntax unit)
        {
            return;
        }

        foreach (var directive in unit.GetReferenceDirectives())
        {
            if (PackageOf(directive.File.ValueText) is { } package)
            {
                var span = directive.GetLocation().GetLineSpan().Span;
                _ = diagnostics.RemoveAll(diagnostic =>
                    diagnostic.Code == MetadataFileNotFound
                    && diagnostic.StartLine == span.Start.Line
                );
                diagnostics.Add(Notice(filePath, span, directive.File.ValueText.Trim(), package));
            }
        }
    }

    private static DiagnosticResult Notice(
        string filePath,
        Microsoft.CodeAnalysis.Text.LinePositionSpan span,
        string reference,
        string package
    )
    {
        return new DiagnosticResult(
            FilePath: filePath,
            StartLine: span.Start.Line,
            StartCharacter: span.Start.Character,
            EndLine: span.End.Line,
            EndCharacter: span.End.Character,
            Message: $"#r \"{reference}\" is not resolved: C# scripts do not restore NuGet packages yet, "
                + $"so symbols from {package} will not bind. Reference its assembly by path with #r, "
                + "or use a file-based app with #:package.",
            Severity: "Warning",
            Code: NuGetReferenceCode,
            HelpLink: "",
            Tags: []
        );
    }
}
