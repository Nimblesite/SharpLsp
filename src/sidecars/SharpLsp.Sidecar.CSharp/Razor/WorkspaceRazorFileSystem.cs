using System.Text;
using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// The Razor engine's view of a project's files: the file being processed and every import
/// file (<c>_Imports.razor</c>, <c>_ViewImports.cshtml</c>), all with the workspace's current
/// text, so imports resolve as the compiler resolves them, unsaved edits included.
/// Implements [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
internal sealed class WorkspaceRazorFileSystem : RazorProjectFileSystem
{
    private readonly Dictionary<string, WorkspaceRazorItem> _items;
    private readonly string _projectDirectory;

    private WorkspaceRazorFileSystem(
        string projectDirectory,
        Dictionary<string, WorkspaceRazorItem> items
    )
    {
        _projectDirectory = projectDirectory;
        _items = items;
    }

    /// <summary>The file system for processing <paramref name="target"/>.</summary>
    public static async Task<WorkspaceRazorFileSystem> CreateAsync(
        TextDocument target,
        RazorEngineSettings settings,
        CancellationToken ct
    )
    {
        var items = new Dictionary<string, WorkspaceRazorItem>(NativePaths.Comparer);
        var documents = target.Project.AdditionalDocuments.Where(document =>
            document.Id == target.Id || IsImport(document.FilePath)
        );
        foreach (var document in documents)
        {
            var text = await document.GetTextAsync(ct).ConfigureAwait(false);
            var item = new WorkspaceRazorItem(
                settings.RazorPathOf(document),
                document.FilePath!,
                text
            );
            items[NativePaths.FromRazorProjectPath(settings.ProjectDirectory, item.FilePath)] =
                item;
        }

        return new WorkspaceRazorFileSystem(settings.ProjectDirectory, items);
    }

    /// <inheritdoc />
    public override IEnumerable<RazorProjectItem> EnumerateItems(string basePath)
    {
        return _items.Values;
    }

    /// <inheritdoc />
    public override RazorProjectItem GetItem(string path, RazorFileKind? fileKind)
    {
        var physical = NativePaths.FromRazorProjectPath(_projectDirectory, path);
        return _items.TryGetValue(physical, out var item)
            ? item
            : new WorkspaceRazorItem(path, physical, null);
    }

    private static bool IsImport(string? path)
    {
        return path is not null
            && (
                NativePaths.SameName(path, "_Imports.razor")
                || NativePaths.SameName(path, "_ViewImports.cshtml")
            );
    }
}

/// <summary>One Razor file as the engine reads it; <c>null</c> text is a file that does not exist.</summary>
internal sealed class WorkspaceRazorItem(string filePath, string physicalPath, SourceText? text)
    : RazorProjectItem
{
    /// <inheritdoc />
    public override string BasePath => "/";

    /// <inheritdoc />
    public override string FilePath => filePath;

    /// <inheritdoc />
    public override string PhysicalPath => physicalPath;

    /// <inheritdoc />
    public override bool Exists => text is not null;

    /// <inheritdoc />
    public override Stream Read()
    {
        return new MemoryStream(Encoding.UTF8.GetBytes(text?.ToString() ?? ""), writable: false);
    }
}
