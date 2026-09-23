using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes.
#pragma warning disable CA1515

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Two file-based roots open at once must be ISOLATED. They were serially
/// destructive: only the most recently opened root had a valid compilation.
///
/// <c>LoadClosureAsync</c> published <c>_adhocWorkspace.CurrentSolution</c> as the
/// live solution on every open. That workspace is not where a root's state
/// accumulates — live document text, closure reconciliation and the tier-1
/// metadata references a settled <c>#:package</c> restore swaps in all land on
/// <c>_solution</c>, which forks away from it the first time anything changes. So
/// opening a second root did not add a root, it RESET every other one to the text
/// on disk and to tier-2 BCL references. The neighbour's own load looked perfect;
/// the root the user had been working in went red about 20ms later.
///
/// Every assertion here is taken IMMEDIATELY after the neighbouring open, never
/// after a settle. Waiting is what concealed this: the evicted root does eventually
/// re-resolve, so a test that gave it time to recover reported a pass on every
/// machine fast enough to rebind. Issue #294. Implements [SCRIPT-CLOSURE] and
/// [SCRIPT-FILEBASED-REFERENCES-MSBUILD].
/// </summary>
public sealed class FileBasedRootIsolationEndToEndTests : IDisposable
{
    private const string PackagedRoot =
        "#:package Newtonsoft.Json@13.0.3\n"
        + "using Newtonsoft.Json.Linq;\n"
        + "var payload = new JObject();\n"
        + "Console.WriteLine(payload.Count);\n";

    /// <summary>Uses <c>JObject</c> with NO directive: it must fail to bind, always.</summary>
    private const string UnpackagedRoot =
        "using Newtonsoft.Json.Linq;\n"
        + "var payload = new JObject();\n"
        + "Console.WriteLine(payload.Count);\n";

    private const string PlainRoot = "Console.WriteLine(\"no packages here\");\n";

    /// <summary>What Roslyn reports when a package reference is missing from the compilation.</summary>
    private static readonly string[] PackageBindingErrorCodes = ["CS0246", "CS0234", "CS0103"];

    private readonly ProjectlessWorkspaceFixture _fixture = new("root-isolation");

    public void Dispose()
    {
        _fixture.Dispose();
    }

