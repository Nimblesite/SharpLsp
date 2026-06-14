using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // File/Path banned for analyzers — we're tests, not analyzers
#pragma warning disable CA2007 // ConfigureAwait not needed in test helpers
#pragma warning disable IDE0058 // Expression value is never used (AddProject builder chain)

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Direct-resolver coverage tests for <see cref="CodeActionResolver"/> over an
/// <see cref="AdhocWorkspace"/>. These drive the otherwise-uncovered RESOLVE
/// path — <c>ResolveAsync</c>, <c>BuildWorkspaceEditAsync</c>,
/// <c>CollectChangedDocumentsAsync</c>, <c>CollectAddedDocumentsAsync</c> and
/// <c>ComputeTextEditsAsync</c> — by feeding the resolver a document with a real
/// fixable diagnostic (CS0219 "variable assigned but its value is never used")
/// and a real file path so the produced edits flow all the way into a
/// <see cref="WorkspaceEditResult"/>. No MSBuild is used, so the tests run
/// identically on any machine.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2000:Dispose objects before losing scope",
    Justification = "Workspace is kept alive for the duration of the test"
)]
public sealed class CodeActionResolverCoverageTests
{
    // CS0219: the local `x` is assigned but never used. The Roslyn
    // "Remove unused variable" code fix is registered against CS0219 and
    // produces a real ApplyChangesOperation when resolved.
    private const string UnusedVariableSource = """
        class C
        {
            void M()
            {
                int x = 1;
            }
        }
        """;

    [Fact]
    public async Task GetCodeActions_over_unused_variable_returns_remove_variable_quickfix()
    {
        var resolver = new CodeActionResolver();
        var (document, _) = CreateWithFilePath(UnusedVariableSource, "/virtual/Unused.cs");
        var span = await FullSpanAsync(document);

        var items = await resolver.GetCodeActionsAsync(document, span, CancellationToken.None);

        Assert.NotNull(items);
        // The "Remove unused variable" fix must surface as a quickfix.
        Assert.Contains(
            items,
            item =>
                item.Kind == "quickfix"
                && item.Title.Contains("Remove unused variable", StringComparison.Ordinal)
        );
        // Every emitted action must carry a positive, unique id and a non-empty title.
        Assert.All(items, item => Assert.True(item.Id > 0));
        Assert.All(items, item => Assert.False(string.IsNullOrWhiteSpace(item.Title)));
        Assert.Equal(items.Count, items.Select(i => i.Id).Distinct().Count());
    }

    [Fact]
    public async Task Resolve_remove_variable_fix_produces_changed_document_edits()
    {
        var resolver = new CodeActionResolver();
        const string filePath = "/virtual/Resolve.cs";
        var (document, solution) = CreateWithFilePath(UnusedVariableSource, filePath);
        var span = await FullSpanAsync(document);

        var items = await resolver.GetCodeActionsAsync(document, span, CancellationToken.None);
        var removeVariable = RemoveVariableFix(items);

        var edit = await resolver.ResolveAsync(removeVariable.Id, solution, CancellationToken.None);

        // Resolving an applicable fix must yield a workspace edit that changes
        // exactly the source file.
        Assert.NotNull(edit);
        var docChange = Assert.Single(edit!.DocumentChanges);
        Assert.Equal(filePath, docChange.FilePath);
        Assert.NotEmpty(docChange.Edits);

        // The text edits must describe coordinates inside the original document
        // (non-negative line/character; end never precedes start line).
        Assert.All(
            docChange.Edits,
            te =>
            {
                Assert.True(te.StartLine >= 0);
                Assert.True(te.StartCharacter >= 0);
                Assert.True(te.EndLine >= te.StartLine);
            }
        );
        // At least one edit must touch the line containing the unused declaration.
        var declLine = LineOf(UnusedVariableSource, "int x = 1;");
        Assert.Contains(docChange.Edits, te => te.StartLine <= declLine && te.EndLine >= declLine);
    }

