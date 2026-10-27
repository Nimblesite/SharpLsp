// End-to-end tests for MSBuild <Compile> item insertion (GitHub #493,
// [SE-ADD-FILE-REQUEST]). Drives `project/addCompileItem` through the real
// sidecar socket — FramedTransport → MessageRouter → CSharpSidecar handler →
// CompileItemEditor → MSBuild's ProjectRootElement on a real .fsproj — and pins
// the exact resulting compile order for every position, the no-op contract,
// and formatting preservation (comments, BOM, line endings).
//
// The request payload is serialized positionally (`object[]`) rather than via a
// typed request so this suite states the WIRE CONTRACT independently of the
// handler's C# types: [Key(0)] FilePath, [Key(1)] Include, [Key(2)]
// AnchorInclude, [Key(3)] Position — the same convention as PackageEditRequest.
using System.Text;
using MessagePack;
using Microsoft.Build.Construction;
using Microsoft.Build.Evaluation;
using SharpLsp.Sidecar.Common;

// xunit test classes must be public, so CA1515 (types can be internal) cannot apply.
#pragma warning disable CA1515
// Assert.Contains(string, string) is an ordinal substring check; CA1307's
// StringComparison guidance does not apply to test assertions.
#pragma warning disable CA1307
// RS1035 bans File/Directory for *analyzers*; this is a test that legitimately
// reads/writes project files on disk, matching PackageEditorEndToEndTests.cs.
#pragma warning disable RS1035
// xunit Assert.* return values are intentionally unused.
#pragma warning disable IDE0058

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed class CompileItemEditorEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private const string AddCompileItem = "project/addCompileItem";
    private const string DefaultPosition = "default";

    /// <summary>Join <paramref name="lines"/> with CRLF and a trailing newline.</summary>
    private static string Crlf(params string[] lines)
    {
        return string.Join("\r\n", lines) + "\r\n";
    }

    /// <summary>Writes <paramref name="content"/> to a unique project file and returns its path.</summary>
    private async Task<string> CreateProjectAsync(string fileName, string content, bool bom = true)
    {
        var dir = NativePaths.Join(fixture.TempDir, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = NativePaths.Join(dir, fileName);
        var encoding = new UTF8Encoding(bom);
        // Encoding.GetBytes alone never emits the preamble — prepend it so the
        // fixture really carries a BOM for the preservation assertions.
        var body = encoding.GetBytes(content);
        await File.WriteAllBytesAsync(path, [.. encoding.GetPreamble(), .. body])
            .ConfigureAwait(false);
        return path;
    }

    /// <summary>Serialize a positional addCompileItem request.</summary>
    private static byte[] CompileRequest(
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

    private Task<PackageEditResult> AddAsync(
        string filePath,
        string include,
        string anchor = "",
        string position = DefaultPosition
    )
    {
        return fixture.SendAndDeserializeAsync<PackageEditResult>(
            AddCompileItem,
            CompileRequest(filePath, include, anchor, position)
        );
    }

    /// <summary>The project's Compile includes in document order, via the real DOM.</summary>
    private static List<string> CompileOrder(string path)
    {
        using var collection = new ProjectCollection();
        var root = ProjectRootElement.Open(path, collection, preserveFormatting: true);
        return [.. root.Items.Where(item => item.ItemType == "Compile").Select(i => i.Include)];
    }

    /// <summary>A real F# project shape: explicit compile order, entry point last.</summary>
    private static string OrderedFsproj()
    {
        return Crlf(
            "<Project Sdk=\"Microsoft.NET.Sdk\">",
            "  <!-- Compile order matters in F#: Domain defines, Program is the entry point. -->",
            "  <ItemGroup>",
            "    <Compile Include=\"Domain.fs\" />",
            "    <Compile Include=\"Library.fs\" />",
            "    <Compile Include=\"Program.fs\" />",
            "  </ItemGroup>",
            "</Project>"
        );
    }

    [Fact]
    public async Task Default_insert_lands_before_the_last_compile_item()
    {
        var path = await CreateProjectAsync("Default.fsproj", OrderedFsproj());

        var result = await AddAsync(path, "NewModule.fs");

        Assert.True(result.Modified);
        Assert.Contains("NewModule.fs", result.Message);
        // [SE-ADD-FILE-ORDER]: the default position is immediately before the
        // LAST Compile item so an F# entry point stays last.
        Assert.Equal(["Domain.fs", "Library.fs", "NewModule.fs", "Program.fs"], CompileOrder(path));
        // Formatting preservation, pinned as exact output text.
        Assert.Equal(
            OrderedFsproj()
                .Replace(
                    "    <Compile Include=\"Program.fs\" />",
                    "    <Compile Include=\"NewModule.fs\" />\r\n    <Compile Include=\"Program.fs\" />"
                ),
            await File.ReadAllTextAsync(path)
        );
    }

    [Fact]
    public async Task Default_insert_of_signature_pair_keeps_fsi_before_fs()
    {
        var path = await CreateProjectAsync("Pair.fsproj", OrderedFsproj());

        // The editor command adds the .fsi first, then the .fs — both at the
        // default position. The resulting order must be fsi, fs, entry point.
        var fsi = await AddAsync(path, "Math.fsi");
        var fs = await AddAsync(path, "Math.fs");

        Assert.True(fsi.Modified);
        Assert.True(fs.Modified);
        Assert.Equal(
            ["Domain.fs", "Library.fs", "Math.fsi", "Math.fs", "Program.fs"],
            CompileOrder(path)
        );
    }

    [Fact]
    public async Task Before_anchor_inserts_directly_before_the_named_item()
    {
        var path = await CreateProjectAsync("Before.fsproj", OrderedFsproj());

        var result = await AddAsync(path, "Near.fs", anchor: "Library.fs", position: "before");

        Assert.True(result.Modified);
        Assert.Equal(["Domain.fs", "Near.fs", "Library.fs", "Program.fs"], CompileOrder(path));
    }

    [Fact]
    public async Task After_anchor_inserts_directly_after_the_named_item()
    {
        var path = await CreateProjectAsync("After.fsproj", OrderedFsproj());

        var result = await AddAsync(path, "Near.fs", anchor: "Domain.fs", position: "after");

        Assert.True(result.Modified);
        Assert.Equal(["Domain.fs", "Near.fs", "Library.fs", "Program.fs"], CompileOrder(path));
    }

    [Fact]
    public async Task Anchor_and_include_match_across_separator_spellings()
    {
        var path = await CreateProjectAsync(
            "Separators.fsproj",
            Crlf(
                "<Project Sdk=\"Microsoft.NET.Sdk\">",
                "  <ItemGroup>",
                "    <Compile Include=\"Sub/Dir/Mid.fs\" />",
                "    <Compile Include=\"Program.fs\" />",
                "  </ItemGroup>",
                "</Project>"
            )
        );

        // The anchor is spelled with backslashes while the file spells it with
        // forward slashes; the match must be separator-insensitive.
        var result = await AddAsync(
            path,
            @"Sub\Dir\New.fs",
            anchor: @"Sub\Dir\Mid.fs",
            position: "before"
        );

        Assert.True(result.Modified);
        Assert.Equal(["Sub\\Dir\\New.fs", "Sub/Dir/Mid.fs", "Program.fs"], CompileOrder(path));
    }

    [Fact]
    public async Task Existing_include_is_a_noop_with_identical_bytes()
    {
        var path = await CreateProjectAsync("Noop.fsproj", OrderedFsproj());
        var before = await File.ReadAllBytesAsync(path);

        var result = await AddAsync(path, "Library.fs");

        Assert.False(result.Modified);
        Assert.Contains("already", result.Message);
        Assert.Equal(before, await File.ReadAllBytesAsync(path));
    }

    [Fact]
    public async Task BOM_comment_and_CRLF_survive_an_insert()
    {
        var path = await CreateProjectAsync("Keep.fsproj", OrderedFsproj());

        var result = await AddAsync(path, "NewModule.fs", anchor: "Domain.fs", position: "after");

        Assert.True(result.Modified);
        var bytes = await File.ReadAllBytesAsync(path);
        // BOM preserved.
        Assert.True(
            bytes.Length > 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF,
            $"expected a UTF-8 BOM; first bytes were {bytes[0]:X2} {bytes[1]:X2} {bytes[2]:X2}"
        );
        var text = Encoding.UTF8.GetString(bytes);
        // Comment preserved verbatim.
        Assert.Contains("Compile order matters in F#", text);
        // Every newline is CRLF — none degraded to a bare LF.
        Assert.DoesNotContain("\n", text.Replace("\r\n", ""));
    }

    [Fact]
    public async Task Missing_anchor_reports_an_error_and_touches_nothing()
    {
        var path = await CreateProjectAsync("Missing.fsproj", OrderedFsproj());
        var before = await File.ReadAllBytesAsync(path);

        var envelope = await fixture.SendAsync(
            AddCompileItem,
            CompileRequest(path, "NewModule.fs", anchor: "Nope.fs", position: "before")
        );

        Assert.NotNull(envelope.Error);
        Assert.Contains("Nope.fs", envelope.Error);
        Assert.Equal(before, await File.ReadAllBytesAsync(path));
    }

    [Fact]
    public async Task Project_without_explicit_compile_items_is_left_untouched()
    {
        // A glob-managed project (SDK default includes; no explicit Compile
        // items, like the C# templates) must not gain a stray explicit item.
        var path = await CreateProjectAsync(
            "Glob.csproj",
            Crlf(
                "<Project Sdk=\"Microsoft.NET.Sdk\">",
                "  <PropertyGroup>",
                "    <TargetFramework>net10.0</TargetFramework>",
                "  </PropertyGroup>",
                "</Project>"
            )
        );

        var result = await AddAsync(path, "NewThing.cs");

        Assert.False(result.Modified);
        Assert.Contains("glob", result.Message);
        Assert.DoesNotContain("<Compile Include", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task Remove_only_compile_fences_are_glob_managed_too()
    {
        // The shared fixture projects fence nested scopes with <Compile Remove>
        // entries but include sources by glob. Those Remove items must NOT count
        // as an explicit compile list, or every scaffolding auto-add wedges an
        // include between the fences and self-propagates run after run.
        var path = await CreateProjectAsync(
            "Fenced.csproj",
            Crlf(
                "<Project Sdk=\"Microsoft.NET.Sdk\">",
                "  <ItemGroup>",
                "    <Compile Remove=\"**/bin/**/*.cs\" />",
                "    <Compile Remove=\"debug-*/**/*.cs\" />",
                "  </ItemGroup>",
                "</Project>"
            )
        );

        var result = await AddAsync(path, "NewThing.cs");

        Assert.False(result.Modified);
        Assert.Contains("glob", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.DoesNotContain("<Compile Include", xml);
        Assert.Contains("<Compile Remove=\"**/bin/**/*.cs\" />", xml);
    }

    [Fact]
    public async Task Comment_containing_itemgroup_close_text_cannot_confuse_the_insert()
    {
        // The old text splicer hunted `lastIndexOf("</ItemGroup>")`, so a
        // comment mentioning the tag sent the splice into the wrong place. The
        // DOM cannot be confused ([SE-ADD-FILE-CSHARP]).
        var path = await CreateProjectAsync(
            "CommentTrap.csproj",
            Crlf(
                "<Project Sdk=\"Microsoft.NET.Sdk\">",
                "  <ItemGroup>",
                "    <!-- generated: do not hand-edit; the real </ItemGroup> follows the items -->",
                "    <Compile Include=\"Program.cs\" />",
                "  </ItemGroup>",
                "</Project>"
            )
        );

        var result = await AddAsync(path, "Service.cs");

        Assert.True(result.Modified);
        Assert.Equal(
            "<!-- generated: do not hand-edit; the real </ItemGroup> follows the items -->",
            (await File.ReadAllTextAsync(path))
                .Split('\n')
                .FirstOrDefault(line => line.Contains("generated: do not hand-edit"))
                ?.Trim()
        );
        // The default position inserts BEFORE the last item ([SE-ADD-FILE-ORDER]).
        Assert.Equal(["Service.cs", "Program.cs"], CompileOrder(path));
    }

    [Fact]
    public async Task Csproj_compile_items_edit_through_the_same_path()
    {
        // [SE-ADD-FILE-CSHARP]: the C# newFile auto-add rides the same edit.
        var path = await CreateProjectAsync(
            "Explicit.csproj",
            Crlf(
                "<Project Sdk=\"Microsoft.NET.Sdk\">",
                "  <ItemGroup>",
                "    <Compile Include=\"Program.cs\" />",
                "    <Compile Include=\"Service.cs\" />",
                "  </ItemGroup>",
                "</Project>"
            )
        );

        var result = await AddAsync(path, "Generated.cs");

        Assert.True(result.Modified);
        Assert.Equal(["Program.cs", "Generated.cs", "Service.cs"], CompileOrder(path));
    }
}
