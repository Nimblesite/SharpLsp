using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Serilog;
using SharpLsp.Sidecar.Common.Solutions;

namespace SharpLsp.Sidecar.Common;

/// <summary>
/// Remembers that the SDK restored a project from exactly the bytes its restore graph holds
/// now, so a graph only the SDK can evaluate (conditions, expressions, tasks) is restored
/// once and not on every open. Nothing is evaluated here: the graph is the set of files, and
/// the proof is their bytes and the restore output they produced. A graph with an import
/// whose path needs evaluation is unknown and has no proof. [DIAG-RESTORE]
/// [PERF-PROGRESSIVE-LOAD]
/// </summary>
internal static class WorkspaceRestoreDigest
{
    /// <summary>Remember the SDK's successful restore of <paramref name="project"/>.</summary>
    internal static void Record(string project)
    {
        _ = Guarded(() => Write(project));
    }

    /// <summary>Whether the last recorded restore read exactly what is on disk now.</summary>
    internal static bool Matches(string project)
    {
        return Guarded(() => Read(project) is { } proof && proof == Compute(project));
    }

    /// <summary>A proof that cannot be read or written is no proof: the SDK restores.</summary>
    private static bool Guarded(Func<bool> proof)
    {
        try
        {
            return proof();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Log.Debug(
                "Restore proof unavailable; failure kind {FailureKind}",
                error.GetType().Name
            );
            return false;
        }
    }

    private static bool Write(string project)
    {
        if (Compute(project) is not { } digest)
        {
            return false;
        }
        var proof = new FileInfo(ProofFile(project));
        proof.Directory?.Create();
        using var writer = proof.CreateText();
        writer.Write(digest);
        return true;
    }

    private static string? Read(string project)
    {
        var proof = new FileInfo(ProofFile(project));
        if (!proof.Exists)
        {
            return null;
        }
        using var reader = proof.OpenText();
        return reader.ReadToEnd();
    }

    /// <summary>Where the proof of <paramref name="project"/> is kept.</summary>
    internal static string ProofFile(string project)
    {
        var name = Hex(Encoding.UTF8.GetBytes(NativePaths.NormalizeFullPath(project)));
        return NativePaths.Temp("sharplsp", "restore-proofs", $"{name}.sha256");
    }

    private static string Hex(byte[] bytes)
    {
        return Convert.ToHexString(SHA256.HashData(bytes));
    }

    /// <summary>The digest of the graph and its restore output; null when the graph is unknown.</summary>
    private static string? Compute(string project)
    {
        var files = new SortedSet<string>(StringComparer.Ordinal);
        var assets = new FileInfo(NativePaths.ProjectAssetsFile(project));
        if (!assets.Exists || !Collect(project, files, isProject: true))
        {
            return null;
        }
        var lines = files.Select(file => $"{file}\n{Hex(Bytes(file))}");
        var output = $"{assets.Length}\n{assets.LastWriteTimeUtc.Ticks}";
        return Hex(Encoding.UTF8.GetBytes(string.Join('\n', lines.Append(output))));
    }

    private static byte[] Bytes(string file)
    {
        using var input = new FileInfo(file).Open(
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete
        );
        using var buffer = new MemoryStream();
        input.CopyTo(buffer);
        return buffer.ToArray();
    }

    /// <summary>Add <paramref name="file"/> and everything it is known to read; false when unknown.</summary>
    private static bool Collect(string file, SortedSet<string> files, bool isProject)
    {
        return !files.Add(NativePaths.NormalizeFullPath(file))
            || !NativePaths.IsMSBuildFile(file)
            || ProjectXml
                .Read(file)
                .Match(document => Known(file, document, files, isProject), _ => false);
    }

    private static bool Known(
        string file,
        XDocument document,
        SortedSet<string> files,
        bool isProject
    )
    {
        var references = document
            .Descendants()
            .Where(element => Named(element, "ProjectReference"));
        // A reference an imported file adds is the SDK's to resolve, as is a wildcard one.
        return (isProject || !references.Any())
            && document
                .Descendants()
                .Where(element => Named(element, "Import"))
                .All(import =>
                    NativePaths.LiteralRestoreImport(file, import.Attribute("Project")?.Value)
                        is { } path
                    && Collect(path, files, isProject: false)
                )
            && (!isProject || Owned(file, files));
    }

    private static bool Named(XElement element, string name)
    {
        return element.Name.LocalName == name;
    }

    /// <summary>A project's inherited configuration and the projects it references.</summary>
    private static bool Owned(string project, SortedSet<string> files)
    {
        return NativePaths
                .RestoreAncestorFiles(project)
                .All(file => Collect(file, files, isProject: false))
            && ProjectReferences
                .ReadReferencedProjects(project)
                .All(reference =>
                    new FileInfo(reference).Exists && Collect(reference, files, isProject: true)
                );
    }
}
