using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The language version a file-based app compiles at before its synthesized project is
/// restored: the one its target framework band ships, as <c>dotnet build</c> would pick, so the
/// editor neither accepts nor rejects a feature the build will not. Implements
/// [SCRIPT-FILEBASED-PARSEOPTIONS].
/// </summary>
internal static class FileBasedLanguage
{
    /// <summary>C# 9 shipped with .NET 5; each .NET since ships the next C#.</summary>
    private const int LanguageAheadOfFramework = 4;

    private const int FirstUnifiedFramework = 5;

    /// <summary>
    /// The version <paramref name="directives"/> ask for: an explicit <c>LangVersion</c>
    /// property, else the band of a <c>TargetFramework</c> property, else the newest.
    /// </summary>
    public static LanguageVersion For(IReadOnlyList<FileDirective> directives)
    {
        return Parsed(Property(directives, "LangVersion"))
            ?? OfFramework(Property(directives, "TargetFramework"))
            ?? LanguageVersion.Latest;
    }

    private static string? Property(IReadOnlyList<FileDirective> directives, string name)
    {
        return directives
            .LastOrDefault(directive =>
                directive.Kind == FileDirectiveKind.Property
                && string.Equals(directive.Name, name, StringComparison.OrdinalIgnoreCase)
            )
            ?.Value;
    }

    private static LanguageVersion? Parsed(string? version)
    {
        return LanguageVersionFacts.TryParse(version, out var parsed) ? parsed : null;
    }

    /// <summary>
    /// The C# of a <c>netN.0</c> framework; null for any other moniker, whose band the
    /// synthesized project decides once it is restored.
    /// </summary>
    private static LanguageVersion? OfFramework(string? framework)
    {
        var moniker = framework?.Trim() ?? "";
        var digits = moniker.StartsWith("net", StringComparison.OrdinalIgnoreCase)
            ? new string([.. moniker.Skip(3).TakeWhile(char.IsAsciiDigit)])
            : "";
        return int.TryParse(digits, out var major) && major >= FirstUnifiedFramework
            ? Parsed($"{major + LanguageAheadOfFramework}.0")
            : null;
    }
}

/// <summary>
/// A file-based app has one entry point: the top-level statements of its root file. An
/// <c>#:include</c>d file that carries its own is told so, on its first statement, in place of
/// the compiler's "only one compilation unit can have top-level statements", which names
/// neither the rule nor the root. Implements [SCRIPT-FILEBASED-ENTRYPOINT].
/// </summary>
internal static class FileBasedEntryPoints
{
    /// <summary>The diagnostic for top-level statements in an included file.</summary>
    public const string IncludedEntryPointCode = "SLSPC0004";

    /// <summary>The compiler's "only one compilation unit can have top-level statements".</summary>
    private const string OnlyOneCompilationUnit = "CS8802";

    /// <summary>
    /// For a document of a file-based app, replace the compiler's error with the rule.
    /// <paramref name="rootPath"/> is the app's root file; other projects are left alone.
    /// </summary>
    public static void Explain(
        string filePath,
        string? rootPath,
        SyntaxNode root,
        List<DiagnosticResult> diagnostics
    )
    {
        if (rootPath is null || WorkspaceManager.Classify(rootPath) != ProjectlessKind.FileBasedApp)
        {
            return;
        }

        _ = diagnostics.RemoveAll(diagnostic => diagnostic.Code == OnlyOneCompilationUnit);
        var statement = NativePaths.AreEqual(rootPath, filePath)
            ? null
            : (root as CompilationUnitSyntax)
                ?.Members.OfType<GlobalStatementSyntax>()
                .FirstOrDefault();
        if (statement is not null)
        {
            diagnostics.Add(Violation(statement, NativePaths.NameOf(rootPath)));
        }
    }

    private static DiagnosticResult Violation(GlobalStatementSyntax statement, string rootName)
    {
        return DocumentPosition.ToDiagnostic(
            statement.GetLocation().GetLineSpan(),
            IncludedEntryPointCode,
            "Error",
            $"Only the app's root file {rootName} may have top-level statements: "
                + "an #:include'd file can declare types, methods and namespaces."
        );
    }
}
