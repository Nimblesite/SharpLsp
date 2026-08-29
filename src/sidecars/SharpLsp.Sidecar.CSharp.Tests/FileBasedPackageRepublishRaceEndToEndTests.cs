using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes.
#pragma warning disable CA1515

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Regression coverage for the torn diagnostics answer that strands phantom
/// <c>CS0246</c>s in the editor after a <c>#:package</c> restore settles.
///
/// The editor host republishes a file-based app's diagnostics only while the
/// answer carries the <c>SLSPC0002</c> restore-pending notice; the first answer
/// without it is treated as final ([DIAG-PUSH-GATE]). An answer that pairs a
/// pre-upgrade tier-2 compilation (package errors present) with a post-upgrade
/// notice state (notice absent) is therefore poison: the host stops polling and
/// the placeholder's errors stay on screen for the life of the document even
/// though hover and completion already bind the restored package.
/// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK] and [SCRIPT-RELOAD].
/// </summary>
public sealed class FileBasedPackageRepublishRaceEndToEndTests : IDisposable
{
    private const string WithoutDirective =
        "using Newtonsoft.Json.Linq;\nvar payload = new JObject();\nConsole.WriteLine(payload.Count);\n";
    private const string WithDirective = "#:package Newtonsoft.Json@13.0.3\n" + WithoutDirective;
    private static readonly string[] PackageBindingErrorCodes = ["CS0246", "CS0234", "CS0103"];

    private readonly ProjectlessWorkspaceFixture _fixture = new("republish");

    public void Dispose()
    {
        _fixture.Dispose();
    }

    /// <summary>
    /// Drives the exact add → remove → re-add cycle of the VS Code e2e suite while
    /// polling diagnostics back to back, the way the host's push loop does. Every
    /// single answer during a directive-carrying phase must be self-consistent:
    /// package-binding errors may only appear together with a tier-2 notice
    /// (<c>SLSPC0002</c> pending or <c>SLSPC0001</c> failed). One torn answer is
    /// one editor stuck with phantom errors.
    /// </summary>
    [Fact]
    public async Task Package_errors_are_never_reported_without_a_tier2_notice_across_directive_cycles()
    {
        var app = _fixture.Write("Torn.cs", WithDirective);
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);
        await AssertSettlesWithoutTornAnswerAsync(manager, app);

        for (var cycle = 0; cycle < 3; cycle++)
        {
            await RemoveDirectiveAndSettleAsync(manager, app);
            await ReAddDirectiveAsync(manager, app);
            await AssertSettlesWithoutTornAnswerAsync(manager, app);
        }
    }

    /// <summary>
    /// The directive is present: poll without pauses until the pending notice
    /// clears, asserting every answer on the way, then require the settled
    /// answer to actually bind the package.
    /// </summary>
    private static async Task AssertSettlesWithoutTornAnswerAsync(
        WorkspaceManager manager,
        string app
    )
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromMinutes(2);
        while (true)
        {
            var diagnostics = await ProjectlessWorkspaceFixture
                .DiagnosticsAsync(manager, app)
                .ConfigureAwait(false);
            AssertAnswerIsNotTorn(diagnostics);
            if (!ContainsCode(diagnostics, ProjectlessWorkspaceFixture.RestorePendingCode))
            {
                AssertSettledAnswerBinds(diagnostics);
                return;
            }

            Assert.True(
                DateTime.UtcNow < deadline,
                "file-based package resolution never settled for the directive-carrying text"
            );
        }
    }

    private static void AssertAnswerIsNotTorn(IReadOnlyList<DiagnosticResult> diagnostics)
    {
        var bindingErrors = diagnostics
            .Where(diagnostic => PackageBindingErrorCodes.Contains(diagnostic.Code))
            .ToList();
        var hasNotice =
            ContainsCode(diagnostics, ProjectlessWorkspaceFixture.RestorePendingCode)
            || ContainsCode(diagnostics, ProjectlessWorkspaceFixture.DegradationCode);
        Assert.True(
            bindingErrors.Count == 0 || hasNotice,
            "torn diagnostics answer: package-binding errors "
                + $"[{string.Join(", ", bindingErrors.Select(error => error.Code))}] were reported "
                + "with no tier-2 notice — the editor host treats this answer as final and "
                + "never republishes, stranding the phantom errors ([DIAG-PUSH-GATE])"
        );
    }

    private static void AssertSettledAnswerBinds(IReadOnlyList<DiagnosticResult> diagnostics)
    {
        Assert.DoesNotContain(
            diagnostics,
            diagnostic =>
                string.Equals(
                    diagnostic.Code,
                    ProjectlessWorkspaceFixture.DegradationCode,
                    StringComparison.Ordinal
                )
        );
        Assert.DoesNotContain(
            diagnostics,
            diagnostic =>
                string.Equals(diagnostic.Severity, "error", StringComparison.OrdinalIgnoreCase)
        );
    }

    /// <summary>
    /// The directive was removed: the package errors are the CORRECT settled
    /// answer here, so only the pending notice's disappearance is awaited.
    /// </summary>
    private static async Task RemoveDirectiveAndSettleAsync(WorkspaceManager manager, string app)
    {
        var updated = await manager
            .UpdateDocumentTextAsync(app, WithoutDirective)
            .ConfigureAwait(false);
        Assert.False(updated.IsError, updated.Match(_ => "ok", error => error));
        var diagnostics = await ProjectlessWorkspaceFixture
            .SettledDiagnosticsAsync(manager, app)
            .ConfigureAwait(false);
        Assert.Contains(
            diagnostics,
            diagnostic => string.Equals(diagnostic.Code, "CS0246", StringComparison.Ordinal)
        );
    }

    private static async Task ReAddDirectiveAsync(WorkspaceManager manager, string app)
    {
        var updated = await manager
            .UpdateDocumentTextAsync(app, WithDirective)
            .ConfigureAwait(false);
        Assert.False(updated.IsError, updated.Match(_ => "ok", error => error));
    }

    private static bool ContainsCode(IReadOnlyList<DiagnosticResult> diagnostics, string code)
    {
        return diagnostics.Any(diagnostic =>
            string.Equals(diagnostic.Code, code, StringComparison.Ordinal)
        );
    }
}
