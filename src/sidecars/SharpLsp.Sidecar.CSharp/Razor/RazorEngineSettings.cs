using System.Text;
using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// A project's Razor configuration, read from the same inputs the SDK's generator reads: the
/// <c>build_property</c> analyzer options, the C# parse options, and each file's
/// <c>TargetPath</c>. Implements [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
internal sealed record RazorEngineSettings(
    RazorConfiguration Configuration,
    string RootNamespace,
    bool LocalizedComponentNames,
    string ProjectDirectory
)
{
    private const string TargetPathKey = "build_metadata.AdditionalFiles.TargetPath";

    /// <summary>The settings of <paramref name="project"/>, which has a project file.</summary>
    public static RazorEngineSettings Read(Project project)
    {
        var options = project.AnalyzerOptions.AnalyzerConfigOptionsProvider.GlobalOptions;
        var parse = project.ParseOptions as CSharpParseOptions ?? CSharpParseOptions.Default;
        var configuration = new RazorConfiguration(
            LanguageVersion(options),
            "default",
            [],
            parse.LanguageVersion,
            UseConsolidatedMvcViews: true,
            SuppressAddComponentParameter: false,
            UseRoslynTokenizer: Flag(parse.Features, "use-roslyn-tokenizer"),
            PreprocessorSymbols: [.. parse.PreprocessorSymbolNames]
        );
        return new RazorEngineSettings(
            configuration,
            Property(options, "RootNamespace") ?? project.DefaultNamespace ?? project.AssemblyName,
            string.Equals(
                Property(options, "SupportLocalizedComponentNames"),
                "true",
                StringComparison.OrdinalIgnoreCase
            ),
            NativePaths.DirectoryOf(project.FilePath ?? "")
        );
    }

    /// <summary>
    /// The Razor project path of <paramref name="razor"/>: its <c>TargetPath</c> when MSBuild
    /// gave one, else its path inside the project directory.
    /// </summary>
    public string RazorPathOf(TextDocument razor)
    {
        var target = TargetPath(razor);
        return target is null
            ? NativePaths.ToRazorProjectPath(ProjectDirectory, razor.FilePath ?? "")
            : NativePaths.ToRazorProjectPath(target);
    }

    private static string? TargetPath(TextDocument razor)
    {
        var options = razor.Project.AnalyzerOptions;
        var additional = options.AdditionalFiles.FirstOrDefault(file =>
            NativePaths.AreEqual(file.Path, razor.FilePath)
        );
        return
            additional is not null
            && options
                .AnalyzerConfigOptionsProvider.GetOptions(additional)
                .TryGetValue(TargetPathKey, out var encoded)
            ? Decode(encoded)
            : null;
    }

    private static string? Decode(string encoded)
    {
        var bytes = new byte[encoded.Length];
        return Convert.TryFromBase64String(encoded, bytes, out var written)
            ? Encoding.UTF8.GetString(bytes, 0, written)
            : null;
    }

    private static RazorLanguageVersion LanguageVersion(AnalyzerConfigOptions options)
    {
        return
            Property(options, "RazorLangVersion") is { } value
            && RazorLanguageVersion.TryParse(value, out var version)
            ? version
            : RazorLanguageVersion.Latest;
    }

    private static string? Property(AnalyzerConfigOptions options, string name)
    {
        return options.TryGetValue("build_property." + name, out var value) && value.Length > 0
            ? value
            : null;
    }

    private static bool Flag(IReadOnlyDictionary<string, string> features, string name)
    {
        return features.TryGetValue(name, out var value)
            && string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
    }
}
