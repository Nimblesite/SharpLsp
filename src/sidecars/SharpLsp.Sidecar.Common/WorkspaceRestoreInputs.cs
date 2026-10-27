using System.Xml.Linq;
using Serilog;
using SharpLsp.Sidecar.Common.Solutions;

namespace SharpLsp.Sidecar.Common;

/// <summary>Prove static restore inputs current; defer unevaluated MSBuild to the SDK. [DIAG-RESTORE]</summary>
internal sealed class WorkspaceRestoreInputs(DateTime assetsTime)
{
    private readonly HashSet<string> _files = new(NativePaths.Comparer);
    private readonly Dictionary<string, bool> _projects = new(NativePaths.Comparer);

    internal static bool AreCurrent(string project, DateTime assetsTime)
    {
        try
        {
            var current =
                WorkspaceRestoreProof.AreCurrent(project)
                && new WorkspaceRestoreInputs(assetsTime).ProjectCurrent(project);
            if (current)
            {
                WorkspaceRestoreProof.Record(project);
            }
            return current;
        }
        catch (Exception error)
        {
            LogSdkFallback(project, error);
            return false;
        }
    }

    private static void LogSdkFallback(string project, Exception error)
    {
        Log.Debug(
            "Restore inputs need SDK evaluation for {Project}; failure kind {FailureKind}",
            project,
            error.GetType().Name
        );
    }

    private bool ProjectCurrent(string project)
    {
        if (_projects.TryGetValue(project, out var current))
        {
            return current;
        }
        _projects[project] = false; // An in-progress project denotes a cycle; let the SDK report it.
        return _projects[project] =
            FileCurrent(project, isProject: true)
            && NativePaths.RestoreAncestorFiles(project).All(AncestorCurrent)
            && ProjectReferences.ReadReferencedProjects(project).All(ProjectCurrent);
    }

    private bool AncestorCurrent(string file)
    {
        return
            NativePaths.HasExtension(file, ".props") || NativePaths.HasExtension(file, ".targets")
            ? FileCurrent(file, isProject: false)
            : File.GetLastWriteTimeUtc(file) <= assetsTime;
    }

    private bool FileCurrent(string file, bool isProject)
    {
        if (!_files.Add(file))
        {
            return true;
        }
        if (!File.Exists(file) || File.GetLastWriteTimeUtc(file) > assetsTime)
        {
            return false;
        }
        var document = ProjectXml.Read(file).Match(document => document, error => throw error);
        return IsStatic(document, isProject)
            && (!isProject || WorkspaceRestoreReferences.AreCurrent(file, document))
            && document
                .Descendants()
                .Where(element => element.Name.LocalName == "Import")
                .All(import => ImportCurrent(file, import));
    }

    private bool ImportCurrent(string file, XElement import)
    {
        return NativePaths.LiteralRestoreImport(file, import.Attribute("Project")?.Value)
                is { } path
            && FileCurrent(path, isProject: false);
    }

    private static bool IsStatic(XDocument document, bool isProject)
    {
        return document.Root is { } root
            && KnownSdk(root.Attribute("Sdk")?.Value)
            && !root.Descendants().Any(element => NeedsEvaluation(element, isProject))
            && !root.DescendantsAndSelf()
                .Attributes()
                .Any(attribute =>
                    attribute.Name.LocalName == "Condition" || Deferred(attribute.Value)
                );
    }

    private static bool KnownSdk(string? sdk)
    {
        return sdk
            is null
                or "Microsoft.NET.Sdk"
                or "Microsoft.NET.Sdk.Web"
                or "Microsoft.NET.Sdk.Razor"
                or "Microsoft.NET.Sdk.WindowsDesktop";
    }

    private static bool NeedsEvaluation(XElement element, bool isProject)
    {
        // Never interpret task bodies, conditions, or MSBuild expressions with a second evaluator.
        return element.Name.LocalName is "Target" or "UsingTask" or "Choose"
            || (!isProject && element.Name.LocalName == "ProjectReference")
            || (!element.HasElements && Deferred(element.Value));
    }

    private static bool Deferred(string value)
    {
        return value.IndexOfAny(['$', '@', '%', '*', '?']) >= 0;
    }
}
