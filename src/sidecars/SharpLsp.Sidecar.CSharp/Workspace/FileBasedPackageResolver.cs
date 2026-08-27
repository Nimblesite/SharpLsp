using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Build.Construction;
using Microsoft.Build.Evaluation;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.MSBuild;
using Outcome;
using Serilog;
using FileBasedProjectResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.Workspace.ResolvedFileBasedProject,
    string
>;
using RestoreResult = Outcome.Result<Outcome.Unit, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed record ResolvedFileBasedProject(
    IReadOnlyList<PortableExecutableReference> References,
    CSharpParseOptions ParseOptions,
    CSharpCompilationOptions CompilationOptions
);

/// <summary>
/// Resolves <c>#:package</c> through a real synthesized MSBuild project.
/// Implements [SCRIPT-FILEBASED-REFERENCES-MSBUILD] and
/// [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
/// </summary>
internal static class FileBasedPackageResolver
{
    private static readonly string DefaultTargetFramework = $"net{Environment.Version.Major}.0";

    public static async Task<FileBasedProjectResult> ResolveAsync(
        Closure closure,
        string rootPath,
        CancellationToken ct
    )
    {
        try
        {
            var context = CreateContext(rootPath);
            WriteProject(context.ProjectPath, closure);
            var restored = await RestoreAsync(context, closure.Packages, ct).ConfigureAwait(false);
            return restored.IsError
                ? FileBasedProjectResult.Failure(!restored ?? "MSBuild restore failed.")
                : await LoadReferencesAsync(context, ct).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            return FileBasedProjectResult.Failure(exception.Message);
        }
    }

    private static RestoreContext CreateContext(string rootPath)
    {
        var appDirectory = Path.GetDirectoryName(Path.GetFullPath(rootPath)) ?? ".";
        var workDirectory = WorkDirectory(rootPath);
        _ = Directory.CreateDirectory(workDirectory);
        return new RestoreContext(
            Path.Combine(workDirectory, "restore.csproj"),
            appDirectory,
            EvaluationProperties(appDirectory)
        );
    }

