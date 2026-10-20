using System.Collections.Concurrent;
using Microsoft.AspNetCore.Mvc.Razor.Extensions;
using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Razor;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Runs the bundled Razor compiler over one file of a project and returns its markup facts.
/// The project's own SDK generator still produces the C# projection; this engine only reads
/// markup structure. A failure answers null, so markup features answer empty while C#
/// features keep working, and is logged once per project. Implements
/// [RAZOR-ARCHITECTURE-ENGINE] and [RAZOR-ERRORS].
/// </summary>
internal static class RazorMarkupEngine
{
    private static readonly ConcurrentDictionary<string, byte> LoggedProjects = new(
        StringComparer.Ordinal
    );

    /// <summary>The markup facts of <paramref name="razor"/>, or null when the engine cannot read it.</summary>
    public static async Task<RazorMarkup?> ProcessAsync(TextDocument razor, CancellationToken ct)
    {
        try
        {
            return await ProcessCoreAsync(razor, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            LogOnce(razor.Project, ex);
            return null;
        }
    }

    private static async Task<RazorMarkup?> ProcessCoreAsync(
        TextDocument razor,
        CancellationToken ct
    )
    {
        var compilation = await razor.Project.GetCompilationAsync(ct).ConfigureAwait(false);
        if (compilation is null || razor.Project.FilePath is null || razor.FilePath is null)
        {
            return null;
        }

        var settings = RazorEngineSettings.Read(razor.Project);
        var fileSystem = await WorkspaceRazorFileSystem
            .CreateAsync(razor, settings, ct)
            .ConfigureAwait(false);
        var tagHelpers = RazorTagHelpers.Of(compilation);
        var capture = new RazorMarkupCapture();
        var engine = CreateEngine(settings, fileSystem, tagHelpers, capture);
        var document = engine.Process(fileSystem.GetItem(settings.RazorPathOf(razor), null), ct);
        return capture.ToMarkup(tagHelpers) is { } markup
            ? RazorHtmlComments.Restore(engine, document, markup, ct)
            : null;
    }

    private static RazorProjectEngine CreateEngine(
        RazorEngineSettings settings,
        RazorProjectFileSystem fileSystem,
        TagHelperCollection tagHelpers,
        RazorMarkupCapture capture
    )
    {
        return RazorProjectEngine.Create(
            settings.Configuration,
            fileSystem,
            builder =>
            {
                builder.Features.Add(new RazorTagHelpers.Feature(tagHelpers));
                CompilerFeatures.Register(builder);
                RazorExtensions.Register(builder);
                capture.Register(builder);
                _ = builder.SetRootNamespace(settings.RootNamespace);
                _ = builder.SetCSharpLanguageVersion(settings.Configuration.CSharpLanguageVersion);
                _ = settings.LocalizedComponentNames
                    ? builder.SetSupportLocalizedComponentNames()
                    : builder;
            }
        );
    }

    private static void LogOnce(Project project, Exception ex)
    {
        if (LoggedProjects.TryAdd(project.FilePath ?? project.Name, 0))
        {
            Log.Warning(
                "[Razor] Markup engine unavailable for {Project}: {ExceptionType}",
                project.Name,
                ex.GetType().Name
            );
        }
    }
}