    /// <summary>
    /// The eviction, with no network in the way: a live edit is state that exists
    /// only on <c>_solution</c>, so a neighbouring open that republishes the adhoc
    /// fork silently reverts the root the user is typing in to its on-disk text.
    /// Same mechanism as the package eviction, deterministic and instant.
    /// </summary>
    [Fact]
    public async Task Opening_a_neighbouring_root_keeps_an_earlier_roots_live_edit()
    {
        // 1 — a root whose text on disk does not compile.
        var edited = _fixture.Write("Edited.cs", "Console.WriteLine(Missing());\n");
        using var manager = new WorkspaceManager();
        await OpenAndSettleAsync(manager, edited);
        var onDisk = await ProjectlessWorkspaceFixture.ErrorsAsync(manager, edited);
        Assert.Contains(onDisk, error => string.Equals(error.Code, "CS0103", StringComparison.Ordinal));

        // 2 — the user fixes it in the editor. Nothing is written to disk, so the
        //     correction lives ONLY in the workspace's solution.
        await ApplyLiveEditAsync(manager, edited, "Console.WriteLine(1);\n");
        await AssertNoErrorsAsync(manager, edited, "after the live edit");

        // 3 — THE INVARIANT. A neighbouring root opens; this one must not move.
        var neighbour = _fixture.Write("Neighbour.cs", PlainRoot);
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, neighbour)).IsError);
        await AssertNoErrorsAsync(
            manager,
            edited,
            "#294: opening a neighbouring root REVERTED this root to its on-disk text, "
                + "discarding the user's unsaved edit"
        );

        // 4 — and both roots are still independently servable afterwards.
        await AssertNoErrorsAsync(manager, neighbour, "the neighbour's own load");
        await AssertNoErrorsAsync(manager, edited, "the edited root, re-queried");
    }

    /// <summary>
    /// Issue #294 verbatim, in both directions at once. A resolved <c>#:package</c>
    /// reference must survive a neighbouring root's open, and must never leak into
    /// that neighbour.
    /// </summary>
    [Fact]
    public async Task Opening_a_neighbouring_root_keeps_an_earlier_roots_package_reference()
    {
        // 1 — a packaged root opens. The restore runs in the background; the editor
        //     does NOT wait for it.
        var packaged = _fixture.Write("RootWithPackage.cs", PackagedRoot);
        using var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, packaged);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));

        // 2 — the editor pushes the buffer's text WHILE that restore is still in
        //     flight, which is what VS Code does the instant the file is shown.
        //     The ordering is the whole mechanism. This push forks the live solution
        //     away from the adhoc workspace, so when the restore lands moments later
        //     it can no longer write its references back into that workspace — the
        //     "Could not apply restored file-based package references" warning in the
        //     log is that failure. The live solution gets the references; the adhoc
        //     workspace keeps a tier-2 copy of this project forever. Settle the
        //     restore AFTER the push, never before: a test that pushes text only once
        //     the restore has landed leaves both solutions holding the references and
        //     cannot reproduce this at all.
        //     Directives are unchanged, so no re-resolution is triggered.
        await ApplyLiveEditAsync(manager, packaged, PackagedRoot + "Console.WriteLine(payload.Type);\n");
        _ = await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, packaged);
        await AssertBindsPackageAsync(manager, packaged, "once the restore settled");

        // 3 — THE INVARIANT, asserted with no settle in between. The neighbour uses
        //     JObject without a directive, so its own load cannot possibly succeed —
        //     which is exactly the load that used to take the packaged root down.
        var unpackaged = _fixture.Write("RootWithoutPackage.cs", UnpackagedRoot);
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, unpackaged)).IsError);
        await AssertBindsPackageAsync(
            manager,
            packaged,
            "#294: opening a neighbouring root EVICTED this root's #:package reference. "
                + "A later rebind does not repair this — the root was broken for real, and "
                + "only recovered once something re-resolved it"
        );

        // 4 — the original direction still holds: the package must NOT leak.
        var leaked = await SettledErrorsAsync(manager, unpackaged);
        Assert.Contains(leaked, error => string.Equals(error.Code, "CS0246", StringComparison.Ordinal));

        // 5 — and the packaged root is STILL bound after the neighbour settled too.
        await AssertBindsPackageAsync(manager, packaged, "after the neighbour settled");
    }

    /// <summary>
    /// Reopening a root replaces only itself. The replace path removes the outgoing
    /// project from the live solution, so it must not take a sibling's state with it.
    /// </summary>
    [Fact]
    public async Task Reopening_one_root_leaves_its_neighbours_untouched()
    {
        // 1 — two roots, both loaded, one carrying an unsaved edit.
        var first = _fixture.Write("First.cs", "Console.WriteLine(Missing());\n");
        var second = _fixture.Write("Second.cs", PlainRoot);
        using var manager = new WorkspaceManager();
        await OpenAndSettleAsync(manager, first);
        await OpenAndSettleAsync(manager, second);
        await ApplyLiveEditAsync(manager, first, "Console.WriteLine(2);\n");
        await AssertNoErrorsAsync(manager, first, "after the live edit");

        // 2 — the host reopens the SECOND root, which replaces that project.
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, second)).IsError);
        await AssertNoErrorsAsync(
            manager,
            first,
            "reopening a sibling discarded this root's unsaved edit"
        );

        // 3 — and the reopened root is served exactly once, not duplicated.
        await AssertNoErrorsAsync(manager, second, "the reopened root");
        var reopened = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, second);
        Assert.DoesNotContain(
            reopened,
            diagnostic => string.Equals(diagnostic.Code, "CS0017", StringComparison.Ordinal)
        );
    }

    /// <summary>Open a root and block until its background restore has settled.</summary>
    private static async Task OpenAndSettleAsync(WorkspaceManager manager, string path)
    {
        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, path)
            .ConfigureAwait(false);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        _ = await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, path)
            .ConfigureAwait(false);
    }

    /// <summary>Change a document's text in the editor only, never on disk.</summary>
    private static async Task ApplyLiveEditAsync(
        WorkspaceManager manager,
        string path,
        string newText
    )
    {
        var edit = await manager.UpdateDocumentTextAsync(path, newText).ConfigureAwait(false);
        Assert.False(edit.IsError, edit.Match(_ => "ok", error => error));
    }

    /// <summary>The error diagnostics for a path once its restore has settled.</summary>
    private static async Task<List<DiagnosticResult>> SettledErrorsAsync(
        WorkspaceManager manager,
        string path
    )
    {
        var settled = await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, path)
            .ConfigureAwait(false);
        return
        [
            .. settled.Where(diagnostic =>
                string.Equals(diagnostic.Severity, "error", StringComparison.OrdinalIgnoreCase)
            ),
        ];
    }

    private static async Task AssertNoErrorsAsync(
        WorkspaceManager manager,
        string path,
        string when
    )
    {
        var errors = await ProjectlessWorkspaceFixture.ErrorsAsync(manager, path)
            .ConfigureAwait(false);
        Assert.True(errors.Count == 0, $"{when} — {Describe(errors)}");
    }

    /// <summary>
    /// The root binds its package AND is not back on a restore-pending placeholder.
    /// A reappearing <c>SLSPC0002</c> is the signature of the root's project having
    /// been rebuilt underneath it, which is the eviction even when the compilation
    /// has not gone red yet.
    /// </summary>
    private static async Task AssertBindsPackageAsync(
        WorkspaceManager manager,
        string path,
        string when
    )
    {
        var diagnostics = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, path)
            .ConfigureAwait(false);
        var binding = diagnostics
            .Where(diagnostic => PackageBindingErrorCodes.Contains(diagnostic.Code))
            .ToList();
        Assert.True(binding.Count == 0, $"{when} — {Describe(binding)}");
        Assert.DoesNotContain(
            diagnostics,
            diagnostic =>
                string.Equals(
                    diagnostic.Code,
                    ProjectlessWorkspaceFixture.RestorePendingCode,
                    StringComparison.Ordinal
                )
        );
    }

    private static string Describe(IEnumerable<DiagnosticResult> diagnostics)
    {
        var listed = diagnostics
            .Select(diagnostic => $"{diagnostic.Code}: {diagnostic.Message}")
            .ToList();
        return listed.Count == 0 ? "no diagnostics" : string.Join(" | ", listed);
    }
}
