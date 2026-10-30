using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.FindSymbols;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Messages;
using SharpLsp.Sidecar.Common.References;

namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>
/// The rows for a name the project cannot reach yet: another C# project of the solution that
/// declares it, a package another project uses that ships it, or a well-known package. Each adds
/// <c>using N;</c> once the host has added the reference it carries. Implements the C# side of
/// [REFACTOR-IMPORT-REFERENCE].
/// </summary>
internal static class ReferenceImportFixes
{
    /// <summary>The reference rows for <paramref name="subject"/>: projects, then packages.</summary>
    public static async Task<ImmutableArray<ImportFix>> OfferAsync(
        Document document,
        ImportSubject subject,
        CancellationToken ct
    )
    {
        if (document.Project.FilePath is null)
        {
            return [];
        }
        var projects = await ProjectFixesAsync(document, subject, ct).ConfigureAwait(false);
        var packages = await PackageFixesAsync(document, subject, ct).ConfigureAwait(false);
        var used = packages
            .Select(fix => fix.Reference!.Reference)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var known =
            projects.IsEmpty && packages.IsEmpty ? WellKnownFixes(document, subject, used) : [];
        return [.. projects, .. packages, .. known];
    }

    // ── Another project of the solution ──────────────────────────────

    private static async Task<ImmutableArray<ImportFix>> ProjectFixesAsync(
        Document document,
        ImportSubject subject,
        CancellationToken ct
    )
    {
        var fixes = ImmutableArray.CreateBuilder<ImportFix>();
        foreach (var other in Referenceable(document.Project))
        {
            var types = await SymbolFinder
                .FindSourceDeclarationsAsync(
                    other,
                    name => name == subject.Text,
                    SymbolFilter.Type,
                    ct
                )
                .ConfigureAwait(false);
            fixes.AddRange(
                types
                    .OfType<INamedTypeSymbol>()
                    .Where(type => Fits(type, subject))
                    .Select(type => ProjectFix(document, other, type))
            );
        }
        return [.. fixes.DistinctBy(fix => fix.Action.Title)];
    }

    /// <summary>The other C# projects this one could reference without a cycle, one per project file.</summary>
    private static IEnumerable<Project> Referenceable(Project project)
    {
        var graph = project.Solution.GetProjectDependencyGraph();
        var reached = graph.GetProjectsThatThisProjectTransitivelyDependsOn(project.Id);
        return project
            .Solution.Projects.Where(other =>
                other.Id != project.Id
                && other.Language == LanguageNames.CSharp
                && other.FilePath is not null
                && !NativePaths.AreEqual(other.FilePath, project.FilePath)
                && !reached.Contains(other.Id)
                && !graph
                    .GetProjectsThatThisProjectTransitivelyDependsOn(other.Id)
                    .Contains(project.Id)
            )
            .DistinctBy(other => NativePaths.IdentityOf(other.FilePath!));
    }

    private static ImportFix ProjectFix(Document document, Project other, INamedTypeSymbol type)
    {
        var name = NativePaths.StemOf(other.FilePath!);
        var ns = ImportNames.NamespaceOf(type)!;
        var title = ImportTitles.Project(
            name,
            ProjectFileName(document),
            ns,
            ImportNames.FullName(type)
        );
        var reference = ReferenceImport.ToProject(document.Project.FilePath!, other.FilePath!);
        return new ImportFix(UsingAction(document, title, ns), reference, false);
    }

    // ── A package another project uses ───────────────────────────────

    private static async Task<ImmutableArray<ImportFix>> PackageFixesAsync(
        Document document,
        ImportSubject subject,
        CancellationToken ct
    )
    {
        var fixes = ImmutableArray.CreateBuilder<ImportFix>();
        foreach (
            var other in document.Project.Solution.Projects.Where(other =>
                Uses(document.Project, other)
            )
        )
        {
            fixes.AddRange(
                await PackageFixesInAsync(document, subject, other, ct).ConfigureAwait(false)
            );
        }
        return [.. fixes.DistinctBy(fix => fix.Action.Title)];
    }

