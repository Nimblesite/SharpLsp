using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1016 // Test providers are never exported

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A fix-all runs through the provider that offered it ([FIXALL-SCOPES]): two
/// providers may share an equivalence key, so the key alone cannot route the
/// resolve. Isolated because no shipped Roslyn providers collide on a key
/// deterministically; the fix-all pipeline itself is the real one.
/// </summary>
public sealed class FixAllProviderIdentityTests
{
    private const string SharedKey = "Shared";

    [Fact]
    public async Task Providers_sharing_an_equivalence_key_each_fix_all_through_their_own()
    {
        using var workspace = new AdhocWorkspace();
        var path = NativePaths.Temp("Identity", "Sample.cs");
        var document = workspace
            .AddProject("Identity", LanguageNames.CSharp)
            .AddDocument("Sample.cs", SourceText.From("class Sample { }\n"), filePath: path);
        var resolver = new CodeActionResolver();
        var first = Offer(resolver, new FirstProvider());
        var second = Offer(resolver, new SecondProvider());

        // Interaction 1 — the two offers carry distinct fix keys.
        Assert.NotNull(first.FixKey);
        Assert.NotNull(second.FixKey);
        Assert.NotEqual(first.FixKey, second.FixKey);
        Assert.Equal(["document", "project", "solution"], second.FixAllScopes);

        // Interaction 2 — each key resolves through its own provider.
        // The edit is a minimal diff of "class Sample { }" to the provider's mark.
        Assert.Equal("// first", await FixedText(resolver, document, first.FixKey!));
        Assert.Equal("// second", await FixedText(resolver, document, second.FixKey!));

        // Interaction 3 — the bare equivalence key routes nowhere.
        var bare = await resolver.FixAllAsync(document, SharedKey, "document", default);
        Assert.True(bare.IsError);
        Assert.Contains(
            "no longer available",
            bare.Match(_ => "", error => error),
            StringComparison.Ordinal
        );
    }

    private static CodeActionItem Offer(CodeActionResolver resolver, MarkingProvider provider)
    {
        var action = provider.Action(null);
        return resolver.CacheAction(
            action,
            "quickfix",
            action.Title,
            CodeActionResolver.FixAllCapabilityOf(provider, action)
        );
    }

    private static async Task<string> FixedText(
        CodeActionResolver resolver,
        Document document,
        string fixKey
    )
    {
        var result = await resolver.FixAllAsync(document, fixKey, "document", default);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        var change = Assert.Single((+result).DocumentChanges);
        Assert.True(NativePaths.AreEqual(document.FilePath, change.FilePath));
        return string.Concat(change.Edits.Select(edit => edit.NewText));
    }

    /// <summary>One provider, as an analyzer package ships it.</summary>
    private sealed class FirstProvider() : MarkingProvider("first");

    /// <summary>Another package's provider reusing the same equivalence key.</summary>
    private sealed class SecondProvider() : MarkingProvider("second");

    /// <summary>A provider whose fix-all rewrites the document to its own mark.</summary>
    private abstract class MarkingProvider(string mark) : CodeFixProvider
    {
        public override ImmutableArray<string> FixableDiagnosticIds => ["CS0000"];

        public override Task RegisterCodeFixesAsync(CodeFixContext context)
        {
            return Task.CompletedTask;
        }

        public override FixAllProvider GetFixAllProvider()
        {
            return new MarkingFixAll(this);
        }

        public CodeAction Action(Document? target)
        {
            return CodeAction.Create(
                $"Mark {mark}",
                _ =>
                    target is null
                        ? throw new InvalidOperationException("listing only")
                        : Task.FromResult(
                            target.Project.Solution.WithDocumentText(
                                target.Id,
                                SourceText.From($"// {mark}\n")
                            )
                        ),
                SharedKey
            );
        }

        private sealed class MarkingFixAll(MarkingProvider owner) : FixAllProvider
        {
            public override IEnumerable<FixAllScope> GetSupportedFixAllScopes()
            {
                return [FixAllScope.Document, FixAllScope.Project, FixAllScope.Solution];
            }

            public override Task<CodeAction?> GetFixAsync(FixAllContext fixAllContext)
            {
                return Task.FromResult<CodeAction?>(owner.Action(fixAllContext.Document));
            }
        }
    }
}