    [Fact]
    public async Task Resolve_removes_unused_variable_from_resulting_source()
    {
        var resolver = new CodeActionResolver();
        const string filePath = "/virtual/Apply.cs";
        var (document, solution) = CreateWithFilePath(UnusedVariableSource, filePath);
        var span = await FullSpanAsync(document);

        var items = await resolver.GetCodeActionsAsync(document, span, CancellationToken.None);
        var removeVariable = RemoveVariableFix(items);

        var edit = await resolver.ResolveAsync(removeVariable.Id, solution, CancellationToken.None);
        Assert.NotNull(edit);

        // Apply the returned edits to the original text and confirm the unused
        // declaration is gone. This proves ComputeTextEditsAsync emitted
        // correct, applicable spans.
        var original = await document.GetTextAsync(CancellationToken.None);
        var applied = ApplyEdits(original, edit!.DocumentChanges.Single().Edits);

        Assert.DoesNotContain("int x = 1;", applied, StringComparison.Ordinal);
        // The enclosing method and class survive.
        Assert.Contains("class C", applied, StringComparison.Ordinal);
        Assert.Contains("void M()", applied, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Resolve_same_action_twice_returns_null_on_second_call()
    {
        var resolver = new CodeActionResolver();
        var (document, solution) = CreateWithFilePath(UnusedVariableSource, "/virtual/Twice.cs");
        var span = await FullSpanAsync(document);

        var items = await resolver.GetCodeActionsAsync(document, span, CancellationToken.None);
        var first = RemoveVariableFix(items);

        // First resolve consumes (TryRemove) the cached action.
        var firstResult = await resolver.ResolveAsync(first.Id, solution, CancellationToken.None);
        Assert.NotNull(firstResult);

        // Second resolve of the same id must miss the cache and return null.
        var secondResult = await resolver.ResolveAsync(first.Id, solution, CancellationToken.None);
        Assert.Null(secondResult);
    }

    [Fact]
    public async Task Resolve_unknown_id_returns_null()
    {
        var resolver = new CodeActionResolver();
        var (_, solution) = CreateWithFilePath(UnusedVariableSource, "/virtual/Unknown.cs");

        var result = await resolver.ResolveAsync(int.MaxValue, solution, CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task GetCodeActions_clean_span_with_no_diagnostics_skips_quickfixes()
    {
        var resolver = new CodeActionResolver();
        const string clean = """
            class C
            {
                int M()
                {
                    var x = 1;
                    return x;
                }
            }
            """;
        var (document, _) = CreateWithFilePath(clean, "/virtual/Clean.cs");
        var span = await FullSpanAsync(document);

        var items = await resolver.GetCodeActionsAsync(document, span, CancellationToken.None);

        // No fixable diagnostics in this span — there must be no quickfixes,
        // though refactorings may still appear.
        Assert.NotNull(items);
        Assert.DoesNotContain(items, item => item.Kind == "quickfix");
    }

    [Fact]
    public async Task GetCodeActions_empty_span_outside_diagnostic_returns_no_quickfix()
    {
        var resolver = new CodeActionResolver();
        var (document, _) = CreateWithFilePath(UnusedVariableSource, "/virtual/EmptySpan.cs");

        // An empty span at the very end of the file covers no diagnostic, so the
        // diagnostics collection is empty and CollectCodeFixesAsync returns early.
        var text = await document.GetTextAsync(CancellationToken.None);
        var span = new TextSpan(text.Length, 0);

        var items = await resolver.GetCodeActionsAsync(document, span, CancellationToken.None);

        Assert.NotNull(items);
        Assert.DoesNotContain(items, item => item.Kind == "quickfix");
    }

    [Fact]
    public async Task Resolve_cancelled_token_throws_operation_cancelled()
    {
        var resolver = new CodeActionResolver();
        var (document, solution) = CreateWithFilePath(UnusedVariableSource, "/virtual/Cancel.cs");
        var span = await FullSpanAsync(document);

        var items = await resolver.GetCodeActionsAsync(document, span, CancellationToken.None);
        var fix = RemoveVariableFix(items);

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        // GetOperationsAsync honours the cancellation token inside ResolveAsync.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await resolver.ResolveAsync(fix.Id, solution, cts.Token)
        );
    }

    [Fact]
    public async Task GetCodeActions_cancelled_token_throws()
    {
        var resolver = new CodeActionResolver();
        var (document, _) = CreateWithFilePath(UnusedVariableSource, "/virtual/CancelGet.cs");
        var span = await FullSpanAsync(document);

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await resolver.GetCodeActionsAsync(document, span, cts.Token)
        );
    }

    // ── helpers ──────────────────────────────────────────────────────

    private static CodeActionItem RemoveVariableFix(List<CodeActionItem> items)
    {
        return items.First(item =>
            item.Kind == "quickfix"
            && item.Title.Contains("Remove unused variable", StringComparison.Ordinal)
        );
    }

    private static int LineOf(string source, string fragment)
    {
        var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (lines[i].Contains(fragment, StringComparison.Ordinal))
            {
                return i;
            }
        }

        throw new InvalidOperationException($"fragment '{fragment}' not found");
    }

    private static async Task<TextSpan> FullSpanAsync(Document document)
    {
        var text = await document.GetTextAsync(CancellationToken.None);
        return new TextSpan(0, text.Length);
    }

    private static string ApplyEdits(SourceText original, List<TextEditResult> edits)
    {
        // Translate (line, character) edits back into TextChanges and apply them.
        var changes = edits.Select(edit =>
        {
            var start = original.Lines[edit.StartLine].Start + edit.StartCharacter;
            var end = original.Lines[edit.EndLine].Start + edit.EndCharacter;
            return new TextChange(TextSpan.FromBounds(start, end), edit.NewText);
        });
        return original.WithChanges(changes).ToString();
    }

    private static (Document document, Solution solution) CreateWithFilePath(
        string source,
        string filePath
    )
    {
        // Mirror RoslynTestWorkspace.Create but attach a real FilePath so the
        // edit-collection path in CodeActionResolver populates DocumentChanges.
        var workspace = new AdhocWorkspace();
        var projectId = ProjectId.CreateNewId();
        var project = workspace.AddProject(
            ProjectInfo
                .Create(
                    projectId,
                    VersionStamp.Default,
                    "TestProject",
                    "TestProject",
                    LanguageNames.CSharp
                )
                .WithCompilationOptions(
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                .WithMetadataReferences(ReferenceAssemblies())
        );

        var documentInfo = DocumentInfo.Create(
            DocumentId.CreateNewId(project.Id),
            name: Path.GetFileName(filePath),
            loader: TextLoader.From(
                TextAndVersion.Create(SourceText.From(source), VersionStamp.Default)
            ),
            filePath: filePath
        );
        var document = workspace.AddDocument(documentInfo);
        return (document, workspace.CurrentSolution);
    }

    private static List<MetadataReference> ReferenceAssemblies()
    {
        var refs = new List<MetadataReference>
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Console).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Enumerable).Assembly.Location),
        };

        var runtimeDir =
            Path.GetDirectoryName(typeof(object).Assembly.Location)
            ?? throw new InvalidOperationException("Runtime directory not found");
        foreach (
            var name in new[] { "System.Runtime.dll", "netstandard.dll", "System.Collections.dll" }
        )
        {
            var path = Path.Combine(runtimeDir, name);
            if (File.Exists(path))
            {
                refs.Add(MetadataReference.CreateFromFile(path));
            }
        }

        return refs;
    }
}
