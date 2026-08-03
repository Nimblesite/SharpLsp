using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Simplification;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Builds compile-safe C# declarations for the headless required-override action.
/// </summary>
internal static class HeadlessOverrideSyntax
{
    public static SyntaxNode Generate(
        SyntaxGenerator generator,
        ISymbol member,
        ITypeSymbol exceptionType,
        INamedTypeSymbol target,
        SyntaxAnnotation annotation
    )
    {
        var declaration = GenerateDeclaration(generator, member, exceptionType, target);
        return MarkOverride(generator, declaration, member, target)
            .WithAdditionalAnnotations(annotation, Simplifier.Annotation, Formatter.Annotation);
    }

    private static SyntaxNode GenerateDeclaration(
        SyntaxGenerator generator,
        ISymbol member,
        ITypeSymbol exceptionType,
        INamedTypeSymbol target
    )
    {
        return member switch
        {
            IMethodSymbol method => GenerateMethod(generator, method, exceptionType),
            IPropertySymbol property => GenerateProperty(
                generator,
                property,
                exceptionType,
                target
            ),
            IEventSymbol @event => GenerateEvent(generator, @event, exceptionType),
            _ => throw new InvalidOperationException($"Unsupported override member {member.Kind}"),
        };
    }

    private static MethodDeclarationSyntax GenerateMethod(
        SyntaxGenerator generator,
        IMethodSymbol method,
        ITypeSymbol exceptionType
    )
    {
        var statements = ThrowNotImplemented(generator, exceptionType).ToImmutableArray();
        var declaration = (MethodDeclarationSyntax)generator.MethodDeclaration(method, statements);
        var constrained = WithOverrideConstraints(declaration, method);
        return (MethodDeclarationSyntax)generator.WithStatements(constrained, statements);
    }

    private static MethodDeclarationSyntax WithOverrideConstraints(
        MethodDeclarationSyntax declaration,
        IMethodSymbol method
    )
    {
        var clauses = method
            .TypeParameters.Where(parameter => HasNullableUsage(parameter, method))
            .Select(OverrideConstraint)
            .OfType<TypeParameterConstraintClauseSyntax>();
        return declaration.WithConstraintClauses(SyntaxFactory.List(clauses));
    }

    private static TypeParameterConstraintClauseSyntax? OverrideConstraint(
        ITypeParameterSymbol parameter
    )
    {
        var constraint =
            !HasSomeConstraint(parameter)
                ? (TypeParameterConstraintSyntax)SyntaxFactory.DefaultConstraint()
            : !parameter.HasValueTypeConstraint
                ? SyntaxFactory.ClassOrStructConstraint(SyntaxKind.ClassConstraint)
            : null;
        return constraint is null ? null : ConstraintClause(parameter.Name, constraint);
    }

    private static TypeParameterConstraintClauseSyntax ConstraintClause(
        string parameterName,
        TypeParameterConstraintSyntax constraint
    )
    {
        return SyntaxFactory
            .TypeParameterConstraintClause(parameterName)
            .AddConstraints(constraint);
    }

    private static bool HasSomeConstraint(ITypeParameterSymbol parameter)
    {
        return parameter.HasConstructorConstraint
            || parameter.HasReferenceTypeConstraint
            || parameter.HasValueTypeConstraint
            || !parameter.ConstraintTypes.IsEmpty;
    }

    private static bool HasNullableUsage(ITypeParameterSymbol parameter, IMethodSymbol method)
    {
        return ContainsAnnotatedParameter(method.ReturnType, parameter)
            || method.Parameters.Any(item => ContainsAnnotatedParameter(item.Type, parameter));
    }

