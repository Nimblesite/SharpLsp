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

    /// <summary>
    /// The code-behind partial class file of a component: <c>Counter.razor.cs</c> beside
    /// <c>Counter.razor</c>. [RAZOR-CODE-ACTIONS-CODE-BEHIND]
    /// </summary>
    public static string CodeBehindOf(string componentPath)
    {
        return componentPath + ".cs";
    }

    /// <summary>
    /// The stylesheet that scopes a Razor file's CSS: <c>Counter.razor.css</c> beside
    /// <c>Counter.razor</c>. [RAZOR-COLLOCATION-CSS]
    /// </summary>
    public static string StylesheetOf(string razorPath)
    {
        return razorPath + ".css";
    }

    /// <summary>
    /// The file a JavaScript module path names, the app's base path being the project directory:
    /// <c>./Components/Card.razor.js</c> and <c>/Components/Card.razor.js</c> both name
    /// <c>Components/Card.razor.js</c> in it. Null for a path that names no file. [RAZOR-COLLOCATION-JS]
    /// </summary>
    public static string? FromModulePath(string projectDirectory, string modulePath)
    {
        var relative = AppRelative(Slashed(modulePath));
        return relative.Length > 0 ? Resolve(projectDirectory, relative) : null;
    }

    /// <summary>A module path with the app's base path removed: <c>./a/b.js</c> is <c>a/b.js</c>.</summary>
    private static string AppRelative(string path)
    {
        return path.StartsWith("./", StringComparison.Ordinal) ? AppRelative(path[2..])
            : path.StartsWith('/') ? AppRelative(path[1..])
            : path;
    }

    /// <summary>The component file named <paramref name="name"/> in <paramref name="folder"/>: <c>Name.razor</c>.</summary>
    public static string ComponentIn(string folder, string name)
    {
        return Join(folder, name + ".razor");
    }
}
