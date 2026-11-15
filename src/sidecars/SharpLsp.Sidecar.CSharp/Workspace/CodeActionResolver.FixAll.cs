using System.Collections.Concurrent;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.Diagnostics;
using Serilog;
using ResolveResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The fix-all half of the code-action pipeline ([FIXALL-SCOPES], GitHub #577).
/// A fix whose provider has a <see cref="FixAllProvider"/> is offered at
/// document, project and solution scope; the request carries the action's
/// equivalence key — occurrences are found by that key, never by title.
/// </summary>
internal sealed partial class CodeActionResolver
{
    /// <summary>
    /// The reason a fix-all for an unknown key fails: the listing that offered
    /// it is gone. [REFACTOR-NEVER-SILENT]
    /// </summary>
    internal const string StaleFixAllReason =
        "the fix-all action is no longer available: the fix was offered against a "
        + "document state that no longer exists; invoke it again";

    /// <summary>The provider behind every fix key seen while listing fixes.</summary>
    private readonly ConcurrentDictionary<string, CodeFixProvider> _fixAllProviders = new();

    /// <summary>
    /// Resolve a fix-all to one workspace edit over the scope, computed through
    /// Roslyn's <see cref="FixAllContext"/>. A fix-all that fixes nothing fails
    /// with a reason in plain words — never an empty edit. [REFACTOR-NEVER-SILENT]
    /// </summary>
    public async Task<ResolveResult> FixAllAsync(
        Document anchor,
        string fixKey,
        string scope,
        CancellationToken ct
    )
    {
        if (!_fixAllProviders.TryGetValue(fixKey, out var provider))
        {
            return FixAllFailure(fixKey, StaleFixAllReason);
        }
        var fixAllScope = ScopeOf(scope);
        return fixAllScope is null
            ? FixAllFailure(fixKey, $"the scope '{scope}' is not one this fix supports")
            : await FixAllAsync(anchor, provider, provider.GetFixAllProvider()!, fixAllScope.Value, fixKey, ct)
                .ConfigureAwait(false);
    }

    private static async Task<ResolveResult> FixAllAsync(
        Document anchor,
        CodeFixProvider provider,
        FixAllProvider fixAllProvider,
        FixAllScope scope,
        string fixKey,
        CancellationToken ct
    )
    {
        var context = new FixAllContext(
            anchor,
            provider,
            scope,
            fixKey,
            fixAllProvider.GetSupportedFixAllDiagnosticIds(provider),
            new StyleDiagnosticProvider(
                provider.FixableDiagnosticIds.ToImmutableHashSet(StringComparer.Ordinal),
                CachedDiagnosticAnalyzers.Value
            ),
            ct
        );
        var action = await fixAllProvider.GetFixAsync(context).ConfigureAwait(false);
        return action is null
            ? FixAllFailure(fixKey, $"no occurrences of the fix '{fixKey}' remain in the {scope}")
            : await ApplyFixAllAsync(fixKey, anchor.Project.Solution, action, ct)
                .ConfigureAwait(false);
    }

    private static async Task<ResolveResult> ApplyFixAllAsync(
        string fixKey,
        Solution solution,
        Microsoft.CodeAnalysis.CodeActions.CodeAction action,
        CancellationToken ct
    )
    {
        var operations = await action.GetOperationsAsync(ct).ConfigureAwait(false);
        var applyOp = operations.OfType<Microsoft.CodeAnalysis.CodeActions.ApplyChangesOperation>()
            .FirstOrDefault();
        return applyOp is null
            ? FixAllFailure(fixKey, $"fixing every occurrence of '{fixKey}' produced no changes")
            : await ResolveChangesAsync(action.Title, solution, applyOp, ct)
                .ConfigureAwait(false);
    }

    /// <summary>
    /// The fix-all capability of one listed fix: its equivalence key and the
    /// supported scopes. Null when the provider has no fix-all, supports none of
    /// the offered scopes, or the action carries no equivalence key.
    /// [FIXALL-SCOPES]
    /// </summary>
    internal static FixAllCapability? FixAllCapabilityOf(CodeFixProvider provider, CodeAction action)
    {
        var scopes = SupportedFixAllScopes(provider);
        return scopes.IsEmpty || string.IsNullOrEmpty(action.EquivalenceKey)
            ? null
            : new FixAllCapability(action.EquivalenceKey, scopes, provider);
    }

    /// <summary>The offered scopes of a provider's fix-all: document, project, solution.</summary>
    private static ImmutableArray<string> SupportedFixAllScopes(CodeFixProvider provider)
    {
        try
        {
            var fixAll = provider.GetFixAllProvider();
            return fixAll is null
                ? []
                : [.. fixAll.GetSupportedFixAllScopes().Select(ScopeName).OfType<string>()];
        }
        catch (Exception ex)
        {
            Log.Debug(
                ex,
                "[CodeAction] Fix-all provider of {Provider} threw while listing scopes",
                provider.GetType().Name
            );
            return [];
        }
    }

    private static string? ScopeName(FixAllScope scope)
    {
        return scope switch
        {
            FixAllScope.Document => "document",
            FixAllScope.Project => "project",
            FixAllScope.Solution => "solution",
            FixAllScope.ContainingMember => null,
            FixAllScope.ContainingType => null,
            FixAllScope.Custom => null,
            _ => null,
        };
    }

    private static FixAllScope? ScopeOf(string scope)
    {
        return scope switch
        {
            "document" => FixAllScope.Document,
            "project" => FixAllScope.Project,
            "solution" => FixAllScope.Solution,
            _ => null,
        };
    }

    private static ResolveResult FixAllFailure(string fixKey, string reason)
    {
        // [REFACTOR-NEVER-SILENT]: a fix-all that fixes nothing must explain it.
        Log.Warning("[CodeAction] Fix-all {FixKey} refused: {Reason}", fixKey, reason);
        return ResolveResult.Failure(reason);
    }

    /// <summary>
    /// Feeds a <see cref="FixAllContext"/> from the sidecar's own analyzer
    /// pipeline: every reportable style diagnostic of a document, filtered to
    /// the provider's fixable ids. Project-level diagnostics — those with no
    /// source location — do not exist for style fixes and answer empty.
    /// [FIXALL-SCOPES]
    /// </summary>
    private sealed class StyleDiagnosticProvider(
        ImmutableHashSet<string> fixableIds,
        ImmutableArray<DiagnosticAnalyzer> analyzers
    ) : FixAllContext.DiagnosticProvider
    {
        public override async Task<IEnumerable<Diagnostic>> GetDocumentDiagnosticsAsync(
            Document document,
            CancellationToken ct
        )
        {
            var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (model is null)
            {
                return [];
            }
            var diagnostics = await AnalyzerDiagnosticResolver
                .ResolveDocumentAsync(document, model, analyzers, ct)
                .ConfigureAwait(false);
            return diagnostics.Where(diagnostic => fixableIds.Contains(diagnostic.Id));
        }

        /// <summary>Every fixable diagnostic of every document in the project.</summary>
        public override async Task<IEnumerable<Diagnostic>> GetAllDiagnosticsAsync(
            Project project,
            CancellationToken ct
        )
        {
            var perDocument = await Task.WhenAll(
                    project.Documents.Select(document => GetDocumentDiagnosticsAsync(document, ct))
                )
                .ConfigureAwait(false);
            return perDocument.SelectMany(diagnostic => diagnostic);
        }

        public override Task<IEnumerable<Diagnostic>> GetProjectDiagnosticsAsync(
            Project project,
            CancellationToken ct
        )
        {
            return Task.FromResult<IEnumerable<Diagnostic>>([]);
        }
    }
}

/// <summary>
/// A listed fix's fix-all identity: the equivalence key, the scopes its
/// provider supports, and the provider itself for the later resolve.
/// [FIXALL-SCOPES]
/// </summary>
internal sealed record FixAllCapability(
    string FixKey,
    ImmutableArray<string> Scopes,
    CodeFixProvider Provider
);
