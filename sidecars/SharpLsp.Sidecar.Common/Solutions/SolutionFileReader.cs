using Microsoft.VisualStudio.SolutionPersistence.Model;
using Microsoft.VisualStudio.SolutionPersistence.Serializer;
using SolutionReadResult = Outcome.Result<SharpLsp.Sidecar.Common.Solutions.SolutionFileModel, string>;

namespace SharpLsp.Sidecar.Common.Solutions;

/// <summary>
/// Reads legacy <c>.sln</c> and XML <c>.slnx</c> files through Microsoft's
/// shared solution persistence model.
/// </summary>
public static class SolutionFileReader
{
    /// <summary>Read a solution file into SharpLsp's neutral solution DTO.</summary>
    public static async Task<SolutionReadResult> ReadAsync(
        string path,
        CancellationToken cancellationToken = default
    )
    {
        try
        {
            var fullPath = NormalizeSolutionPath(path);
            var unsupported = ValidateSupportedFile(fullPath);
            if (unsupported is not null)
            {
                return SolutionReadResult.Failure(unsupported);
            }

            var serializer =
                SolutionSerializers.GetSerializerByMoniker(fullPath)
                ?? throw new InvalidOperationException(
                    $"No solution serializer found for '{fullPath}'."
                );
            var model = await serializer
                .OpenAsync(fullPath, cancellationToken)
                .ConfigureAwait(false);
            return new SolutionReadResult.Ok<SolutionFileModel, string>(
                MapSolution(fullPath, model)
            );
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return SolutionReadResult.Failure($"Failed to read solution '{path}': {ex.Message}");
        }
    }

    private static string NormalizeSolutionPath(string path)
    {
        return string.IsNullOrWhiteSpace(path)
            ? throw new ArgumentException("Solution path is required.", nameof(path))
            : Path.GetFullPath(path);
    }

    private static string? ValidateSupportedFile(string fullPath)
    {
        return !File.Exists(fullPath) ? $"Solution file does not exist: {fullPath}"
            : IsSolutionFile(fullPath) ? null
            : $"Unsupported solution file extension '{Path.GetExtension(fullPath)}'. "
                + "Expected .sln or .slnx.";
    }

    private static bool IsSolutionFile(string path)
    {
        return path.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase);
    }

    private static SolutionFileModel MapSolution(string solutionPath, SolutionModel model)
    {
        return new SolutionFileModel(
            solutionPath,
            FormatFromPath(solutionPath),
            MapProjects(solutionPath, model),
            MapFolders(model),
            MapFiles(solutionPath, model)
        );
    }

    private static SolutionProjectEntry[] MapProjects(string solutionPath, SolutionModel model)
    {
        return
        [
            .. model.SolutionProjects.Select(
                (project, index) => MapProject(solutionPath, project, index)
            ),
        ];
    }

    private static SolutionFolderEntry[] MapFolders(SolutionModel model)
    {
        return [.. model.SolutionFolders.Select(MapFolder)];
    }

    private static List<SolutionItemEntry> MapFiles(string solutionPath, SolutionModel model)
    {
        var files = new List<SolutionItemEntry>();
        foreach (var folder in model.SolutionFolders)
        {
            AddFolderFiles(solutionPath, folder, files);
        }

        return files;
    }

    private static void AddFolderFiles(
        string solutionPath,
        SolutionFolderModel folder,
        List<SolutionItemEntry> files
    )
    {
        var folderFiles = folder.Files;
        if (folderFiles is null)
        {
            return;
        }

        foreach (var file in folderFiles)
        {
            files.Add(MapFile(solutionPath, folder, file, files.Count));
        }
    }

    private static SolutionProjectEntry MapProject(
        string solutionPath,
        SolutionProjectModel project,
        int index
    )
    {
        var relativePath = project.FilePath;
        return new SolutionProjectEntry(
            DisplayName(project),
            ResolveSolutionPath(solutionPath, relativePath),
            relativePath,
            ProjectType(project),
            project.Id.ToString("D"),
            project.Parent?.Name,
            project.Parent?.Path,
            index
        );
    }

    private static SolutionFolderEntry MapFolder(SolutionFolderModel folder, int index)
    {
        return new SolutionFolderEntry(
            folder.Name,
            folder.Path,
            folder.Id.ToString("D"),
            folder.Parent?.Path,
            folder.Parent?.Name,
            index
        );
    }

    private static SolutionItemEntry MapFile(
        string solutionPath,
        SolutionFolderModel folder,
        string relativePath,
        int index
    )
    {
        return new SolutionItemEntry(
            ResolveSolutionPath(solutionPath, relativePath),
            relativePath,
            folder.Name,
            folder.Path,
            index
        );
    }

    private static string FormatFromPath(string path)
    {
        return path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase) ? "slnx" : "sln";
    }

    private static string DisplayName(SolutionProjectModel project)
    {
        return !string.IsNullOrWhiteSpace(project.ActualDisplayName) ? project.ActualDisplayName
            : !string.IsNullOrWhiteSpace(project.DisplayName) ? project.DisplayName
            : ProjectNameFromPath(project.FilePath);
    }

    private static string ProjectType(SolutionProjectModel project)
    {
        return !string.IsNullOrWhiteSpace(project.Type) ? project.Type
            : !string.IsNullOrWhiteSpace(project.Extension) ? project.Extension
            : project.TypeId.ToString("D");
    }

    private static string ProjectNameFromPath(string path)
    {
        var normalized = NormalizeSeparators(path);
        return Path.GetFileNameWithoutExtension(normalized) ?? normalized;
    }

    private static string ResolveSolutionPath(string solutionPath, string relativePath)
    {
        if (Path.IsPathRooted(relativePath))
        {
            return Path.GetFullPath(relativePath);
        }

        var solutionDir = Path.GetDirectoryName(solutionPath) ?? Directory.GetCurrentDirectory();
        return Path.GetFullPath(Path.Combine(solutionDir, NormalizeSeparators(relativePath)));
    }

    private static string NormalizeSeparators(string path)
    {
        return path.Replace('\\', Path.DirectorySeparatorChar);
    }
}
