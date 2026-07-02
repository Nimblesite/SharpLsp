using MessagePack;

// xunit test classes must be public, so CA1515 (types can be internal) cannot apply.
#pragma warning disable CA1515
// Assert.Contains(string, string) is an ordinal substring check; CA1307's
// StringComparison guidance does not apply to test assertions.
#pragma warning disable CA1307
// RS1035 bans File/Directory for *analyzers* (no IO in an analyzer); this is a
// test, not an analyzer, and legitimately reads/writes project files on disk.
#pragma warning disable RS1035
// xunit Assert.* / Directory.CreateDirectory return values that are
// intentionally unused; matches SidecarEndToEndTests.cs.
#pragma warning disable IDE0058

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coarse end-to-end tests for MSBuild package editing (GitHub #4,
/// [NUGET-XML-DOM]). Drives <c>project/addPackage</c> / <c>project/removePackage</c>
/// through the real sidecar socket so the request exercises the full path:
/// FramedTransport → MessageRouter → CSharpSidecar handler → <see cref="PackageEditor"/>
/// → MSBuild's <c>ProjectRootElement</c> on a real file.
///
/// The Rust host has its own full-stack coverage of this path
/// (<c>tests/nuget_e2e.rs</c>), but that spawns the sidecar out-of-process so it
/// never counts toward the C# sidecar's own coverage gate. These in-process
/// tests close that gap and pin every branch of the editor.
/// </summary>
public sealed class PackageEditorEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private const string AddPackage = "project/addPackage";
    private const string RemovePackage = "project/removePackage";

    /// <summary>Writes <paramref name="content"/> to a unique project file and returns its path.</summary>
    private async Task<string> CreateProjectAsync(string fileName, string content)
    {
        var dir = Path.Combine(fixture.TempDir, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, fileName);
        await File.WriteAllTextAsync(path, content).ConfigureAwait(false);
        return path;
    }

    private static PackageEditRequest Request(
        string filePath,
        string packageId,
        string version,
        string elementKind
    )
    {
        return new PackageEditRequest
        {
            FilePath = filePath,
            PackageId = packageId,
            Version = version,
            ElementKind = elementKind,
        };
    }

    private Task<PackageEditResult> AddAsync(
        string filePath,
        string packageId,
        string version,
        string elementKind
    )
    {
        return fixture.SendAndDeserializeAsync<PackageEditRequest, PackageEditResult>(
            AddPackage,
            Request(filePath, packageId, version, elementKind)
        );
    }

    [Fact]
    public async Task Add_new_reference_into_existing_group_writes_versioned_item()
    {
        var path = await CreateProjectAsync(
            "WithGroup.csproj",
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Existing.Pkg" Version="1.0.0" />
              </ItemGroup>
            </Project>
            """
        );

        var result = await AddAsync(path, "New.Pkg", "2.3.4", "reference");

        Assert.True(result.Modified);
        Assert.Contains("Added New.Pkg", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.Contains("Include=\"New.Pkg\"", xml);
        Assert.Contains("Version=\"2.3.4\"", xml);
        // The untouched sibling and its group are preserved (no second ItemGroup).
        Assert.Contains("Include=\"Existing.Pkg\"", xml);
        Assert.Equal(1, xml.Split("<ItemGroup").Length - 1);
    }

    [Fact]
    public async Task Add_new_reference_without_any_group_creates_one()
    {
        var path = await CreateProjectAsync(
            "NoGroup.csproj",
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """
        );

        var result = await AddAsync(path, "Fresh.Pkg", "9.9.9", "reference");

        Assert.True(result.Modified);
        var xml = await File.ReadAllTextAsync(path);
        Assert.Contains("<ItemGroup", xml);
        Assert.Contains("Include=\"Fresh.Pkg\"", xml);
        Assert.Contains("Version=\"9.9.9\"", xml);
    }

    [Fact]
    public async Task Add_existing_reference_with_new_version_updates_it()
    {
        var path = await CreateProjectAsync("Update.csproj", SingleReference("Foo", "1.0.0"));

        var result = await AddAsync(path, "Foo", "2.0.0", "reference");

        Assert.True(result.Modified);
        Assert.Contains("Updated Foo", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.Contains("Version=\"2.0.0\"", xml);
        Assert.DoesNotContain("Version=\"1.0.0\"", xml);
    }

    [Fact]
    public async Task Add_existing_reference_at_same_version_is_a_noop()
    {
        var path = await CreateProjectAsync("Same.csproj", SingleReference("Foo", "1.0.0"));

        var result = await AddAsync(path, "Foo", "1.0.0", "reference");

        Assert.False(result.Modified);
        Assert.Contains("already at 1.0.0", result.Message);
    }

    [Fact]
    public async Task Add_reference_no_version_strips_existing_version_attribute()
    {
        var path = await CreateProjectAsync("Strip.csproj", SingleReference("Foo", "1.0.0"));

        var result = await AddAsync(path, "Foo", "ignored", "referenceNoVersion");

        Assert.True(result.Modified);
        Assert.Contains("Updated Foo", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.Contains("Include=\"Foo\"", xml);
        Assert.DoesNotContain("Version=", xml);
    }

    [Fact]
    public async Task Add_reference_no_version_on_already_versionless_item_is_a_noop()
    {
        var path = await CreateProjectAsync("CpmNoop.csproj", VersionlessReference("Foo"));

        var result = await AddAsync(path, "Foo", "ignored", "referenceNoVersion");

        Assert.False(result.Modified);
        Assert.Contains("already at", result.Message);
    }

    [Fact]
    public async Task Add_version_to_existing_versionless_item_adds_attribute()
    {
        var path = await CreateProjectAsync("AddVersion.csproj", VersionlessReference("Foo"));

        var result = await AddAsync(path, "Foo", "3.1.4", "reference");

        Assert.True(result.Modified);
        Assert.Contains("Updated Foo", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.Contains("Version=\"3.1.4\"", xml);
    }

    [Fact]
    public async Task Add_reference_no_version_new_item_omits_version()
    {
        var path = await CreateProjectAsync("NewCpm.csproj", VersionlessReference("Foo"));

        var result = await AddAsync(path, "Bar", "ignored", "referenceNoVersion");

        Assert.True(result.Modified);
        Assert.Contains("Added Bar", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.Contains("Include=\"Bar\"", xml);
        Assert.DoesNotContain("Version=", xml);
    }

    [Fact]
    public async Task Add_package_version_entry_uses_package_version_item_type()
    {
        var path = await CreateProjectAsync(
            "Directory.Packages.props",
            """
            <Project>
              <ItemGroup>
                <PackageVersion Include="Foo" Version="1.0.0" />
              </ItemGroup>
            </Project>
            """
        );

        var result = await AddAsync(path, "Bar", "2.0.0", "version");

        Assert.True(result.Modified);
        Assert.Contains("Added Bar", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.Contains("<PackageVersion Include=\"Bar\"", xml);
        Assert.Contains("Version=\"2.0.0\"", xml);
    }

    [Fact]
    public async Task Remove_existing_reference_deletes_the_element()
    {
        var path = await CreateProjectAsync("Remove.csproj", SingleReference("Foo", "1.0.0"));

        var result = await fixture.SendAndDeserializeAsync<PackageEditRequest, PackageEditResult>(
            RemovePackage,
            Request(path, "Foo", "", "reference")
        );

        Assert.True(result.Modified);
        Assert.Contains("Removed Foo", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.DoesNotContain("Include=\"Foo\"", xml);
    }

    [Fact]
    public async Task Remove_absent_reference_is_a_noop()
    {
        var path = await CreateProjectAsync(
            "RemoveMissing.csproj",
            SingleReference("Foo", "1.0.0")
        );

        var result = await fixture.SendAndDeserializeAsync<PackageEditRequest, PackageEditResult>(
            RemovePackage,
            Request(path, "Missing", "", "reference")
        );

        Assert.False(result.Modified);
        Assert.Contains("not present", result.Message);
        var xml = await File.ReadAllTextAsync(path);
        Assert.Contains("Include=\"Foo\"", xml);
    }

    [Fact]
    public async Task Edit_of_missing_file_surfaces_an_error()
    {
        var missing = Path.Combine(fixture.TempDir, "does-not-exist.csproj");

        var envelope = await fixture.SendAsync(
            AddPackage,
            MessagePackSerializer.Serialize(Request(missing, "Foo", "1.0.0", "reference"))
        );

        Assert.NotNull(envelope.Error);
    }

    private static string SingleReference(string id, string version)
    {
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="{id}" Version="{version}" />
              </ItemGroup>
            </Project>
            """;
    }

    private static string VersionlessReference(string id)
    {
        return $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="{id}" />
              </ItemGroup>
            </Project>
            """;
    }
}
