using Microsoft.Build.Construction;
using Microsoft.Build.Evaluation;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Adds, updates, and removes <c>PackageReference</c> / <c>PackageVersion</c>
/// entries in MSBuild project files using the real MSBuild document model
/// (<see cref="ProjectRootElement"/>) with formatting preservation.
///
/// GitHub #4 / [NUGET-XML-DOM]: replaces the host's former line-oriented text
/// splicer, which corrupted multi-line elements, wrapped attributes, comments,
/// and conditional item groups. <see cref="ProjectRootElement"/> understands the
/// XML structure, preserves whitespace/comments/attribute order for untouched
/// content, and works for <c>.csproj</c>, <c>.fsproj</c>, and <c>.props</c>
/// alike (MSBuild editing is language-agnostic).
/// </summary>
internal static class PackageEditor
{
    /// <summary>Add a package entry, or update its version if already present.</summary>
    public static PackageEditResult Add(PackageEditRequest request)
    {
        var itemType = ItemTypeFor(request.ElementKind);
        var wantsVersion = request.ElementKind != "referenceNoVersion";
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Open(request.FilePath, collection, preserveFormatting: true);

        var existing = FindItem(root, itemType, request.PackageId);
        if (existing is not null)
        {
            if (!ApplyVersion(existing, request.Version, wantsVersion))
            {
                return Unchanged($"{request.PackageId} already at {request.Version}");
            }
            root.Save();
            return Changed($"Updated {request.PackageId}");
        }

        var group = FirstGroupWith(root, itemType) ?? root.AddItemGroup();
        var item = group.AddItem(itemType, request.PackageId);
        if (wantsVersion)
        {
            _ = item.AddMetadata("Version", request.Version, expressAsAttribute: true);
        }
        root.Save();
        return Changed($"Added {request.PackageId}");
    }

    /// <summary>Remove a package entry (the whole element) if present.</summary>
    public static PackageEditResult Remove(PackageEditRequest request)
    {
        var itemType = ItemTypeFor(request.ElementKind);
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Open(request.FilePath, collection, preserveFormatting: true);

        var item = FindItem(root, itemType, request.PackageId);
        if (item is null)
        {
            return Unchanged($"{request.PackageId} not present");
        }
        item.Parent.RemoveChild(item);
        root.Save();
        return Changed($"Removed {request.PackageId}");
    }

    private static string ItemTypeFor(string elementKind)
    {
        return elementKind == "version" ? "PackageVersion" : "PackageReference";
    }

    private static ProjectItemElement? FindItem(
        ProjectRootElement root,
        string itemType,
        string packageId
    )
    {
        return root.Items.FirstOrDefault(item =>
            item.ItemType == itemType
            && string.Equals(item.Include, packageId, StringComparison.Ordinal)
        );
    }

    private static ProjectItemGroupElement? FirstGroupWith(ProjectRootElement root, string itemType)
    {
        return root.ItemGroups.FirstOrDefault(group =>
            group.Items.Any(item => item.ItemType == itemType)
        );
    }

    /// <summary>
    /// Bring the item's <c>Version</c> metadata to the requested state. Returns
    /// whether anything changed. For <c>referenceNoVersion</c> the attribute is
    /// stripped (CPM: the version lives in <c>Directory.Packages.props</c>).
    /// </summary>
    private static bool ApplyVersion(ProjectItemElement item, string version, bool wantsVersion)
    {
        var metadata = item.Metadata.FirstOrDefault(meta => meta.Name == "Version");
        if (!wantsVersion)
        {
            if (metadata is null)
            {
                return false;
            }
            item.RemoveChild(metadata);
            return true;
        }
        if (metadata is null)
        {
            _ = item.AddMetadata("Version", version, expressAsAttribute: true);
            return true;
        }
        if (string.Equals(metadata.Value, version, StringComparison.Ordinal))
        {
            return false;
        }
        metadata.Value = version;
        return true;
    }

    private static PackageEditResult Changed(string message)
    {
        return new PackageEditResult { Modified = true, Message = message };
    }

    private static PackageEditResult Unchanged(string message)
    {
        return new PackageEditResult { Modified = false, Message = message };
    }
}
