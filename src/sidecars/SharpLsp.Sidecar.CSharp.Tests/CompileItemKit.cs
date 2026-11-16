// Shared fixtures of the Compile-item suites: real project files on disk, the
// positional wire request, and the compile order read back through the DOM.
using System.Text;
using MessagePack;
using Microsoft.Build.Construction;
using Microsoft.Build.Evaluation;
using SharpLsp.Sidecar.Common;

// RS1035 bans File/Directory for *analyzers*; these tests legitimately
// read/write project files on disk.
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

internal static class CompileItemKit
{
    public const string DefaultPosition = "default";

    /// <summary>Join <paramref name="lines"/> with CRLF and a trailing newline.</summary>
    public static string Crlf(params string[] lines)
    {
        return string.Join("\r\n", lines) + "\r\n";
    }

    /// <summary>Writes <paramref name="content"/> to a unique project file and returns its path.</summary>
    public static async Task<string> CreateProjectAsync(
        string tempDir,
        string fileName,
        string content,
        bool bom = true
    )
    {
        var dir = NativePaths.Join(tempDir, Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(dir);
        var path = NativePaths.Join(dir, fileName);
        var encoding = new UTF8Encoding(bom);
        // Encoding.GetBytes alone never emits the preamble — prepend it so the
        // fixture really carries a BOM for the preservation assertions.
        var body = encoding.GetBytes(content);
        await File.WriteAllBytesAsync(path, [.. encoding.GetPreamble(), .. body])
            .ConfigureAwait(false);
        return path;
    }

    /// <summary>
    /// Serialize a positional compile-item request: [Key(0)] FilePath, [Key(1)]
    /// Include, [Key(2)] AnchorInclude, [Key(3)] Position.
    /// </summary>
    public static byte[] CompileRequest(
        string filePath,
        string include,
        string anchor = "",
        string position = DefaultPosition
    )
    {
        return MessagePackSerializer.Serialize(
            new object[] { filePath, include, anchor, position }
        );
    }

    /// <summary>The project's Compile includes in document order, via the real DOM.</summary>
    public static List<string> CompileOrder(string path)
    {
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Open(path, collection, preserveFormatting: true);
        return [.. root.Items.Where(item => item.ItemType == "Compile").Select(i => i.Include)];
    }
}
