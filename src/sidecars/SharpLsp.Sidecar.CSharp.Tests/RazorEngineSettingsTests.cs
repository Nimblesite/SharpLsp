using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Configuration and failure contracts for [RAZOR-ARCHITECTURE-ENGINE] and [RAZOR-ERRORS].</summary>
public sealed class RazorEngineSettingsTests : IDisposable
{
    private readonly AdhocWorkspace _workspace = new();
    private static string Board => AdhocRazorProject.PathOf("Board.razor");

    private static (string Path, string Text)[] Files =>
        [
            (Board, "<p>current</p>"),
            (AdhocRazorProject.PathOf("_Imports.razor"), "@using System"),
            (AdhocRazorProject.PathOf("Other.razor"), "<b>other</b>"),
        ];

    [Fact]
    public void Missing_and_invalid_properties_fall_back_to_project_and_parse_settings()
    {
        var project = Create("build_property.RazorLangVersion = bad")
            .WithDefaultNamespace("Fallback")
            .WithParseOptions(
                new CSharpParseOptions(LanguageVersion.CSharp13).WithPreprocessorSymbols("FEATURE")
            );
        var settings = RazorEngineSettings.Read(project);
        Assert.Equal("Fallback", settings.RootNamespace);
        Assert.Equal(RazorLanguageVersion.Latest, settings.Configuration.LanguageVersion);
        Assert.Equal(LanguageVersion.CSharp13, settings.Configuration.CSharpLanguageVersion);
        Assert.Contains("FEATURE", settings.Configuration.PreprocessorSymbols);
        Assert.False(settings.LocalizedComponentNames);
    }

    [Fact]
    public void Explicit_build_properties_override_project_defaults()
    {
        var project = Create(
            "build_property.RootNamespace = Configured\nbuild_property.RazorLangVersion = 8.0\nbuild_property.SupportLocalizedComponentNames = TRUE"
        );
        var settings = RazorEngineSettings.Read(project);
        Assert.Equal("Configured", settings.RootNamespace);
        Assert.Equal(RazorLanguageVersion.Version_8_0, settings.Configuration.LanguageVersion);
        Assert.True(settings.LocalizedComponentNames);
    }

    [Theory]
    [InlineData(null, "/Board.razor")]
    [InlineData("not-base64!", "/Board.razor")]
    [InlineData("TGlua2VkL0JvYXJkLnJhem9y", "/Linked/Board.razor")]
    public void Target_path_metadata_decodes_or_falls_back_to_the_document(
        string? encoded,
        string expected
    )
    {
        var config = encoded is null ? "" : TargetConfig(encoded);
        var project = Create(config);
        var document = AdhocRazorProject.Additional(project, Board);
        Assert.Equal(expected, RazorEngineSettings.Read(project).RazorPathOf(document));
        Assert.Equal(Board, document.FilePath);
        Assert.Equal(
            AdhocRazorProject.Directory,
            RazorEngineSettings.Read(project).ProjectDirectory
        );
    }

    [Fact]
    public async Task File_system_reads_current_target_and_imports()
    {
        var project = AdhocRazorProject.Create(_workspace, Files);
        var system = await FileSystemAsync(project).ConfigureAwait(true);
        Assert.Equal(2, system.EnumerateItems("/").Count());
        var item = system.GetItem("/Board.razor", null);
        Assert.Equal("/", item.BasePath);
        Assert.Equal(Board, item.PhysicalPath);
        Assert.True(item.Exists);
        using var reader = new StreamReader(item.Read());
        Assert.Equal("<p>current</p>", await reader.ReadToEndAsync().ConfigureAwait(true));
    }

