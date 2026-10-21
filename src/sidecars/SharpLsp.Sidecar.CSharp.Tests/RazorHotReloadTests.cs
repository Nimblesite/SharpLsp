using SharpLsp.Sidecar.CSharp.Debugging;

#pragma warning disable CA1515 // Public xUnit fixture type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // The fixture is built and hot-reloaded for real

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Razor Hot Reload against the real fixture: a saved Razor file replaces the additional
/// document's text in every framework copy, the SDK Razor generator re-runs, and the
/// Edit-and-Continue emit produces deltas for the changed generated C#. The signature
/// guard judges a Razor save through its generated documents, never by parsing Razor
/// text. Implements [RAZOR-HOT-RELOAD] for [DEBUG-FEATURES-HOT-RELOAD] and
/// [RAZOR-ARCHITECTURE-DOCUMENTS].
/// </summary>
public sealed class RazorHotReloadTests : IClassFixture<RazorFixture>
{
    /// <summary>Counter.razor with only markup text changed: the generated body moves.</summary>
    private const string MarkupSave = """
        @page "/counter"
        @rendermode InteractiveServer

        <PageTitle>Counter</PageTitle>

        <h1>Tally</h1>

        <p role="status">Current count: @currentCount</p>

        <button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

        @code {
            private int currentCount = 0;

            private void IncrementCount()
            {
                currentCount++;
            }
        }
        """;

    /// <summary>Counter.razor with the markup changed again, past <see cref="MarkupSave"/>.</summary>
    private const string MarkupSaveAgain = """
        @page "/counter"
        @rendermode InteractiveServer

        <PageTitle>Counter</PageTitle>

        <h1>Tally!</h1>

        <p role="status">Current count: @currentCount</p>

        <button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

        @code {
            private int currentCount = 0;

            private void IncrementCount()
            {
                currentCount++;
            }
        }
        """;

    /// <summary>Counter.razor with an @code method body edit: the supported core edit.</summary>
    private const string BodySave = """
        @page "/counter"
        @rendermode InteractiveServer

        <PageTitle>Counter</PageTitle>

        <h1>Counter</h1>

        <p role="status">Current count: @currentCount</p>

        <button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

        @code {
            private int currentCount = 0;

            private void IncrementCount()
            {
                currentCount += 2;
            }
        }
        """;

    /// <summary>Counter.razor whose @code changes a method's signature: a rude edit.</summary>
    private const string SignatureSave = """
        @page "/counter"
        @rendermode InteractiveServer

        <PageTitle>Counter</PageTitle>

        <h1>Counter</h1>

        <p role="status">Current count: @currentCount</p>

        <button class="btn btn-primary" @onclick="IncrementCount">Click me</button>

        @code {
            private int currentCount = 0;

            private void IncrementCount(int by)
            {
                currentCount += by;
            }
        }
        """;

    /// <summary>Counting.cs with a method body edit, for the mixed batch.</summary>
    private const string CountingSave = """
        namespace BlazorApp.Components.Shared;

        /// <summary>
        /// A plain C# type the fixture's Razor components call into, so that a call from Razor code and
        /// markup reaches a method declared outside the projection. [RAZOR-TESTING]
        /// </summary>
        internal static class Counting
        {
            /// <summary>Triples a count.</summary>
            internal static int Bump(int by)
            {
                return by * 3;
            }
        }
        """;

    private readonly RazorFixture _fixture;

    public RazorHotReloadTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Counter => _fixture.Path("BlazorApp", "Components", "Pages", "Counter.razor");

    private string Counting => _fixture.Path("BlazorApp", "Components", "Shared", "Counting.cs");

    private string ProjectPath => _fixture.Path("BlazorApp", "BlazorApp.csproj");

    // Implements [RAZOR-HOT-RELOAD]: a markup-only save re-runs the SDK Razor generator
    // and the EnC emit carries the changed generated body to the runtime.
    [Fact]
    public async Task A_markup_only_razor_save_emits_deltas_and_commits()
    {
        var (registry, sessionId) = await StartedAsync().ConfigureAwait(true);

        var applied = await SavedAsync(registry, sessionId, Counter, MarkupSave)
            .ConfigureAwait(true);
        AssertApplied(applied);
        AssertRealDeltas(applied);
        Assert.Empty(applied.Diagnostics);
        await ConfirmedAsync(registry, sessionId).ConfigureAwait(true);

        // The committed emit is the baseline: a further markup save still emits.
        var again = await SavedAsync(registry, sessionId, Counter, MarkupSaveAgain)
            .ConfigureAwait(true);
        AssertApplied(again);
        AssertRealDeltas(again);
        await EndedAsync(registry, sessionId).ConfigureAwait(true);
    }

