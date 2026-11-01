namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>
/// The exact titles of the C# import quick fixes, in one place. Each states the edit and what it
/// brings into scope. Implements the C# column of [REFACTOR-IMPORT].
/// </summary>
internal static class ImportTitles
{
    /// <summary>The namespace row.</summary>
    public static string Namespace(string ns)
    {
        return $"Add 'using {ns};' — imports every type in namespace {ns}";
    }

    /// <summary>The row that imports only the type, through an alias.</summary>
    public static string Alias(string name, string fullName)
    {
        return $"Add 'using {name} = {fullName};' — imports only the type {fullName}";
    }

    /// <summary>The row that qualifies this one use.</summary>
    public static string Qualify(string written, string qualified)
    {
        return $"Change '{written}' to '{qualified}' — qualifies this one use; no using added";
    }

    /// <summary>The row that imports a type's static members and nested types.</summary>
    public static string Static(string type)
    {
        return $"Add 'using static {type};' — imports the static members and nested types of {type}";
    }

    /// <summary>The row that references another project of the solution.</summary>
    public static string Project(string referenced, string project, string ns, string fullName)
    {
        return $"Reference project {referenced} from {project} and add 'using {ns};' — {referenced} declares {fullName}";
    }

    /// <summary>The row that adds a package another project of the solution uses.</summary>
    public static string SolutionPackage(
        string id,
        string version,
        string project,
        string user,
        string ns
    )
    {
        return $"Add package {id} {version} to {project} (as in {user}) and add 'using {ns};'";
    }

    /// <summary>The row that installs a well-known package.</summary>
    public static string WellKnownPackage(string id, string project, string ns)
    {
        return $"Install package {id} (latest stable from nuget.org) in {project} and add 'using {ns};'";
    }
}
