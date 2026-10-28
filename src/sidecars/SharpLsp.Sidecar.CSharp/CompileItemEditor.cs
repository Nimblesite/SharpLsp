using System.Text;
using Microsoft.Build.Construction;
using Microsoft.Build.Evaluation;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Inserts <c>&lt;Compile Include="..." /&gt;</c> items into MSBuild project files
/// using the real MSBuild document model (<see cref="ProjectRootElement"/>) with
/// formatting preservation.
///
/// GitHub #493 / [SE-ADD-FILE-REQUEST]: in F# compile ORDER matters, so a new
/// source file must land at a chosen position in the project's Compile list —
/// before or after a named anchor item, or by default immediately before the
/// LAST Compile item so an F# entry point stays last. Editing goes through the
/// DOM (never text splicing), so comments, whitespace, BOM and line endings of
/// untouched content survive byte-for-byte, and the edit is language-agnostic:
/// <c>.csproj</c>, <c>.fsproj</c>, <c>.props</c> alike.
/// </summary>
internal static class CompileItemEditor
{
    /// <summary>
    /// Insert a Compile item, or report an unchanged file: when the include
    /// already exists, or when the project has no explicit Compile items
    /// (glob-managed — inserting one explicit item there would be a footgun).
    /// </summary>
    public static PackageEditResult Insert(CompileInsertRequest request)
    {
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Open(request.FilePath, collection, preserveFormatting: true);
        var items = CompileItems(root);

        if (items.Count == 0)
        {
            return PackageEditResult.Unchanged(
                "no explicit Compile items (project is glob-managed)"
            );
        }
        if (items.Exists(item => SameInclude(item.Include, request.Include)))
        {
            return PackageEditResult.Unchanged($"{request.Include} already included");
        }

        var anchor = AnchorFor(items, request);
        var element = root.CreateItemElement("Compile", request.Include);
        if (request.Position == "after")
        {
            anchor.Parent.InsertAfterChild(element, anchor);
        }
        else
        {
            anchor.Parent.InsertBeforeChild(element, anchor);
        }
        var hadPreamble = HasUtf8Preamble(request.FilePath);
        root.Save();
        PreservePreamble(request.FilePath, hadPreamble);
        return PackageEditResult.Changed($"Added {request.Include}");
    }

    /// <summary>
    /// Remove the Compile item whose include names <paramref name="request"/>'s
    /// file, either separator spelling. Every other item, comment, BOM and line
    /// ending stays as it was; an include the project lacks changes nothing.
    /// [SE-REMOVE-FILE-REQUEST]
    /// </summary>
    public static PackageEditResult Remove(CompileInsertRequest request)
    {
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Open(request.FilePath, collection, preserveFormatting: true);
        var item = CompileItems(root).Find(each => SameInclude(each.Include, request.Include));
        if (item is null)
        {
            return PackageEditResult.Unchanged($"{request.Include} is not a Compile item");
        }
        item.Parent.RemoveChild(item);
        var hadPreamble = HasUtf8Preamble(request.FilePath);
        root.Save();
        PreservePreamble(request.FilePath, hadPreamble);
        return PackageEditResult.Changed($"Removed {request.Include}");
    }

    /// <summary>
    /// The file's <c>Compile</c> items in document order — items that INCLUDE a
    /// source. Bare <c>&lt;Compile Remove="…" /&gt;</c> fences (the shared
    /// fixture projects) do not count: a project with only those is still
    /// glob-managed, and inserting an explicit include there would self-propagate.
    /// </summary>
    private static List<ProjectItemElement> CompileItems(ProjectRootElement root)
    {
        return
        [
            .. root.Items.Where(item =>
                item.ItemType == "Compile" && !string.IsNullOrEmpty(item.Include)
            ),
        ];
    }

    /// <summary>
    /// The item the new element is positioned against: the named anchor for
    /// <c>before</c>/<c>after</c> (an unknown anchor is an error the caller
    /// surfaces), or the last item for the default position.
    /// </summary>
    private static ProjectItemElement AnchorFor(
        List<ProjectItemElement> items,
        CompileInsertRequest request
    )
    {
        return request.Position switch
        {
            "before" or "after" => NamedAnchor(items, request),
            _ => items[^1],
        };
    }

    /// <summary>The anchor item named by the request, or an error naming it.</summary>
    private static ProjectItemElement NamedAnchor(
        List<ProjectItemElement> items,
        CompileInsertRequest request
    )
    {
        return items.Find(item => SameInclude(item.Include, request.AnchorInclude))
            ?? throw new InvalidOperationException(
                $"anchor Compile item not found: {request.AnchorInclude}"
            );
    }

    /// <summary>Ordinal include comparison that ignores separator spelling.</summary>
    private static bool SameInclude(string left, string right)
    {
        return string.Equals(
            left.Replace('\\', '/'),
            right.Replace('\\', '/'),
            StringComparison.Ordinal
        );
    }

    /// <summary>Whether the file starts with the UTF-8 byte-order mark.</summary>
    private static bool HasUtf8Preamble(string path)
    {
        using var stream = File.OpenRead(path);
        Span<byte> head = stackalloc byte[3];
        return stream.Read(head) == 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF;
    }

    /// <summary>
    /// Re-apply the original byte-order mark: the SDK's <c>MSBuild</c> writes
    /// declaration-less project files without a preamble even when the source
    /// had one, and a BOM flip would show up as a whole-file diff.
    /// </summary>
    private static void PreservePreamble(string path, bool hadPreamble)
    {
        if (!hadPreamble || HasUtf8Preamble(path))
        {
            return;
        }
        var text = File.ReadAllText(path);
        File.WriteAllBytes(path, new UTF8Encoding(true).GetBytes(text));
    }
}
