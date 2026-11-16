using System.ComponentModel;
using System.Diagnostics;
using Serilog;

namespace SharpLsp.Sidecar.Common;

/// <summary>
/// Which discovered files git ignores, by git's own answer (<c>git check-ignore</c>): a
/// gitignored clone or scratch folder is not the developer's code, so workspace discovery
/// leaves its projects out. Without git, or outside a repository, nothing is ignored.
/// Implements [DIAG-CONFIG-OWNED-SOURCES].
/// </summary>
public static class GitIgnore
{
    /// <summary>How long git may take before discovery goes on without its answer.</summary>
    private static readonly TimeSpan Budget = TimeSpan.FromSeconds(10);

    /// <summary>
    /// <paramref name="files"/> without those git ignores under <paramref name="root"/>. When
    /// git ignores <paramref name="root"/> itself, the folder was opened on purpose and all
    /// are kept.
    /// </summary>
    public static string[] Kept(string root, string[] files)
    {
        var ignored = files.Length == 0 ? [] : Ignored(root, [root, .. files]);
        if (ignored.Count == 0 || ignored.Contains(root))
        {
            return files;
        }
        Log.Information(
            "Workspace discovery under {Root}: {Ignored} of {Total} files are gitignored",
            root,
            ignored.Count,
            files.Length
        );
        return [.. files.Where(file => !ignored.Contains(file))];
    }

    /// <summary>The paths of <paramref name="files"/> that git reports ignored, as given.</summary>
    private static HashSet<string> Ignored(string root, string[] files)
    {
        try
        {
            using var git = Process.Start(StartInfo(root));
            return git is null ? [] : Answer(git, files);
        }
        catch (Exception error)
            when (error is Win32Exception or InvalidOperationException or IOException)
        {
            Log.Debug(error, "git check-ignore unavailable under {Root}", root);
            return [];
        }
    }

    private static ProcessStartInfo StartInfo(string root)
    {
        var info = new ProcessStartInfo("git")
        {
            WorkingDirectory = root,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add("check-ignore");
        info.ArgumentList.Add("--stdin");
        info.ArgumentList.Add("-z");
        return info;
    }

    /// <summary>Feed the paths NUL-separated and read the ignored ones back the same way.</summary>
    private static HashSet<string> Answer(Process git, string[] files)
    {
        var errors = git.StandardError.ReadToEndAsync();
        var output = git.StandardOutput.ReadToEndAsync();
        git.StandardInput.Write(string.Join('\0', files) + '\0');
        git.StandardInput.Close();
        if (!git.WaitForExit(Budget) || !output.Wait(Budget) || !errors.Wait(Budget))
        {
            git.Kill(entireProcessTree: true);
            Log.Warning(
                "git check-ignore exceeded {Seconds}s; no file treated as ignored",
                Budget.TotalSeconds
            );
            return [];
        }
        return [.. output.Result.Split('\0', StringSplitOptions.RemoveEmptyEntries)];
    }
}
