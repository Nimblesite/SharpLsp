using Microsoft.Build.Construction;
using Microsoft.Build.Evaluation;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Adds <c>&lt;ProjectReference Include="..." /&gt;</c> to a project file through the MSBuild
/// document model, keeping comments, whitespace, BOM and line endings. The include is relative
/// to the project's folder; a project that already references the same file, in either
/// separator spelling, is left as it is. The edit behind the "Reference project" quick fix,
/// [REFACTOR-IMPORT-REFERENCE].
/// </summary>
internal static class ProjectReferenceEditor
{
    private const string ProjectReference = "ProjectReference";

    /// <summary>Add the reference, or report why the file is unchanged.</summary>
    public static PackageEditResult Add(ProjectReferenceRequest request)
    {
        if (!File.Exists(request.ReferencePath))
        {
            throw new FileNotFoundException(
                $"The referenced project {request.ReferencePath} does not exist",
                request.ReferencePath
            );
        }
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Open(request.FilePath, collection, preserveFormatting: true);
        var directory = NativePaths.DirectoryOf(request.FilePath);
        if (
            References(root)
                .Any(item =>
                    NativePaths.AreEqual(
                        NativePaths.Resolve(directory, item.Include),
                        request.ReferencePath
                    )
                )
        )
        {
            return PackageEditResult.Unchanged(
                $"{NativePaths.NameOf(request.FilePath)} already references {NativePaths.NameOf(request.ReferencePath)}"
            );
        }
        var include = NativePaths.RelativeTo(directory, request.ReferencePath);
        _ = GroupFor(root).AddItem(ProjectReference, include);
        CompileItemEditor.SaveKeepingFormat(root, request.FilePath);
        return PackageEditResult.Changed($"Added a reference to {include}");
    }

    private static IEnumerable<ProjectItemElement> References(ProjectRootElement root)
    {
        return root.Items.Where(item => item.ItemType == ProjectReference);
    }

    /// <summary>The item group that already holds project references, or a new one.</summary>
    private static ProjectItemGroupElement GroupFor(ProjectRootElement root)
    {
        return root.ItemGroups.FirstOrDefault(group =>
                group.Items.Any(item => item.ItemType == ProjectReference)
            ) ?? root.AddItemGroup();
    }
}