    private static bool Uses(Project project, Project other)
    {
        return other.Id != project.Id
            && other.Language == LanguageNames.CSharp
            && other.FilePath is not null;
    }

    private static async Task<IEnumerable<ImportFix>> PackageFixesInAsync(
        Document document,
        ImportSubject subject,
        Project other,
        CancellationToken ct
    )
    {
        var compilation = await other.GetCompilationAsync(ct).ConfigureAwait(false);
        var types = await SymbolFinder
            .FindDeclarationsAsync(other, subject.Text, ignoreCase: false, SymbolFilter.Type, ct)
            .ConfigureAwait(false);
        return compilation is null
            ? []
            : types
                .OfType<INamedTypeSymbol>()
                .Where(type =>
                    Fits(type, subject) && type.Locations.All(location => location.IsInMetadata)
                )
                .Select(type => PackageFix(document, other, compilation, type))
                .OfType<ImportFix>();
    }

    private static ImportFix? PackageFix(
        Document document,
        Project other,
        Compilation compilation,
        INamedTypeSymbol type
    )
    {
        var path = (
            compilation.GetMetadataReference(type.ContainingAssembly) as PortableExecutableReference
        )?.FilePath;
        var package =
            path is null || Reaches(document.Project, path)
                ? null
                : PackageOfAssembly.Find(other.FilePath!, path);
        if (package is null)
        {
            return null;
        }
        var ns = ImportNames.NamespaceOf(type)!;
        var title = ImportTitles.SolutionPackage(
            package.Id,
            package.Version,
            ProjectFileName(document),
            NativePaths.NameOf(other.FilePath!),
            ns
        );
        var reference = ReferenceImport.ToPackage(
            document.Project.FilePath!,
            package.Id,
            package.Version
        );
        return new ImportFix(UsingAction(document, title, ns), reference, false);
    }

    /// <summary>Whether the project already compiles against the assembly at <paramref name="path"/>.</summary>
    private static bool Reaches(Project project, string path)
    {
        return project
            .MetadataReferences.OfType<PortableExecutableReference>()
            .Any(reference => reference.FilePath is { } own && NativePaths.AreEqual(own, path));
    }

    // ── A well-known package ─────────────────────────────────────────

    private static ImmutableArray<ImportFix> WellKnownFixes(
        Document document,
        ImportSubject subject,
        HashSet<string> used
    )
    {
        return
        [
            .. WellKnownPackages
                .Named(subject.Text)
                .Where(type => subject.Arity == 0 && !used.Contains(type.PackageId))
                .Select(type => WellKnownFix(document, type)),
        ];
    }

    private static ImportFix WellKnownFix(Document document, WellKnownType type)
    {
        var title = ImportTitles.WellKnownPackage(
            type.PackageId,
            ProjectFileName(document),
            type.Namespace
        );
        var reference = ReferenceImport.ToPackage(document.Project.FilePath!, type.PackageId, "");
        return new ImportFix(UsingAction(document, title, type.Namespace), reference, false);
    }

    // ── Shared ───────────────────────────────────────────────────────

    /// <summary>A public, top-level type in a namespace, with the subject's number of type arguments.</summary>
    private static bool Fits(INamedTypeSymbol type, ImportSubject subject)
    {
        return type.DeclaredAccessibility == Accessibility.Public
            && type.ContainingType is null
            && ImportNames.NamespaceOf(type) is not null
            && type.Arity == subject.Arity;
    }

    private static string ProjectFileName(Document document)
    {
        return NativePaths.NameOf(document.Project.FilePath!);
    }

    private static CodeAction UsingAction(Document document, string title, string ns)
    {
        var directive = SyntaxFactory.UsingDirective(SyntaxFactory.ParseName(ns));
        return CodeAction.Create(
            title,
            ct => UsingInsertion.AddAsync(document, directive, ct),
            title
        );
    }
}