    private static bool ContainsAnnotatedParameter(ITypeSymbol type, ITypeParameterSymbol parameter)
    {
        return IsAnnotatedParameter(type, parameter)
            || type switch
            {
                IArrayTypeSymbol array => ContainsAnnotatedParameter(array.ElementType, parameter),
                IPointerTypeSymbol pointer => ContainsAnnotatedParameter(
                    pointer.PointedAtType,
                    parameter
                ),
                INamedTypeSymbol named => ContainsAnnotatedArgument(named, parameter),
                IFunctionPointerTypeSymbol pointer => ContainsAnnotatedSignature(
                    pointer.Signature,
                    parameter
                ),
                _ => false,
            };
    }

    private static bool IsAnnotatedParameter(ITypeSymbol type, ITypeParameterSymbol parameter)
    {
        return type is ITypeParameterSymbol current
            && SymbolEqualityComparer.Default.Equals(current, parameter)
            && current.NullableAnnotation == NullableAnnotation.Annotated;
    }

    private static bool ContainsAnnotatedArgument(
        INamedTypeSymbol type,
        ITypeParameterSymbol parameter
    )
    {
        return type.TypeArguments.Any(item => ContainsAnnotatedParameter(item, parameter));
    }

    private static bool ContainsAnnotatedSignature(
        IMethodSymbol signature,
        ITypeParameterSymbol parameter
    )
    {
        return ContainsAnnotatedParameter(signature.ReturnType, parameter)
            || signature.Parameters.Any(item => ContainsAnnotatedParameter(item.Type, parameter));
    }

    private static BasePropertyDeclarationSyntax GenerateProperty(
        SyntaxGenerator generator,
        IPropertySymbol property,
        ITypeSymbol exceptionType,
        INamedTypeSymbol target
    )
    {
        var getter = AccessorStatements(generator, property.GetMethod, exceptionType);
        var setter = AccessorStatements(generator, property.SetMethod, exceptionType);
        var declaration = property.IsIndexer
            ? generator.IndexerDeclaration(property, getter, setter)
            : generator.PropertyDeclaration(property, getter, setter);
        var initialized = NormalizeInitAccessor(
            (BasePropertyDeclarationSyntax)declaration,
            property
        );
        var normalized = NormalizeAccessorAccessibility(generator, initialized, property, target);
        return WithAccessorBodies(generator, normalized, exceptionType);
    }

    private static IEnumerable<SyntaxNode>? AccessorStatements(
        SyntaxGenerator generator,
        IMethodSymbol? accessor,
        ITypeSymbol exceptionType
    )
    {
        return accessor is null ? null : ThrowNotImplemented(generator, exceptionType);
    }

    private static BasePropertyDeclarationSyntax NormalizeInitAccessor(
        BasePropertyDeclarationSyntax declaration,
        IPropertySymbol property
    )
    {
        if (property.SetMethod?.IsInitOnly != true || declaration.AccessorList is null)
        {
            return declaration;
        }

        var accessors = declaration.AccessorList.Accessors.Select(ToInitAccessorIfSetter);
        return declaration.WithAccessorList(
            declaration.AccessorList.WithAccessors(SyntaxFactory.List(accessors))
        );
    }

    private static AccessorDeclarationSyntax ToInitAccessorIfSetter(
        AccessorDeclarationSyntax accessor
    )
    {
        return accessor.IsKind(SyntaxKind.SetAccessorDeclaration)
            ? ToInitAccessor(accessor)
            : accessor;
    }

    private static AccessorDeclarationSyntax ToInitAccessor(AccessorDeclarationSyntax accessor)
    {
        var keyword = SyntaxFactory.Token(
            accessor.Keyword.LeadingTrivia,
            SyntaxKind.InitKeyword,
            accessor.Keyword.TrailingTrivia
        );
        return SyntaxFactory
            .AccessorDeclaration(SyntaxKind.InitAccessorDeclaration)
            .WithAttributeLists(accessor.AttributeLists)
            .WithModifiers(accessor.Modifiers)
            .WithKeyword(keyword)
            .WithBody(accessor.Body)
            .WithExpressionBody(accessor.ExpressionBody)
            .WithSemicolonToken(accessor.SemicolonToken);
    }