    private static string WorkDirectory(string rootPath)
    {
        var fullPath = Path.GetFullPath(rootPath);
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(fullPath));
        var hash = Convert.ToHexString(digest)[..16];
        var appName = Path.GetFileNameWithoutExtension(fullPath);
        return Path.Combine(Path.GetTempPath(), "dotnet", "runfile", $"{appName}-{hash}");
    }

    private static void WriteProject(string projectPath, Closure closure)
    {
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Create(projectPath, collection);
        root.Sdk = Sdk(closure.Directives);
        AddProperties(root.AddPropertyGroup(), closure.Directives);
        AddPackages(root.AddItemGroup(), closure.Packages);
        root.Save();
    }

    private static string Sdk(IReadOnlyList<FileDirective> directives)
    {
        var sdk = directives.FirstOrDefault(directive =>
            directive.Kind == FileDirectiveKind.Sdk && !string.IsNullOrEmpty(directive.Name)
        );
        return sdk is null ? "Microsoft.NET.Sdk"
            : string.IsNullOrEmpty(sdk.Value) ? sdk.Name
            : $"{sdk.Name}/{sdk.Value}";
    }

    private static void AddProperties(
        ProjectPropertyGroupElement group,
        IReadOnlyList<FileDirective> directives
    )
    {
        var properties = DefaultProperties();
        foreach (var directive in directives.Where(IsPropertyWithValue))
        {
            properties[directive.Name] = directive.Value!;
        }
        foreach (var (name, value) in properties)
        {
            _ = group.AddProperty(name, value);
        }
    }

    private static Dictionary<string, string> DefaultProperties()
    {
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["TargetFramework"] = DefaultTargetFramework,
            ["ImplicitUsings"] = "enable",
            ["Nullable"] = "enable",
            ["OutputType"] = "Exe",
            ["PublishAot"] = "true",
            ["PackAsTool"] = "true",
        };
    }

    private static bool IsPropertyWithValue(FileDirective directive)
    {
        return directive.Kind == FileDirectiveKind.Property
            && !string.IsNullOrEmpty(directive.Name)
            && directive.Value is not null;
    }

    private static void AddPackages(
        ProjectItemGroupElement group,
        IReadOnlyList<PackageRef> packages
    )
    {
        foreach (var package in packages)
        {
            var item = group.AddItem("PackageReference", package.Name);
            if (!string.IsNullOrEmpty(package.Version))
            {
                _ = item.AddMetadata("Version", package.Version, expressAsAttribute: true);
            }
        }
    }

    private static async Task<RestoreResult> RestoreAsync(
        RestoreContext context,
        IReadOnlyList<PackageRef> packages,
        CancellationToken ct
    )
    {
        using var process = Process.Start(RestoreStartInfo(context));
        if (process is null)
        {
            return RestoreResult.Failure("Could not start `dotnet restore`.");
        }

        var standardOutput = process.StandardOutput.ReadToEndAsync(ct);
        var standardError = process.StandardError.ReadToEndAsync(ct);
        await WaitForExitAsync(process, ct).ConfigureAwait(false);
        var detail = await RestoreDetailAsync(standardOutput, standardError).ConfigureAwait(false);
        return process.ExitCode == 0
            ? new RestoreResult.Ok<Unit, string>(Unit.Value)
            : RestoreResult.Failure(RestoreFailure(packages, detail));
    }

    private static string RestoreFailure(IReadOnlyList<PackageRef> packages, string detail)
    {
        return packages.Count == 0
            ? $"MSBuild evaluation failed: {detail}"
            : $"Restore failed for {Describe(packages)}: {detail}";
    }

    private static ProcessStartInfo RestoreStartInfo(RestoreContext context)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = context.AppDirectory,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("restore");
        startInfo.ArgumentList.Add(context.ProjectPath);
        startInfo.ArgumentList.Add("--verbosity");
        startInfo.ArgumentList.Add("quiet");
        AddPropertyArguments(startInfo, context.Properties);
        return startInfo;
    }

    private static void AddPropertyArguments(
        ProcessStartInfo startInfo,
        IReadOnlyDictionary<string, string> properties
    )
    {
        foreach (var (name, value) in properties)
        {
            startInfo.ArgumentList.Add($"-p:{name}={value}");
        }
    }

    private static async Task WaitForExitAsync(Process process, CancellationToken ct)
    {
        try
        {
            await process.WaitForExitAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            KillProcessTree(process);
            throw;
        }
    }

    private static void KillProcessTree(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (Exception exception)
        {
            Log.Debug(exception, "Could not terminate cancelled file-based package restore");
        }
    }

    private static async Task<string> RestoreDetailAsync(
        Task<string> standardOutput,
        Task<string> standardError
    )
    {
        var error = (await standardError.ConfigureAwait(false)).Trim();
        var output = (await standardOutput.ConfigureAwait(false)).Trim();
        return error.Length > 0 ? error
            : output.Length > 0 ? output
            : "no output";
    }

    private static async Task<FileBasedProjectResult> LoadReferencesAsync(
        RestoreContext context,
        CancellationToken ct
    )
    {
        using var workspace = MSBuildWorkspace.Create(context.Properties);
        var project = await workspace
            .OpenProjectAsync(context.ProjectPath, cancellationToken: ct)
            .ConfigureAwait(false);
        var failure = workspace.Diagnostics.FirstOrDefault(diagnostic =>
            diagnostic.Kind == WorkspaceDiagnosticKind.Failure
        );
        return failure is not null
            ? FileBasedProjectResult.Failure(failure.Message)
            : ResolvedProject(project);
    }

    private static FileBasedProjectResult ResolvedProject(Microsoft.CodeAnalysis.Project project)
    {
        return
            project.ParseOptions is CSharpParseOptions parseOptions
            && project.CompilationOptions is CSharpCompilationOptions compilationOptions
            ? Success(
                new ResolvedFileBasedProject(
                    [.. project.MetadataReferences.OfType<PortableExecutableReference>()],
                    parseOptions,
                    compilationOptions
                )
            )
            : FileBasedProjectResult.Failure("MSBuild returned non-C# project options.");
    }

    private static Dictionary<string, string> EvaluationProperties(string appDirectory)
    {
        var properties = new Dictionary<string, string>
        {
            ["DesignTimeBuild"] = "true",
            ["BuildingInsideVisualStudio"] = "true",
            ["SkipCompilerExecution"] = "true",
        };
        AddConfigurationCone(properties, appDirectory);
        return properties;
    }

    private static void AddConfigurationCone(
        Dictionary<string, string> properties,
        string appDirectory
    )
    {
        AddNearest(properties, appDirectory, "Directory.Build.props", "DirectoryBuildPropsPath");
        AddNearest(
            properties,
            appDirectory,
            "Directory.Build.targets",
            "DirectoryBuildTargetsPath"
        );
        AddNearest(
            properties,
            appDirectory,
            "Directory.Packages.props",
            "DirectoryPackagesPropsPath"
        );
    }

    private static void AddNearest(
        Dictionary<string, string> properties,
        string appDirectory,
        string fileName,
        string propertyName
    )
    {
        var path = FindNearest(appDirectory, fileName);
        if (path is not null)
        {
            properties[propertyName] = path;
        }
    }

    private static string? FindNearest(string startDirectory, string fileName)
    {
        var directory = startDirectory;
        while (directory is not null)
        {
            var candidate = Path.Combine(directory, fileName);
            if (File.Exists(candidate))
            {
                return candidate;
            }
            directory = Directory.GetParent(directory)?.FullName;
        }
        return null;
    }

    private static string Describe(IEnumerable<PackageRef> packages)
    {
        return string.Join(
            ", ",
            packages.Select(package =>
                string.IsNullOrEmpty(package.Version)
                    ? package.Name
                    : $"{package.Name}@{package.Version}"
            )
        );
    }

    private static FileBasedProjectResult Success(ResolvedFileBasedProject project)
    {
        return new FileBasedProjectResult.Ok<ResolvedFileBasedProject, string>(project);
    }

    private sealed record RestoreContext(
        string ProjectPath,
        string AppDirectory,
        Dictionary<string, string> Properties
    );
}