    [Fact]
    public async Task File_system_represents_missing_files_without_inventing_contents()
    {
        var system = await FileSystemAsync(Create()).ConfigureAwait(true);
        var missing = system.GetItem("/Missing.razor", null);
        Assert.False(missing.Exists);
        Assert.Equal("/Missing.razor", missing.FilePath);
        Assert.Equal("/", missing.BasePath);
        using var absent = new StreamReader(missing.Read());
        Assert.Equal("", await absent.ReadToEndAsync().ConfigureAwait(true));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Engine_rejects_unlocated_projects_and_documents(bool missingProject)
    {
        var project = Create();
        var target = Unlocated(project, missingProject);
        Assert.Null(await RazorMarkupEngine.ProcessAsync(target, default).ConfigureAwait(true));
        var valid = await ProcessAsync(project).ConfigureAwait(true);
        Assert.NotNull(valid);
        Assert.Equal("<p>hello</p>", valid.HtmlText);
    }

    [Fact]
    public async Task Engine_propagates_cancellation()
    {
        var project = Create();
        var target = AdhocRazorProject.Additional(project, Board);
        _ = await Assert
            .ThrowsAnyAsync<OperationCanceledException>(() =>
                RazorMarkupEngine.ProcessAsync(target, new CancellationToken(canceled: true))
            )
            .ConfigureAwait(true);
        Assert.Equal("<p>hello</p>", (await target.GetTextAsync().ConfigureAwait(true)).ToString());
        Assert.NotNull(await ProcessAsync(project).ConfigureAwait(true));
    }

    [Fact]
    public async Task Unreadable_workspace_text_is_contained_and_does_not_poison_later_requests()
    {
        var project = Create();
        var document = AdhocRazorProject.Additional(project, Board);
        var failed = project
            .Solution.WithAdditionalDocumentTextLoader(
                document.Id,
                new UnavailableTextLoader(),
                PreservationMode.PreserveIdentity
            )
            .GetProject(project.Id)!;
        Assert.Null(await ProcessAsync(failed).ConfigureAwait(true));
        Assert.Null(await ProcessAsync(failed).ConfigureAwait(true));
        var recovered = AdhocRazorProject.Create(_workspace, [(Board, "<p>recovered</p>")]);
        var markup = await ProcessAsync(recovered).ConfigureAwait(true);
        Assert.NotNull(markup);
        Assert.Equal("<p>recovered</p>", markup.HtmlText);
    }

    private static string TargetConfig(string encoded)
    {
        return $"[{NativePaths.Slashed(Board)}]\nbuild_metadata.AdditionalFiles.TargetPath = {encoded}";
    }

    private static TextDocument Unlocated(Project project, bool missingProject)
    {
        return missingProject
            ? AdhocRazorProject.Additional(
                project.Solution.WithProjectFilePath(project.Id, null).GetProject(project.Id)!,
                Board
            )
            : project.AddAdditionalDocument("Untitled.razor", SourceText.From("<p>hello</p>"));
    }

    [Fact]
    public void Absent_namespace_and_language_options_use_assembly_name_and_latest_language()
    {
        var settings = RazorEngineSettings.Read(Create());
        Assert.Equal("App", settings.RootNamespace);
        Assert.Equal(RazorLanguageVersion.Latest, settings.Configuration.LanguageVersion);
        Assert.False(settings.LocalizedComponentNames);
    }

    private Project Create(string config = "")
    {
        return AdhocRazorProject.Create(_workspace, [(Board, "<p>hello</p>")], config);
    }

    private static Task<RazorMarkup?> ProcessAsync(Project project)
    {
        return RazorMarkupEngine.ProcessAsync(
            AdhocRazorProject.Additional(project, Board),
            default
        );
    }

    private static Task<WorkspaceRazorFileSystem> FileSystemAsync(Project project)
    {
        return WorkspaceRazorFileSystem.CreateAsync(
            AdhocRazorProject.Additional(project, Board),
            RazorEngineSettings.Read(project),
            default
        );
    }

    public void Dispose()
    {
        _workspace.Dispose();
    }

    private sealed class UnavailableTextLoader : TextLoader
    {
        public override Task<TextAndVersion> LoadTextAndVersionAsync(
            LoadTextOptions options,
            CancellationToken cancellationToken = default
        )
        {
            return Task.FromException<TextAndVersion>(
                new InvalidOperationException("Input unavailable")
            );
        }
    }
}
