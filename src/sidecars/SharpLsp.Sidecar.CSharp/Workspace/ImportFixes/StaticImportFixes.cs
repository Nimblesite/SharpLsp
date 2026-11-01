using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;

namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>
/// The static row: <c>using static N.C</c> for each static class whose static member, or type
/// whose nested type, the unresolved name would then bind to. Each candidate is checked by binding the use, qualified
/// with the type, speculatively in place, so only an import that resolves the use is offered.
/// Implements the static row of [REFACTOR-IMPORT-CSHARP].
/// </summary>
internal static class StaticImportFixes
{
    private const int Most = 3;

    /// <summary>The static classes each referenced assembly declares, kept as long as Roslyn keeps the assembly.</summary>
    private static readonly ConditionalWeakTable<
        IAssemblySymbol,
        IReadOnlyList<INamedTypeSymbol>
    > StaticClassesOf = [];

    /// <summary>Up to three static rows for <paramref name="subject"/>, by the type's full name.</summary>
    public static async Task<ImmutableArray<ImportFix>> OfferAsync(
        Document document,
        ImportSubject subject,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model is null || subject.Arity > 0)
        {
            return [];
        }
        var nested = await NestedContainersAsync(document, subject, ct).ConfigureAwait(false);
        return
        [
            .. MemberContainers(model.Compilation, subject.Text)
                .Concat(nested)
                .Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default)
                .Where(type => Importable(model.Compilation, type) && Binds(model, subject, type))
                .OrderBy(ImportNames.FullName, StringComparer.Ordinal)
                .Take(Most)
                .Select(type => Fix(document, type)),
        ];
    }

    /// <summary>
    /// The static classes, in source or metadata, that declare a static member named
    /// <paramref name="name"/>. Roslyn's declaration index is no member index — it finds
    /// <c>Vector128.Sqrt</c> but not <c>Math.Sqrt</c> — so the static classes are walked instead.
    /// </summary>
    private static IEnumerable<INamedTypeSymbol> MemberContainers(
        Compilation compilation,
        string name
    )
    {
        return compilation
            .SourceModule.ReferencedAssemblySymbols.SelectMany(assembly =>
                StaticClassesOf.GetValue(assembly, StaticClassesIn)
            )
            .Concat(StaticClassesIn(compilation.Assembly))
            .Where(type =>
                type.MemberNames.Contains(name) && type.GetMembers(name).Any(IsStaticallyImportable)
            );
    }

    private static IReadOnlyList<INamedTypeSymbol> StaticClassesIn(IAssemblySymbol assembly)
    {
        return [.. TypesIn(assembly.GlobalNamespace).Where(type => type.IsStatic)];
    }

    private static IEnumerable<INamedTypeSymbol> TypesIn(INamespaceSymbol ns)
    {
        return ns.GetTypeMembers().Concat(ns.GetNamespaceMembers().SelectMany(TypesIn));
    }

    /// <summary>The types that declare a nested type named like the subject; Roslyn indexes every type.</summary>
    private static async Task<IEnumerable<INamedTypeSymbol>> NestedContainersAsync(
        Document document,
        ImportSubject subject,
        CancellationToken ct
    )
    {
        var declared = await SymbolFinder
            .FindDeclarationsAsync(
                document.Project,
                subject.Text,
                ignoreCase: false,
                SymbolFilter.Type,
                ct
            )
            .ConfigureAwait(false);
        return declared
            .OfType<INamedTypeSymbol>()
            .Select(type => type.ContainingType)
            .OfType<INamedTypeSymbol>();
    }

    private static bool Importable(Compilation compilation, INamedTypeSymbol type)
    {
        return type.Arity == 0
            && type.SpecialType != SpecialType.System_Object
            && compilation.IsSymbolAccessibleWithin(type, compilation.Assembly);
    }

    private static bool IsStaticallyImportable(ISymbol symbol)
    {
        return symbol switch
        {
            IMethodSymbol method => method.IsStatic
                && !method.IsExtensionMethod
                && method.MethodKind == MethodKind.Ordinary,
            IPropertySymbol or IFieldSymbol or IEventSymbol => symbol.IsStatic,
            _ => false,
        };
    }

    /// <summary>Whether the use binds once its name is qualified with <paramref name="type"/>.</summary>
    private static bool Binds(SemanticModel model, ImportSubject subject, INamedTypeSymbol type)
    {
        var container = SyntaxFactory.ParseName(ImportNames.FullName(type));
        var name = subject.Name.WithoutTrivia();
        if (SyntaxFacts.IsInTypeOnlyContext(subject.Name))
        {
            var asType = SyntaxFactory.QualifiedName(container, name);
            return Bound(model, subject, asType, SpeculativeBindingOption.BindAsTypeOrNamespace);
        }
        var access = SyntaxFactory.MemberAccessExpression(
            SyntaxKind.SimpleMemberAccessExpression,
            container,
            name
        );
        return Bound(
            model,
            subject,
            InPlace(subject, access),
            SpeculativeBindingOption.BindAsExpression
        );
    }

    /// <summary>The smallest expression around the name that decides what it binds to.</summary>
    private static ExpressionSyntax InPlace(ImportSubject subject, ExpressionSyntax qualified)
    {
        return subject.Name.Parent switch
        {
            InvocationExpressionSyntax call when call.Expression == subject.Name =>
                call.WithExpression(qualified),
            MemberAccessExpressionSyntax access when access.Expression == subject.Name =>
                access.WithExpression(qualified),
            _ => qualified,
        };
    }

    private static bool Bound(
        SemanticModel model,
        ImportSubject subject,
        ExpressionSyntax probe,
        SpeculativeBindingOption option
    )
    {
        return model.GetSpeculativeSymbolInfo(subject.Name.SpanStart, probe, option).Symbol
            is not null;
    }

    private static ImportFix Fix(Document document, INamedTypeSymbol type)
    {
        var fullName = ImportNames.FullName(type);
        var title = ImportTitles.Static(fullName);
        var directive = SyntaxFactory.UsingDirective(
            SyntaxFactory.Token(SyntaxKind.StaticKeyword),
            null,
            SyntaxFactory.ParseName(fullName)
        );
        return ImportFix.InReach(
            CodeAction.Create(title, ct => UsingInsertion.AddAsync(document, directive, ct), title)
        );
    }
}