    private static BasePropertyDeclarationSyntax NormalizeAccessorAccessibility(
        SyntaxGenerator generator,
        BasePropertyDeclarationSyntax declaration,
        IPropertySymbol property,
        INamedTypeSymbol target
    )
    {
        if (declaration.AccessorList is null)
        {
            return declaration;
        }

        var memberAccess = OverrideAccessibility(property, target);
        var accessors = declaration.AccessorList.Accessors.Select(accessor =>
            NormalizeAccessor(generator, accessor, property, target, memberAccess)
        );
        return declaration.WithAccessorList(
            declaration.AccessorList.WithAccessors(SyntaxFactory.List(accessors))
        );
    }

    private static BasePropertyDeclarationSyntax WithAccessorBodies(
        SyntaxGenerator generator,
        BasePropertyDeclarationSyntax declaration,
        ITypeSymbol exceptionType
    )
    {
        if (declaration.AccessorList is null)
        {
            return declaration;
        }

        var statements = ThrowNotImplemented(generator, exceptionType).ToImmutableArray();
        var accessors = declaration.AccessorList.Accessors.Select(accessor =>
            (AccessorDeclarationSyntax)generator.WithStatements(accessor, statements)
        );
        return declaration.WithAccessorList(
            declaration.AccessorList.WithAccessors(SyntaxFactory.List(accessors))
        );
    }

    private static AccessorDeclarationSyntax NormalizeAccessor(
        SyntaxGenerator generator,
        AccessorDeclarationSyntax accessor,
        IPropertySymbol property,
        INamedTypeSymbol target,
        Accessibility memberAccess
    )
    {
        var symbol = accessor.IsKind(SyntaxKind.GetAccessorDeclaration)
            ? property.GetMethod
            : property.SetMethod;
        var accessorAccess = symbol is null ? memberAccess : OverrideAccessibility(symbol, target);
        var declaredAccess =
            accessorAccess == memberAccess ? Accessibility.NotApplicable : accessorAccess;
        return (AccessorDeclarationSyntax)generator.WithAccessibility(accessor, declaredAccess);
    }

    private static BasePropertyDeclarationSyntax GenerateEvent(
        SyntaxGenerator generator,
        IEventSymbol @event,
        ITypeSymbol exceptionType
    )
    {
        var declaration = (EventDeclarationSyntax)
            generator.CustomEventDeclaration(
                @event,
                ThrowNotImplemented(generator, exceptionType),
                ThrowNotImplemented(generator, exceptionType)
            );
        return WithAccessorBodies(generator, declaration, exceptionType);
    }

    private static IEnumerable<SyntaxNode> ThrowNotImplemented(
        SyntaxGenerator generator,
        ITypeSymbol exceptionType
    )
    {
        return [generator.ThrowStatement(generator.ObjectCreationExpression(exceptionType))];
    }

    private static SyntaxNode MarkOverride(
        SyntaxGenerator generator,
        SyntaxNode declaration,
        ISymbol member,
        INamedTypeSymbol target
    )
    {
        var modifiers = OverrideModifiers(generator.GetModifiers(declaration));
        var updated = generator.WithModifiers(declaration, modifiers);
        return generator.WithAccessibility(updated, OverrideAccessibility(member, target));
    }

    private static DeclarationModifiers OverrideModifiers(DeclarationModifiers modifiers)
    {
        return modifiers
            .WithIsAbstract(false)
            .WithIsVirtual(false)
            .WithIsOverride(true)
            .WithIsSealed(false)
            .WithIsNew(false)
            .WithAsync(false);
    }

    private static Accessibility OverrideAccessibility(ISymbol member, INamedTypeSymbol target)
    {
        var crossAssembly = !SymbolEqualityComparer.Default.Equals(
            member.ContainingAssembly,
            target.ContainingAssembly
        );
        return member.DeclaredAccessibility == Accessibility.ProtectedOrInternal && crossAssembly
            ? Accessibility.Protected
            : member.DeclaredAccessibility;
    }
}
