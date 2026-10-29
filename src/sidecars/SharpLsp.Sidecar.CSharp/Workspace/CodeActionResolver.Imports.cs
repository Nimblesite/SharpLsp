using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Serilog;
using SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The quick fixes that bring an unresolved name into scope. The import fixes the providers
/// offered are retitled from the change each makes; SharpLsp adds the rows that import only the
/// type and its static container, and — when nothing in reach declares the name — the rows that
/// reference another project or a package first. Implements [REFACTOR-IMPORT-CSHARP] and the C#
/// side of [REFACTOR-IMPORT-REFERENCE].
/// </summary>
internal sealed partial class CodeActionResolver
{
    private const string QuickFix = "quickfix";

    private async Task CollectImportFixesAsync(
        Document document,
        TextSpan span,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        var subjects = await ImportSubject.FindAsync(document, span, ct).ConfigureAwait(false);
        // Only the providers' own fixes are retitled, never the rows added below.
        var offered = items.Where(item => item.Kind == QuickFix).ToList();
        foreach (var subject in subjects)
        {
            await CollectImportFixesAsync(document, subject, offered, items, ct)
                .ConfigureAwait(false);
        }
        _ = items.RemoveAll(Repeated(items));
    }

    private async Task CollectImportFixesAsync(
        Document document,
        ImportSubject subject,
        List<CodeActionItem> offered,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        try
        {
            var imports = await RetitleOfferedAsync(document, subject, offered, ct)
                .ConfigureAwait(false);
            var own = await OwnImportFixesAsync(document, subject, imports, ct)
                .ConfigureAwait(false);
            AddImportFixes(own, items);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            Log.Warning(
                error,
                "[CodeAction] Import fixes for {DiagnosticId} on {Name} failed",
                subject.Diagnostic.Id,
                subject.Text
            );
        }
    }

    /// <summary>Retitle every offered quick fix whose change imports the subject; the rest stay as offered.</summary>
    private async Task<ImmutableArray<RetitledImport>> RetitleOfferedAsync(
        Document document,
        ImportSubject subject,
        List<CodeActionItem> offered,
        CancellationToken ct
    )
    {
        var retitled = ImmutableArray.CreateBuilder<RetitledImport>();
        foreach (var item in offered)
        {
            var import = _pendingActions.TryGetValue(item.Id, out var action)
                ? await ImportRetitling
                    .RetitleAsync(document, subject, action, ct)
                    .ConfigureAwait(false)
                : null;
            if (import is not null)
            {
                item.Title = import.Action.Title;
                _pendingActions[item.Id] = import.Action;
                retitled.Add(import);
            }
        }
        return retitled.ToImmutable();
    }

    /// <summary>A predicate true for every item whose title and kind an earlier item already has.</summary>
    private static Predicate<CodeActionItem> Repeated(List<CodeActionItem> items)
    {
        var seen = new HashSet<(string, string)>();
        var keep = items.Where(item => seen.Add((item.Title, item.Kind))).ToHashSet();
        return item => !keep.Contains(item);
    }

    /// <summary>The rows SharpLsp offers itself; the reference rows only when nothing in reach declares the name.</summary>
    private static async Task<ImmutableArray<ImportFix>> OwnImportFixesAsync(
        Document document,
        ImportSubject subject,
        ImmutableArray<RetitledImport> offered,
        CancellationToken ct
    )
    {
        var namespaces = offered.Select(import => import.Namespace).OfType<string>();
        var aliases = await AliasImportFixes
            .OfferAsync(document, subject, namespaces, ct)
            .ConfigureAwait(false);
        var statics = await StaticImportFixes
            .OfferAsync(document, subject, ct)
            .ConfigureAwait(false);
        return offered.IsEmpty && aliases.IsEmpty && statics.IsEmpty
            ? await ReferenceImportFixes.OfferAsync(document, subject, ct).ConfigureAwait(false)
            : [.. aliases, .. statics];
    }

    private void AddImportFixes(ImmutableArray<ImportFix> fixes, List<CodeActionItem> items)
    {
        foreach (var fix in fixes.Where(fix => !IsDuplicate(fix.Action.Title, QuickFix, items)))
        {
            items.Add(CacheImport(fix));
        }
    }

    private CodeActionItem CacheImport(ImportFix fix)
    {
        var id = Interlocked.Increment(ref _nextId);
        _pendingActions[id] = fix.Action;
        return new CodeActionItem
        {
            Id = id,
            Title = fix.Action.Title,
            Kind = QuickFix,
            IsPreferred = fix.Preferred,
            Reference = fix.Reference,
        };
    }
}