    // Implements [RAZOR-HOT-RELOAD]: an @code method body edit is the supported core
    // edit, and a re-save of committed text is quiet — the baseline moved with it.
    [Fact]
    public async Task An_atcode_body_edit_emits_and_a_resave_of_it_is_quiet()
    {
        var (registry, sessionId) = await StartedAsync().ConfigureAwait(true);

        var applied = await SavedAsync(registry, sessionId, Counter, BodySave).ConfigureAwait(true);
        AssertApplied(applied);
        AssertRealDeltas(applied);
        Assert.Empty(applied.Diagnostics);
        await ConfirmedAsync(registry, sessionId).ConfigureAwait(true);

        var quiesced = await SavedAsync(registry, sessionId, Counter, BodySave)
            .ConfigureAwait(true);
        AssertApplied(quiesced);
        Assert.Empty(quiesced.Updates);
        await EndedAsync(registry, sessionId).ConfigureAwait(true);
    }

    // Implements [RAZOR-HOT-RELOAD]: the signature guard judges the GENERATED documents
    // whose text the save changed, so a signature change inside @code refuses exactly
    // like a .cs rude edit, naming the method — and never poisons the session.
    [Fact]
    public async Task A_razor_signature_change_demands_a_restart_naming_the_method()
    {
        var (registry, sessionId) = await StartedAsync().ConfigureAwait(true);

        var refused = await SavedAsync(registry, sessionId, Counter, SignatureSave)
            .ConfigureAwait(true);
        Assert.Equal("restartRequired", refused.Status);
        Assert.Empty(refused.Updates);
        var reason = Assert.Single(refused.Diagnostics);
        Assert.StartsWith("ENC0110:", reason, StringComparison.Ordinal);
        Assert.Contains("IncrementCount", reason, StringComparison.Ordinal);

        // A refusal is a verdict, not a poison: the next markup save still emits.
        var recovered = await SavedAsync(registry, sessionId, Counter, MarkupSave)
            .ConfigureAwait(true);
        AssertApplied(recovered);
        AssertRealDeltas(recovered);
        await EndedAsync(registry, sessionId).ConfigureAwait(true);
    }

    // Implements [RAZOR-HOT-RELOAD]: one batch may span a .cs save and a .razor save;
    // both apply atomically as one candidate, and the batch becomes the baseline.
    [Fact]
    public async Task A_batch_mixing_a_csharp_and_a_razor_save_applies_as_one()
    {
        var (registry, sessionId) = await StartedAsync().ConfigureAwait(true);

        var spanning = await SendAsync(
                registry,
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = sessionId,
                    Documents =
                    [
                        new HotReloadDocument { FilePath = Counting, NewText = CountingSave },
                        new HotReloadDocument { FilePath = Counter, NewText = MarkupSave },
                    ],
                }
            )
            .ConfigureAwait(true);
        AssertApplied(spanning);
        AssertRealDeltas(spanning);
        Assert.Empty(spanning.Diagnostics);
        await ConfirmedAsync(registry, sessionId).ConfigureAwait(true);

        // Both sides of the batch are the baseline now: the same Razor save is quiet,
        // while a further markup tweak emits against the batch.
        var quiesced = await SavedAsync(registry, sessionId, Counter, MarkupSave)
            .ConfigureAwait(true);
        AssertApplied(quiesced);
        Assert.Empty(quiesced.Updates);

