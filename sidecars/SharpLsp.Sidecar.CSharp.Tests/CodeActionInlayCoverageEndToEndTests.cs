using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coarse E2E tests driving <c>CodeActionResolver</c> and <c>InlayHintResolver</c>
/// through the real sidecar socket at branches the other suites don't reach:
/// inlay hints over a <c>nameof</c> call (unresolvable-parameter skip), over a
/// named argument (explicit-name skip), and over error-typed <c>var</c>/lambda
/// declarations (unresolved-type skip); code actions producing an add-import
/// quick fix that resolves to a workspace edit, a generate-method fix, a
/// namespace-conversion refactoring that resolves to an edit, an empty-result
/// position, and a broken-syntax span that must be handled gracefully.
///
/// Mutating tests replace <c>MetaProbe.cs</c> in-memory via <c>textDocument/didChange</c>
/// and always revert to <see cref="CSharpSidecarFixture.MetaProbeSource"/> in a
/// finally block, so tests remain order-independent within the class.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class CodeActionInlayCoverageEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    // A named argument (skipped by InlayHintResolver), an unresolved-type `var`
    // and an untyped lambda bound to `var` (both skipped), plus a valid `var`
    // and a positional call (both produce hints). Drives the parameter-name,
    // type-hint and lambda-type-hint skip branches in one inlay request.
    private const string HintProbeSource = """
        namespace MetaProbe;

        public sealed class HintProbe
        {
            public void Run()
            {
                var good = 5;
                Named(value: 1);
                Positional(good);
                var bad = Missing();
                var fn = p => p + good;
            }

            public void Named(int value) { }

            public void Positional(int x) { }
        }
        """;

    // `DoStuff()` is undefined (CS0103); Roslyn offers a "Generate method" fix.
    private const string GenProbeSource = """
        namespace MetaProbe;

        public sealed class GenProbe
        {
            public void Run()
            {
                DoStuff();
            }
        }
        """;

    // Deliberately malformed: an incomplete assignment and an unclosed call.
    // Code-action discovery over the broken tree must stay graceful.
    private const string BrokenProbeSource = """
        namespace MetaProbe;

        public sealed class BrokenProbe
        {
            public void Run()
            {
                var value = ;
                DoThing(
            }
        }
        """;

    // A block-scoped namespace with a fully-used local and a blank line inside
    // the method body — a position with no diagnostic and no applicable
    // refactoring, so the code-action result is empty.
    private const string EmptyProbeSource = """
        namespace MetaProbe
        {
            public sealed class EmptyProbe
            {
                public int Run()
                {
                    int x = 1;

                    return x;
                }
            }
        }
        """;

    /// <summary>
    /// Replaces <c>MetaProbe.cs</c> in the loaded workspace with <paramref name="source"/>,
    /// runs <paramref name="body"/>, then always reverts to the original probe source.
    /// </summary>
    private async Task WithMetaProbeSourceAsync(string source, Func<Task> body)
    {
        await fixture.SendAndAssertOkAsync(
            "textDocument/didChange",
            new DidChangeRequest { FilePath = fixture.MetaProbeFile, NewText = source }
        );
        try
        {
            await body();
        }
        finally
        {
            await fixture.SendAndAssertOkAsync(
                "textDocument/didChange",
                new DidChangeRequest
                {
                    FilePath = fixture.MetaProbeFile,
                    NewText = CSharpSidecarFixture.MetaProbeSource,
                }
            );
        }
    }

    // ── Inlay hints ──────────────────────────────────────────────

    /// <summary>
    /// Inlay hints over <c>Program.cs</c>'s <c>Process</c> method (L63-74) span the
    /// <c>nameof(extras)</c> call. Its inner argument binds to no method symbol, so
    /// <c>InlayHintResolver.DetermineParameter</c> returns null and
    /// <c>AddParameterHintsForArgs</c> skips it — while the real <c>ToList(extras)</c>
    /// call in the same range still yields a "source:" parameter hint.
    /// </summary>
    [Fact]
    public async Task InlayHints_over_nameof_call_skip_unresolvable_parameter()
    {
        var hints = await fixture.SendAndDeserializeAsync<InlayHintRequest, InlayHintResult[]>(
            "textDocument/inlayHint",
            new InlayHintRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = 63,
                EndLine = 75,
            }
        );

        Assert.NotEmpty(hints);
        // `System.Linq.Enumerable.ToList(extras)` resolves its argument to the
        // `source` parameter; the `nameof(extras)` argument produces no hint.
        Assert.Contains(hints, h => h.Kind == 2 && h.Label == "source:");
    }

    /// <summary>
    /// A named argument, an unresolved-type <c>var</c>, and an untyped lambda bound to
    /// <c>var</c> each drive a distinct skip branch in <c>InlayHintResolver</c>:
    /// <c>AddParameterHintsForArgs</c> skips the explicit-name argument (no "value:"
    /// hint), <c>CollectTypeHints</c> skips the error-typed <c>var bad</c>/<c>var fn</c>,
    /// and <c>AddLambdaParamHint</c> skips the error-typed lambda parameter — leaving
    /// only the valid <c>var good</c> type hint and the positional "x:" parameter hint.
    /// </summary>
    [Fact]
    public async Task InlayHints_skip_named_argument_and_error_typed_var_and_lambda()
    {
        await WithMetaProbeSourceAsync(
            HintProbeSource,
            async () =>
            {
                var hints = await fixture.SendAndDeserializeAsync<
                    InlayHintRequest,
                    InlayHintResult[]
                >(
                    "textDocument/inlayHint",
                    new InlayHintRequest
                    {
                        FilePath = fixture.MetaProbeFile,
                        StartLine = 0,
                        EndLine = 17,
                    }
                );

                Assert.NotEmpty(hints);
                // The positional call still produces a parameter-name hint.
                Assert.Contains(hints, h => h.Kind == 2 && h.Label == "x:");
                // The named argument is skipped — no "value:" hint is emitted.
                Assert.DoesNotContain(hints, h => h.Label == "value:");
                // Only the valid `var good` yields a type hint; the error-typed
                // `var bad`, `var fn` and the untyped lambda parameter are skipped.
                var typeHints = hints.Where(h => h.Kind == 1).ToList();
                Assert.Single(typeHints);
                Assert.Contains("int", typeHints[0].Label);
            }
        );
    }

    /// <summary>
    /// An empty range (a blank line) contains no invocations, object creations,
    /// lambdas or <c>var</c> declarations, so <c>InlayHintResolver</c> returns nothing.
    /// </summary>
    [Fact]
    public async Task InlayHints_over_empty_range_return_no_hints()
    {
        var hints = await fixture.SendAndDeserializeAsync<InlayHintRequest, InlayHintResult[]>(
            "textDocument/inlayHint",
            new InlayHintRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = 1,
                EndLine = 1,
            }
        );

        Assert.Empty(hints);
    }

    // ── Code actions ─────────────────────────────────────────────

    /// <summary>
    /// An undefined method call (CS0103) yields a "Generate method" quick fix,
    /// driving the fix-collection and registration path for a diagnostic the
    /// other suites don't exercise.
    /// </summary>
    [Fact]
    public async Task CodeAction_generate_method_for_undefined_call_offers_fix()
    {
        await WithMetaProbeSourceAsync(
            GenProbeSource,
            async () =>
            {
                var actions = await fixture.SendAndDeserializeAsync<
                    CodeActionRequest,
                    CodeActionItem[]
                >(
                    "textDocument/codeAction",
                    new CodeActionRequest
                    {
                        FilePath = fixture.MetaProbeFile,
                        StartLine = 6,
                        StartCharacter = 8,
                        EndLine = 6,
                        EndCharacter = 15,
                    }
                );

                Assert.NotEmpty(actions);
                Assert.Contains(actions, a => a.Title.Contains("Generate"));
            }
        );
    }

    /// <summary>
    /// A blank line inside a method body — no diagnostic in the span and no
    /// applicable refactoring — yields an empty code-action result.
    /// </summary>
    [Fact]
    public async Task CodeAction_on_blank_line_in_method_returns_no_actions()
    {
        await WithMetaProbeSourceAsync(
            EmptyProbeSource,
            async () =>
            {
                var actions = await fixture.SendAndDeserializeAsync<
                    CodeActionRequest,
                    CodeActionItem[]
                >(
                    "textDocument/codeAction",
                    new CodeActionRequest
                    {
                        FilePath = fixture.MetaProbeFile,
                        StartLine = 7,
                        StartCharacter = 0,
                        EndLine = 7,
                        EndCharacter = 0,
                    }
                );

                Assert.Empty(actions);
            }
        );
    }

    /// <summary>
    /// Code-action discovery over a span of deliberately broken syntax must not
    /// crash the sidecar: the refactoring providers run against the malformed
    /// tree, and whatever the outcome, the process replies and answers a
    /// follow-up ping.
    /// </summary>
    [Fact]
    public async Task CodeAction_over_broken_syntax_is_handled_gracefully()
    {
        await WithMetaProbeSourceAsync(
            BrokenProbeSource,
            async () =>
            {
                var response = await fixture.SendAsync(
                    "textDocument/codeAction",
                    MessagePackSerializer.Serialize(
                        new CodeActionRequest
                        {
                            FilePath = fixture.MetaProbeFile,
                            StartLine = 6,
                            StartCharacter = 8,
                            EndLine = 7,
                            EndCharacter = 16,
                        }
                    )
                );
                Assert.NotNull(response);

                var ping = await fixture.SendAsync("ping", []);
                Assert.Null(ping.Error);
                Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(ping.Payload));
            }
        );
    }
}
