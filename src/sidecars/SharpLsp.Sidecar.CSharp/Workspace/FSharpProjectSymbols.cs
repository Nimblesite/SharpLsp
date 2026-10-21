using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Solutions;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Symbols a C# project reads from an F# project of the solution. C# sees an F# project only
/// as its built DLL ([DEFINITION-CROSSLANG]), so such a symbol is a metadata symbol whose
/// assembly is that DLL. Its identity, its assembly and XML doc signature, is the name the
/// F# sidecar finds it by, to navigate to its F# declaration, to find its F# uses and to
/// rename it there. Implements [DEFINITION-CROSSLANG-IDENTITY].
/// </summary>
internal static class FSharpProjectSymbols
{
    /// <summary>
    /// Whether <paramref name="symbol"/>, used in <paramref name="project"/>, is declared by an
    /// F# project that <paramref name="project"/> references: it has no source, and its
    /// assembly is that F# project's. Assembly names, not paths: a design-time build and
    /// <see cref="ProjectReferences.FindOutputAssembly"/> can spell one DLL's path apart.
    /// </summary>
    public static bool Declares(Project project, ISymbol symbol)
    {
        return !symbol.Locations.Any(location => location.IsInSource)
            && symbol.ContainingAssembly?.Name is { } assembly
            && FSharpAssembliesOf(project).Contains(assembly);
    }

    /// <summary>
    /// A metadata reference to <paramref name="dll"/>, with the XML documentation the build
    /// writes beside it, so hover shows an F# symbol's <c>///</c> comments. [RAZOR-FSHARP-METADATA]
    /// </summary>
    public static MetadataReference Reference(string dll)
    {
        var xml = NativePaths.WithExtension(dll, ".xml");
        return MetadataReference.CreateFromFile(
            dll,
            documentation: File.Exists(xml) ? XmlDocumentationProvider.CreateFromFile(xml) : null
        );
    }

    /// <summary>
    /// The identity the F# sidecar finds <paramref name="symbol"/> by, when an F# project
    /// declares it; null otherwise. A constructor is named by its type: F# declares a record's
    /// or union's constructor nowhere but in the type itself.
    /// </summary>
    public static RenameIdentityResultWire? IdentityOf(Project project, ISymbol symbol)
    {
        var named = symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor
            ? constructor.ContainingType
            : symbol;
        return Declares(project, named) ? Identity(named) : null;
    }

    /// <summary>
    /// <paramref name="projectId"/> reading the F# project's build output <paramref name="dll"/>,
    /// documented, in place of any reference of the same assembly: a design-time build hands C#
    /// the F# project's reference assembly (<c>obj/…/refint</c>), which has no XML documentation
    /// beside it. [RAZOR-FSHARP-METADATA]
    /// </summary>
    public static Solution WithDocumentedOutput(Solution solution, ProjectId projectId, string dll)
    {
        var stem = NativePaths.StemOf(dll);
        var stale = solution
            .GetProject(projectId)!
            .MetadataReferences.OfType<PortableExecutableReference>()
            .Where(reference =>
                reference.FilePath is { } path
                && NativePaths.SameName(NativePaths.StemOf(path), stem)
            )
            .ToList();
        return stale
            .Aggregate(
                solution,
                (current, reference) => current.RemoveMetadataReference(projectId, reference)
            )
            .AddMetadataReference(projectId, Reference(dll));
    }

    /// <summary>
    /// The assembly and XML doc signature both compilers give <paramref name="symbol"/>; none
    /// without either. FCS writes a method's signature without the <c>~ReturnType</c> Roslyn
    /// appends, which only a conversion operator needs to be told apart. [DEFINITION-CROSSLANG-IDENTITY]
    /// </summary>
    public static RenameIdentityResultWire Identity(ISymbol? symbol)
    {
        var assemblyName = symbol?.ContainingAssembly?.Name;
        var declared = symbol is null ? null : DocumentationCommentId.CreateDeclarationId(symbol);
        var xmlDocSig =
            symbol is IMethodSymbol { MethodKind: not MethodKind.Conversion }
            && declared?.IndexOf('~', StringComparison.Ordinal) is int at and >= 0
                ? declared[..at]
                : declared;
        return string.IsNullOrEmpty(assemblyName) || string.IsNullOrEmpty(xmlDocSig)
            ? new RenameIdentityResultWire()
            : new RenameIdentityResultWire
            {
                Found = true,
                AssemblyName = assemblyName,
                XmlDocSig = xmlDocSig,
            };
    }

    /// <summary><paramref name="location"/>, carrying the identity of the F# symbol it shows, if any.</summary>
    public static LocationResult Naming(LocationResult location, RenameIdentityResultWire? symbol)
    {
        return symbol is null
            ? location
            : new LocationResult
            {
                FilePath = location.FilePath,
                Line = location.Line,
                Character = location.Character,
                EndLine = location.EndLine,
                EndCharacter = location.EndCharacter,
                Symbol = symbol,
            };
    }

    /// <summary>The assembly name of each F# project <paramref name="project"/> references.</summary>
    private static HashSet<string> FSharpAssembliesOf(Project project)
    {
        return project.FilePath is null
            ? []
            :
            [
                .. ProjectReferences
                    .ReadReferencedProjects(project.FilePath)
                    .Where(referenced => NativePaths.HasExtension(referenced, ".fsproj"))
                    .Select(ProjectReferences.AssemblyNameOf),
            ];
    }
}
