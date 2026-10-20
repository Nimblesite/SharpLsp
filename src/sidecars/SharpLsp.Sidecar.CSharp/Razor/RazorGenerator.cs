using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Serilog;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Keep an SDK generator that can run on this Roslyn; replace a newer one before it loads.
/// Implements [RAZOR-ARCHITECTURE-GENERATOR]. Metadata inspection never loads the SDK assembly.
/// </summary>
internal static class RazorGenerator
{
    private const string Compiler = "Microsoft.CodeAnalysis.Razor.Compiler.dll";
    private static readonly string[] Files =
    [
        Compiler,
        "Microsoft.AspNetCore.Razor.Utilities.Shared.dll",
        "Microsoft.Extensions.ObjectPool.dll",
    ];

    public static ProjectInfo Compatible(ProjectInfo project)
    {
        try
        {
            return Inspect(project);
        }
        catch (Exception error)
        {
            Log.Warning(
                "[Razor] Generator inspection failed for {Project}: {ExceptionType}",
                project.Name,
                error.GetType().Name
            );
            return project;
        }
    }

    private static ProjectInfo Inspect(ProjectInfo project)
    {
        var compiler = project.AnalyzerReferences.FirstOrDefault(reference =>
            reference.FullPath is { } path && NativePaths.SameName(path, Compiler)
        );
        var required = compiler?.FullPath is { } path ? RequiredVersion(path) : null;
        var running = typeof(Compilation).Assembly.GetName().Version;
        if (required is null || required <= running)
        {
            return project;
        }
        Log.Warning(
            "[Razor] Generator requires Roslyn {RequiredVersion}; using bundled compiler for {RuntimeVersion} in {Project}",
            required,
            running,
            project.Name
        );
        return project.WithAnalyzerReferences(Bundled(project.AnalyzerReferences));
    }

    private static Version? RequiredVersion(string path)
    {
        using var stream = File.OpenRead(path);
        using var image = new PEReader(stream);
        var metadata = image.GetMetadataReader();
        return metadata
            .AssemblyReferences.Select(metadata.GetAssemblyReference)
            .Where(reference => metadata.GetString(reference.Name) == "Microsoft.CodeAnalysis")
            .Select(reference => reference.Version)
            .FirstOrDefault();
    }

    private static IEnumerable<AnalyzerReference> Bundled(
        IReadOnlyList<AnalyzerReference> references
    )
    {
        // Referencing this public type loads our compiler first. Roslyn cannot stand it in
        // for a newer SDK assembly once the SDK assembly has already won the load.
        var directory = NativePaths.DirectoryOf(typeof(RazorProjectEngine).Assembly.Location);
        return references.Select(reference =>
            reference is AnalyzerFileReference { FullPath: { } path } fileReference
            && Files.Any(file => NativePaths.SameName(path, file))
                ? new AnalyzerFileReference(
                    NativePaths.Join(directory, NativePaths.NameOf(path)),
                    fileReference.AssemblyLoader
                )
                : reference
        );
    }
}
