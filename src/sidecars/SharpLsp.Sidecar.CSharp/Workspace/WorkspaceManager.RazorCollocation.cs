using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Serilog;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The collocated files of a Razor file: the stylesheet its CSS isolation declares
/// (<c>Card.razor.css</c>) and the JavaScript module it imports (<c>Card.razor.js</c>).
/// Implements [RAZOR-COLLOCATION].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// The items the collocated stylesheet adds at a caret inside a <c>class</c> value; none
    /// elsewhere or when the file has no stylesheet. [RAZOR-COLLOCATION-CSS]
    /// </summary>
    private static async Task<List<CompletionItem>> CollocatedClassCompletionsAsync(
        TextDocument? razor,
        RazorMarkup markup,
        int offset,
        CancellationToken ct
    )
    {
        return
            razor is not null
            && RazorCollocation.ClassValueAt(markup, offset) is { } at
            && await CollocatedStylesheetAsync(razor, ct).ConfigureAwait(false) is { } stylesheet
            ? RazorCollocation.ClassCompletions(markup, stylesheet, at)
            : [];
    }

    /// <summary>The start of the collocated module an import call at the target's position names.</summary>
    private static async Task<LocationListResult> ModuleStartAsync(
        QueryTarget target,
        CancellationToken ct
    )
    {
        var module = await ImportedModuleAsync(target, ct).ConfigureAwait(false);
        return module is null
            ? new LocationListResult()
            : new LocationListResult { Locations = [StartOf(module)] };
    }

    /// <summary>The selectors of the class named in a <c>class</c> value's collocated stylesheet. [RAZOR-COLLOCATION-CSS]</summary>
    private async Task<LocationListResult> CollocatedClassDefinitionAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var razor = FindRazorDocument(filePath);
        if (razor is null)
        {
            return new LocationListResult();
        }

        var markup = await RazorMarkupEngine.ProcessAsync(razor, ct).ConfigureAwait(false);
        return
            markup is not null
            && DocumentText.TryOffset(markup.Text, new LinePosition(line, character)) is { } offset
            && RazorCollocation.ClassValueAt(markup, offset) is { } at
            && await CollocatedStylesheetAsync(razor, ct).ConfigureAwait(false) is { } stylesheet
            ? RazorCollocation.ClassDefinitions(markup, stylesheet, at)
            : new LocationListResult();
    }

    /// <summary>
    /// The stylesheet beside <paramref name="razor"/>, from its project's own copy of the file
    /// when it lists one, else read from disk: an editor never sends a stylesheet as a document
    /// ([RAZOR-COLLOCATION-CSS]).
    /// </summary>
    private static async Task<RazorStylesheet?> CollocatedStylesheetAsync(
        TextDocument razor,
        CancellationToken ct
    )
    {
        var path = NativePaths.StylesheetOf(razor.FilePath ?? "");
        var buffered = razor.Project.AdditionalDocuments.FirstOrDefault(document =>
            NativePaths.AreEqual(document.FilePath, path)
        );
        var text = buffered is null
            ? await ReadCollocatedTextAsync(path, ct).ConfigureAwait(false)
            : await buffered.GetTextAsync(ct).ConfigureAwait(false);
        return text is null ? null : RazorStylesheet.Parse(path, text);
    }

    private static async Task<SourceText?> ReadCollocatedTextAsync(
        string path,
        CancellationToken ct
    )
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return SourceText.From(await File.ReadAllTextAsync(path, ct).ConfigureAwait(false));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warning("[Razor] collocated file unreadable {File} {Failure}", path, ex.GetType());
            return null;
        }
    }

    /// <summary>The collocated module file an import call at a position names in the project.</summary>
    private static async Task<string?> ImportedModuleAsync(QueryTarget target, CancellationToken ct)
    {
        return
            await ModuleLiteralAsync(target, ct).ConfigureAwait(false) is { } literal
            && await target.Document.GetSemanticModelAsync(ct).ConfigureAwait(false) is { } model
            && RazorCollocation.ImportedModule(model, literal, ct) is { } path
            ? ModuleTarget(target.Document.Project, path)
            : null;
    }

    /// <summary>The string literal at the target's position, when the caret sits in one.</summary>
    private static async Task<LiteralExpressionSyntax?> ModuleLiteralAsync(
        QueryTarget target,
        CancellationToken ct
    )
    {
        var root = await target.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var text = await target.Document.GetTextAsync(ct).ConfigureAwait(false);
        return
            root is not null
            && DocumentText.TryOffset(text, new LinePosition(target.Line, target.Character))
                is { } offset
            ? RazorCollocation.ModuleLiteral(root, offset)
            : null;
    }

    /// <summary>The module file <paramref name="path"/> names in the project, when it exists.</summary>
    private static string? ModuleTarget(Project project, string path)
    {
        return
            project.FilePath is not null
            && RazorCollocation.ModuleFile(NativePaths.DirectoryOf(project.FilePath), path)
                is { } module
            && File.Exists(module)
            ? module
            : null;
    }

    /// <summary>A definition location at the very start of <paramref name="filePath"/>.</summary>
    private static LocationResult StartOf(string filePath)
    {
        return new LocationResult { FilePath = filePath };
    }
}
