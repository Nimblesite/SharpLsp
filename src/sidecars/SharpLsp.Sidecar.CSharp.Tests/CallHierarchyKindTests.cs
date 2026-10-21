using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// The kinds call hierarchy names its items with, in the PascalCase the host maps to LSP
/// <c>SymbolKind</c>, for the symbols a hierarchy request can land on that no workspace test
/// reaches. Implements [RAZOR-TESTING] for [RAZOR-FEATURES-HIERARCHY].
/// </summary>
public sealed class CallHierarchyKindTests
{
    private const string Source = """
        namespace Kinds
        {
            public class Box<TItem>
            {
                public object Items() => from item in new[] { 1 } select item;
            }
        }
        """;

    [Fact]
    public void Namespaces_type_parameters_and_kinds_lsp_lacks_are_named_for_the_host()
    {
        var tree = CSharpSyntaxTree.ParseText(Source);
        var compilation = CSharpCompilation.Create("Kinds", [tree]);
        var model = compilation.GetSemanticModel(tree);
        var nodes = tree.GetRoot().DescendantNodes().ToList();

        var space = model.GetDeclaredSymbol(nodes.OfType<NamespaceDeclarationSyntax>().Single());
        var item = model.GetDeclaredSymbol(nodes.OfType<TypeParameterSyntax>().Single());
        var range = model.GetDeclaredSymbol(nodes.OfType<FromClauseSyntax>().Single());
        Assert.Equal(
            ("Namespace", "TypeParameter", "Function", "Function"),
            (
                CallHierarchyResolver.MapSymbolKind(space!),
                CallHierarchyResolver.MapSymbolKind(item!),
                CallHierarchyResolver.MapSymbolKind(range!),
                CallHierarchyResolver.MapSymbolKind(compilation.Assembly)
            )
        );
        Assert.Equal(SymbolKind.RangeVariable, range!.Kind);
    }
}
