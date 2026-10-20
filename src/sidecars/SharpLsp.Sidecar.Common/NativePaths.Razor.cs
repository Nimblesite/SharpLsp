namespace SharpLsp.Sidecar.Common;

/// <summary>
/// How the Razor compiler spells a file: rooted at its project directory, with forward
/// slashes (<c>/Components/Pages/Board.razor</c>). Implements [RAZOR-SCOPE-FILES] and
/// [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
public static partial class NativePaths
{
    /// <summary>Whether <paramref name="path"/> is a Razor file: a <c>.razor</c> component or a <c>.cshtml</c> page or view.</summary>
    public static bool IsRazor(string? path)
    {
        return path is not null && (HasExtension(path, ".razor") || HasExtension(path, ".cshtml"));
    }

    /// <summary>
    /// Whether <paramref name="path"/> is a Razor import file, whose directives apply to the
    /// Razor files beside and below it: <c>_Imports.razor</c> or <c>_ViewImports.cshtml</c>.
    /// </summary>
    public static bool IsRazorImport(string? path)
    {
        return path is not null
            && (SameName(path, "_Imports.razor") || SameName(path, "_ViewImports.cshtml"));
    }

    /// <summary><paramref name="path"/> as the Razor compiler names it inside <paramref name="projectDirectory"/>.</summary>
    public static string ToRazorProjectPath(string projectDirectory, string path)
    {
        return ToRazorProjectPath(RelativeTo(projectDirectory, path));
    }

    /// <summary>A target path as the compiler's rooted, forward-slashed Razor project path.</summary>
    public static string ToRazorProjectPath(string target)
    {
        return "/" + Slashed(target).TrimStart('/');
    }

    /// <summary>The file a Razor project path names inside <paramref name="projectDirectory"/>.</summary>
    public static string FromRazorProjectPath(string projectDirectory, string razorPath)
    {
        return Resolve(projectDirectory, razorPath.TrimStart('/'));
    }
}
