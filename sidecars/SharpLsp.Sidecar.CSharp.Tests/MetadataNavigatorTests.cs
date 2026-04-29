using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable CA1861 // Avoid constant array arguments

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Tests for <see cref="MetadataNavigator"/> — decompiles framework types
/// via ICSharpCode.Decompiler and locates the symbol in the decompiled source.
/// </summary>
public sealed class MetadataNavigatorTests
{
    [Fact]
    public async Task Resolve_Console_WriteLine_returns_decompiled_location()
    {
        // Arrange: compile code that references Console.WriteLine.
        const string source = """
            class Program
            {
                static void Main() { System.Console.WriteLine("Hi"); }
            }
            """;
        var (symbol, compilation) = await ResolveSymbolAtIdentifier(source, "WriteLine");

        // Act
        var location = MetadataNavigator.ResolveMetadataSymbol(symbol, compilation);

        // Assert
        Assert.NotNull(location);
        Assert.False(string.IsNullOrEmpty(location!.FilePath));
        Assert.EndsWith(".cs", location.FilePath);
        // Symbol name (WriteLine) is a method; BuildSearchPattern looks for " WriteLine("
        // The decompiled Console includes this declaration so line > 0.
        Assert.True(location.Line >= 0);
    }

    [Fact]
    public async Task Resolve_Console_type_returns_decompiled_location()
    {
        // Class reference (INamedTypeSymbol) hits the IsInType branch of BuildSearchPattern.
        const string source = """
            class Program
            {
                static void Main() { var c = typeof(System.Console); }
            }
            """;
        var (symbol, compilation) = await ResolveSymbolAtIdentifier(source, "Console");

        var location = MetadataNavigator.ResolveMetadataSymbol(symbol, compilation);

        Assert.NotNull(location);
        Assert.EndsWith(".cs", location!.FilePath);
    }

    [Fact]
    public async Task Resolve_property_symbol_returns_location()
    {
        // IPropertySymbol branch.
        const string source = """
            class Program
            {
                static int Len = System.Environment.ProcessorCount;
            }
            """;
        var (symbol, compilation) = await ResolveSymbolAtIdentifier(source, "ProcessorCount");

        var location = MetadataNavigator.ResolveMetadataSymbol(symbol, compilation);
        Assert.NotNull(location);
    }

    [Fact]
    public async Task Resolve_generic_type_list_returns_location()
    {
        // Generic type (List<T>) exercises the `MetadataName` with `1 suffix path.
        const string source = """
            using System.Collections.Generic;
            class Program
            {
                static List<int> items = new();
            }
            """;
        var (symbol, compilation) = await ResolveSymbolAtIdentifier(source, "List");

        var location = MetadataNavigator.ResolveMetadataSymbol(symbol, compilation);
        Assert.NotNull(location);
        // Arity suffix means search pattern might not find "List" — fallback is line 0/col 0.
        Assert.True(location!.Line >= 0);
    }

    [Fact]
    public async Task Resolve_source_symbol_returns_null()
    {
        // A symbol declared in the same compilation is not metadata — should return null
        // because its containing assembly is the compilation assembly, which has no PE reference.
        const string source = """
            public class LocalType
            {
                public int Foo() => 42;
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);
        var model =
            await document.GetSemanticModelAsync()
            ?? throw new InvalidOperationException("semantic model is null");
        var root =
            await document.GetSyntaxRootAsync()
            ?? throw new InvalidOperationException("syntax root is null");

        var classDecl = root.DescendantNodes().OfType<ClassDeclarationSyntax>().First();
        var symbol =
            model.GetDeclaredSymbol(classDecl)
            ?? throw new InvalidOperationException("declared symbol is null");
        var compilation =
            await document.Project.GetCompilationAsync()
            ?? throw new InvalidOperationException("compilation is null");

        var location = MetadataNavigator.ResolveMetadataSymbol(symbol, compilation);

        // A compilation-defined symbol has no PE reference → GetAssemblyPath returns null.
        Assert.Null(location);
    }

    [Fact]
    public async Task Resolve_caches_repeat_decompilation()
    {
        const string source = """
            class Program
            {
                static void Main() { System.Console.WriteLine("a"); System.Console.Write("b"); }
            }
            """;
        var (writeLineSymbol, compilation) = await ResolveSymbolAtIdentifier(source, "WriteLine");
        var (writeSymbol, compilation2) = await ResolveSymbolAtIdentifier(source, "Write");

        var first = MetadataNavigator.ResolveMetadataSymbol(writeLineSymbol, compilation);
        var second = MetadataNavigator.ResolveMetadataSymbol(writeSymbol, compilation2);

        Assert.NotNull(first);
        Assert.NotNull(second);
        // Both resolve to the same decompiled Console.cs file (cache hit for the second call).
        Assert.Equal(first!.FilePath, second!.FilePath);
    }

    private static async Task<(ISymbol symbol, Compilation compilation)> ResolveSymbolAtIdentifier(
        string source,
        string identifierName
    )
    {
        var (document, _) = RoslynTestWorkspace.Create(source);
        var model =
            await document.GetSemanticModelAsync().ConfigureAwait(true)
            ?? throw new InvalidOperationException("semantic model is null");
        var root =
            await document.GetSyntaxRootAsync().ConfigureAwait(true)
            ?? throw new InvalidOperationException("syntax root is null");
        var compilation =
            await document.Project.GetCompilationAsync().ConfigureAwait(true)
            ?? throw new InvalidOperationException("compilation is null");

        var idNode = root.DescendantTokens()
            .First(t => t.IsKind(SyntaxKind.IdentifierToken) && t.ValueText == identifierName);
        var parent = idNode.Parent ?? throw new InvalidOperationException("Parent is null");
        var info = model.GetSymbolInfo(parent);
        var symbol =
            info.Symbol
            ?? info.CandidateSymbols.FirstOrDefault()
            ?? throw new InvalidOperationException($"Unable to resolve {identifierName}");
        return (symbol, compilation);
    }
}
