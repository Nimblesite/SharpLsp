using System.Xml.Linq;

namespace SharpLsp.Sidecar.Common.Tests;

internal static class SdkRestoreAssertions
{
    internal static async Task<byte[]> ReadBytesAsync(string path)
    {
        var input = new FileInfo(path).OpenRead();
        await using var lifetime = input.ConfigureAwait(false);
        using var output = new MemoryStream();
        await input.CopyToAsync(output).ConfigureAwait(false);
        return output.ToArray();
    }

    internal static XElement ProjectXml()
    {
        return XElement.Parse(
            """<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"""
        );
    }

    internal static async Task RestoreSdkAsync(string project)
    {
        var result = await DotnetRestore
            .RunAsync(
                project,
                NativePaths.DirectoryOf(project),
                new Dictionary<string, string>(),
                CancellationToken.None
            )
            .ConfigureAwait(false);
        Assert.True(result.IsOk, result.Match(_ => string.Empty, error => error));
    }

    internal static async Task EnsureRestoredAsync(string project)
    {
        var result = await WorkspaceRestore
            .EnsureTargetAsync(project, CancellationToken.None)
            .ConfigureAwait(false);
        Assert.True(result.IsOk, result.Match(_ => string.Empty, error => error));
    }

    internal static string DefaultPackagesRoot()
    {
#pragma warning disable RS1035 // The SDK's default packages root is environment-specific.
        return Environment.GetEnvironmentVariable("NUGET_PACKAGES")
            ?? NativePaths.Resolve(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".nuget",
                "packages"
            );
#pragma warning restore RS1035
    }
}