        var further = await SavedAsync(registry, sessionId, Counter, MarkupSaveAgain)
            .ConfigureAwait(true);
        AssertApplied(further);
        AssertRealDeltas(further);
        await EndedAsync(registry, sessionId).ConfigureAwait(true);
    }

    // Implements [RAZOR-ARCHITECTURE-DOCUMENTS] "unlisted files" through [RAZOR-HOT-RELOAD]:
    // a Razor file no project lists has no semantics — the save fails clearly, by name,
    // and the session stays usable.
    [Fact]
    public async Task An_unlisted_razor_save_fails_clearly_and_the_session_survives()
    {
        var (registry, sessionId) = await StartedAsync().ConfigureAwait(true);
        var ghost = _fixture.Path("BlazorApp", "Components", "Pages", "Ghost.razor");

        var refusal = await Assert
            .ThrowsAsync<InvalidOperationException>(async () =>
                _ = await SavedAsync(registry, sessionId, ghost, MarkupSave).ConfigureAwait(true)
            )
            .ConfigureAwait(true);
        // The refusal is clear because it names the file it cannot reload.
        Assert.Contains(ghost, refusal.Message, StringComparison.Ordinal);

        // The failed save never touched the session: a real save still applies.
        var applied = await SavedAsync(registry, sessionId, Counter, MarkupSave)
            .ConfigureAwait(true);
        AssertApplied(applied);
        AssertRealDeltas(applied);
        await EndedAsync(registry, sessionId).ConfigureAwait(true);
    }

    /// <summary>A session over the debugged project, started through the registry.</summary>
    private async Task<(HotReloadSessionRegistry Registry, string SessionId)> StartedAsync()
    {
        var registry = new HotReloadSessionRegistry();
        var started = await SendAsync(
                registry,
                new HotReloadRequest
                {
                    Action = "start",
                    ProjectPath = ProjectPath,
                    Capabilities =
                    [
                        "Baseline",
                        "AddMethodToExistingType",
                        "AddStaticFieldToExistingType",
                        "AddDefinitionToExistingType",
                        "NewTypeDefinition",
                    ],
                }
            )
            .ConfigureAwait(true);
        Assert.Equal("started", started.Status);
        Assert.Equal("BlazorApp", started.AssemblyName);
        return (registry, started.SessionId);
    }

    /// <summary>One saved document, sent as a single-document batch.</summary>
    private static Task<HotReloadResponse> SavedAsync(
        HotReloadSessionRegistry registry,
        string sessionId,
        string filePath,
        string newText
    )
    {
        return SendAsync(
            registry,
            new HotReloadRequest
            {
                Action = "update",
                SessionId = sessionId,
                Documents = [new HotReloadDocument { FilePath = filePath, NewText = newText }],
            }
        );
    }

    private static async Task<HotReloadResponse> SendAsync(
        HotReloadSessionRegistry registry,
        HotReloadRequest request
    )
    {
        return await registry.HandleAsync(request, CancellationToken.None).ConfigureAwait(true);
    }

    /// <summary>One update: a real module delta with all three delta streams.</summary>
    private static void AssertRealDeltas(HotReloadResponse applied)
    {
        var update = Assert.Single(applied.Updates);
        Assert.NotEqual(Guid.Empty, Guid.Parse(update.ModuleId));
        Assert.NotEmpty(Convert.FromBase64String(update.MetadataDelta));
        Assert.NotEmpty(Convert.FromBase64String(update.IlDelta));
        Assert.NotEmpty(Convert.FromBase64String(update.PdbDelta));
    }

    /// <summary>An applied verdict, naming every diagnostic a failure would hide.</summary>
    private static void AssertApplied(HotReloadResponse response)
    {
        Assert.True(
            response.Status == "applied",
            $"{response.Status}: {string.Join(" | ", response.Diagnostics)}"
        );
    }

    /// <summary>The debuggee confirmed the deltas; the sidecar must accept the commit.</summary>
    private static async Task ConfirmedAsync(HotReloadSessionRegistry registry, string sessionId)
    {
        var committed = await SendAsync(
                registry,
                new HotReloadRequest { Action = "commit", SessionId = sessionId }
            )
            .ConfigureAwait(true);
        Assert.Equal("committed", committed.Status);
    }

    /// <summary>The session ends cleanly, releasing its workspace.</summary>
    private static async Task EndedAsync(HotReloadSessionRegistry registry, string sessionId)
    {
        var ended = await SendAsync(
                registry,
                new HotReloadRequest { Action = "end", SessionId = sessionId }
            )
            .ConfigureAwait(true);
        Assert.Equal("ended", ended.Status);
    }
}
