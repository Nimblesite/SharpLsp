using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Generates overrides without Roslyn's editor-only member picker service.
/// </summary>
internal static class HeadlessOverrideCodeAction
{
    private const string Title = "Generate overrides...";

    public static async Task<CodeAction?> TryCreateAsync(
        Document document,
        TextSpan span,
        CancellationToken ct
    )
    {
        var plan = await CreatePlanAsync(document, span, ct).ConfigureAwait(false);
        return plan is null
            ? null
            : CodeAction.Create(Title, token => ApplyAsync(document, plan, token), Title);
    }

    private static async Task<OverridePlan?> CreatePlanAsync(
        Document document,
        TextSpan span,
        CancellationToken ct
    )
    {
        var declaration = await FindDeclarationAsync(document, span, ct).ConfigureAwait(false);
        return declaration is null
            ? null
            : await BuildPlanAsync(document, declaration, ct).ConfigureAwait(false);
    }

    private static async Task<TypeDeclarationSyntax?> FindDeclarationAsync(
        Document document,
        TextSpan span,
        CancellationToken ct
    )
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var declaration = root
            ?.FindToken(span.Start)
            .Parent?.AncestorsAndSelf()
            .OfType<TypeDeclarationSyntax>()
            .FirstOrDefault();
        return declaration is not null && SpansTouch(declaration.Identifier.Span, span)
            ? declaration
            : null;
    }

    private static async Task<OverridePlan?> BuildPlanAsync(
        Document document,
        TypeDeclarationSyntax declaration,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        return model is null ? null : BuildPlan(model, declaration, ct);
    }

    private static OverridePlan? BuildPlan(
        SemanticModel model,
        TypeDeclarationSyntax declaration,
        CancellationToken ct
    )
    {
        if (
            model.GetDeclaredSymbol(declaration, ct) is not INamedTypeSymbol target
            || model.Compilation.GetTypeByMetadataName("System.NotImplementedException")
                is not ITypeSymbol exceptionType
        )
        {
            return null;
        }

        var members = CollectCandidates(target, model.Compilation);
        return members.IsEmpty ? null : new(declaration, target, exceptionType, members);
    }

    private static ImmutableArray<ISymbol> CollectCandidates(
        INamedTypeSymbol target,
        Compilation compilation
    )
    {
        var occupied = target.GetMembers().Where(IsSlotMember).ToList();
        var candidates = ImmutableArray.CreateBuilder<ISymbol>();
        for (var baseType = target.BaseType; baseType is not null; baseType = baseType.BaseType)
        {
            if (!CollectFromBase(baseType, target, compilation, occupied, candidates))
            {
                return [];
            }
        }

        return candidates.ToImmutable();
    }

    private static bool CollectFromBase(
        INamedTypeSymbol baseType,
        INamedTypeSymbol target,
        Compilation compilation,
        List<ISymbol> occupied,
        ImmutableArray<ISymbol>.Builder candidates
    )
    {
        return OrderedMembers(baseType)
            .All(member => CollectCandidate(member, target, compilation, occupied, candidates));
    }

    private static bool CollectCandidate(
        ISymbol member,
        INamedTypeSymbol target,
        Compilation compilation,
        List<ISymbol> occupied,
        ImmutableArray<ISymbol>.Builder candidates
    )
    {
        if (!TryOccupy(member, occupied))
        {
            return true;
        }

        var required = IsOverrideCandidate(member);
        var supported = !required || CanGenerate(member, target, compilation);
        if (required && supported)
        {
            candidates.Add(member);
        }

        return supported;
    }

    private static bool TryOccupy(ISymbol member, List<ISymbol> occupied)
    {
        if (occupied.Any(existing => SameSignature(existing, member)))
        {
            return false;
        }

        occupied.Add(member);
        return true;
    }

    private static IEnumerable<ISymbol> OrderedMembers(INamedTypeSymbol baseType)
    {
        return baseType
            .GetMembers()
            .Where(IsSlotMember)
            .OrderBy(MemberKindOrder)
            .ThenBy(member => member.Name, StringComparer.Ordinal)
            .ThenBy(MemberDisplay, StringComparer.Ordinal);
    }

    private static int MemberKindOrder(ISymbol member)
    {
        return member switch
        {
            IMethodSymbol => 0,
            IPropertySymbol => 1,
            IEventSymbol => 2,
            _ => 3,
        };
    }

    private static string MemberDisplay(ISymbol member)
    {
        return member.ToDisplayString(SymbolDisplayFormat.CSharpErrorMessageFormat);
    }

    private static bool IsSlotMember(ISymbol member)
    {
        return member
            is IMethodSymbol { MethodKind: MethodKind.Ordinary }
                or IPropertySymbol
                or IEventSymbol;
    }

    private static bool CanGenerate(
        ISymbol member,
        INamedTypeSymbol target,
        Compilation compilation
    )
    {
        return compilation.IsSymbolAccessibleWithin(member, target)
            && HasAccessibleAccessors(member, target, compilation);
    }

    private static bool IsOverrideCandidate(ISymbol member)
    {
        return member.IsAbstract && !member.IsStatic && !member.IsSealed;
    }

    private static bool HasAccessibleAccessors(
        ISymbol member,
        INamedTypeSymbol target,
        Compilation compilation
    )
    {
        return member switch
        {
            IPropertySymbol property => AccessorAvailable(property.GetMethod, target, compilation)
                && AccessorAvailable(property.SetMethod, target, compilation),
            IEventSymbol @event => AccessorAvailable(@event.AddMethod, target, compilation)
                && AccessorAvailable(@event.RemoveMethod, target, compilation),
            _ => true,
        };
    }

    private static bool AccessorAvailable(
        IMethodSymbol? accessor,
        INamedTypeSymbol target,
        Compilation compilation
    )
    {
        return accessor is null || compilation.IsSymbolAccessibleWithin(accessor, target);
    }

    private static bool SameSignature(ISymbol left, ISymbol right)
    {
        return left.Kind == right.Kind
            && StringComparer.Ordinal.Equals(left.Name, right.Name)
            && (left, right) switch
            {
                (IMethodSymbol a, IMethodSymbol b) => SameMethodSignature(a, b),
                (IPropertySymbol a, IPropertySymbol b) => SamePropertySignature(a, b),
                (IEventSymbol, IEventSymbol) => true,
                _ => false,
            };
    }

    private static bool SameMethodSignature(IMethodSymbol left, IMethodSymbol right)
    {
        return left.Arity == right.Arity && SameParameters(left.Parameters, right.Parameters);
    }

    private static bool SamePropertySignature(IPropertySymbol left, IPropertySymbol right)
    {
        return left.IsIndexer == right.IsIndexer
            && SameParameters(left.Parameters, right.Parameters);
    }

    private static bool SameParameters(
        ImmutableArray<IParameterSymbol> left,
        ImmutableArray<IParameterSymbol> right
    )
    {
        return left.Length == right.Length
            && left.Zip(right).All(pair => SameParameter(pair.First, pair.Second));
    }

    private static bool SameParameter(IParameterSymbol left, IParameterSymbol right)
    {
        return left.RefKind == right.RefKind && SameType(left.Type, right.Type);
    }

    private static bool SameType(ITypeSymbol left, ITypeSymbol right)
    {
        return SymbolEqualityComparer.Default.Equals(left, right)
            || (left, right) switch
            {
                (ITypeParameterSymbol a, ITypeParameterSymbol b) => SameTypeParameter(a, b),
                (IArrayTypeSymbol a, IArrayTypeSymbol b) => a.Rank == b.Rank
                    && SameType(a.ElementType, b.ElementType),
                (IPointerTypeSymbol a, IPointerTypeSymbol b) => SameType(
                    a.PointedAtType,
                    b.PointedAtType
                ),
                (INamedTypeSymbol a, INamedTypeSymbol b) => SameNamedType(a, b),
                _ => false,
            };
    }

    private static bool SameTypeParameter(ITypeParameterSymbol left, ITypeParameterSymbol right)
    {
        return left.TypeParameterKind == right.TypeParameterKind && left.Ordinal == right.Ordinal;
    }

    private static bool SameNamedType(INamedTypeSymbol left, INamedTypeSymbol right)
    {
        return SymbolEqualityComparer.Default.Equals(
                left.OriginalDefinition,
                right.OriginalDefinition
            )
            && left.TypeArguments.Length == right.TypeArguments.Length
            && left.TypeArguments.Zip(right.TypeArguments)
                .All(pair => SameType(pair.First, pair.Second));
    }

    private static async Task<Solution> ApplyAsync(
        Document document,
        OverridePlan plan,
        CancellationToken ct
    )
    {
        var generator = SyntaxGenerator.GetGenerator(document);
        var annotation = new SyntaxAnnotation();
        var members = plan.Members.Select(member =>
            HeadlessOverrideSyntax.Generate(
                generator,
                member,
                plan.ExceptionType,
                plan.Target,
                annotation
            )
        );
        var replacement = generator.AddMembers(plan.Declaration, members);
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var changed = document.WithSyntaxRoot(root!.ReplaceNode(plan.Declaration, replacement));
        return await CleanDocumentAsync(changed, annotation, ct).ConfigureAwait(false);
    }

    private static async Task<Solution> CleanDocumentAsync(
        Document document,
        SyntaxAnnotation annotation,
        CancellationToken ct
    )
    {
        var simplified = await Simplifier
            .ReduceAsync(document, annotation, null, ct)
            .ConfigureAwait(false);
        var formatted = await Formatter
            .FormatAsync(simplified, annotation, null, ct)
            .ConfigureAwait(false);
        return formatted.Project.Solution;
    }

    private static bool SpansTouch(TextSpan candidate, TextSpan requested)
    {
        return requested.IsEmpty
            ? candidate.Contains(requested.Start) || candidate.Start == requested.Start
            : candidate.IntersectsWith(requested);
    }

    private sealed record OverridePlan(
        TypeDeclarationSyntax Declaration,
        INamedTypeSymbol Target,
        ITypeSymbol ExceptionType,
        ImmutableArray<ISymbol> Members
    );
}
