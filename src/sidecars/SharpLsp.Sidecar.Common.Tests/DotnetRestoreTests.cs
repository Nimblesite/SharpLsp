using System.Diagnostics;
using System.Globalization;
using System.Xml.Linq;

#pragma warning disable RS1035 // Real-process and environment use is the point of these tests

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Restore children resolve their own SDK and each restore stage is time-bounded.
/// Implements [DIAG-RESTORE].
/// </summary>
[Collection("DotnetRestore")]
public sealed class DotnetRestoreTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"slsp-dotnet-restore-{Guid.NewGuid():N}");

    [Fact]
    public async Task Restore_child_does_not_inherit_the_hosts_MSBuild_registration()
    {
        var project = WriteProject("Clean.csproj");
        SetMsBuildRegistration(NativePaths.Resolve(_root, "no-such-sdk"));
        try
        {
            var result = await DotnetRestore.RunAsync(
                project,
                NativePaths.DirectoryOf(project),
                new Dictionary<string, string>(),
                CancellationToken.None
            );
            Assert.True(result.IsOk, result.Match(_ => string.Empty, error => error));
        }
        finally
        {
            RestoreMsBuildRegistration();
        }
    }

    [Fact]
    public async Task A_restore_stage_that_never_finishes_is_stopped_and_reported()
    {
        var (project, pidFile) = WriteBlockingProject();
        var limit = TimeSpan.FromSeconds(10);
        var run = DotnetRestore.RunAsync(
            project,
            NativePaths.DirectoryOf(project),
            new Dictionary<string, string>(),
            limit,
            CancellationToken.None
        );
        var blockingPid = await WaitForBlockingPidAsync(pidFile, TimeSpan.FromSeconds(20));
        var result = await CompleteWithinAsync(run, TimeSpan.FromSeconds(40));

        Assert.True(result.IsError);
        var error = result.Match(_ => string.Empty, detail => detail);
        Assert.Contains("restore", error, StringComparison.Ordinal);
        Assert.Contains(
            ((int)limit.TotalSeconds).ToString(CultureInfo.InvariantCulture),
            error,
            StringComparison.Ordinal
        );
        Assert.True(
            await StandInProcess.ExitsWithinBoundAsync(blockingPid),
            "the blocked restore child must be stopped with its stage"
        );
    }

    private string WriteProject(string name)
    {
        new DirectoryInfo(_root).Create();
        var project = NativePaths.Resolve(_root, name);
        new XDocument(SdkRestoreAssertions.ProjectXml()).Save(project);
        return project;
    }

    private (string Project, string PidFile) WriteBlockingProject()
    {
        var directory = NativePaths.Resolve(_root, "Blocking");
        new DirectoryInfo(directory).Create();
        var pidFile = NativePaths.Resolve(directory, "blocked.pid");
        var blocking = new XElement(
            "Target",
            new XAttribute("Name", "BlockRestore"),
            new XAttribute("BeforeTargets", "Restore"),
            new XElement(
                "Exec",
                new XAttribute("Command", $"echo $$ > \"{pidFile}\"; exec sleep 600"),
                new XAttribute("Condition", "'$(OS)' != 'Windows_NT'")
            ),
            new XElement(
                "Exec",
                new XAttribute(
                    "Command",
                    $"powershell -NoProfile -Command \"$PID | Set-Content -Path '{pidFile}'; ping -n 600 127.0.0.1\""
                ),
                new XAttribute("Condition", "'$(OS)' == 'Windows_NT'")
            )
        );
        var xml = SdkRestoreAssertions.ProjectXml();
        xml.Add(blocking);
        var project = NativePaths.Resolve(directory, "Blocking.csproj");
        new XDocument(xml).Save(project);
        return (project, pidFile);
    }

    private static async Task<int> WaitForBlockingPidAsync(string pidFile, TimeSpan bound)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < bound)
        {
            if (File.Exists(pidFile))
            {
                return int.Parse(
                    (await File.ReadAllTextAsync(pidFile).ConfigureAwait(false)).Trim(),
                    CultureInfo.InvariantCulture
                );
            }
            await Task.Delay(100).ConfigureAwait(false);
        }
        throw new TimeoutException($"the blocking restore never wrote {pidFile}");
    }

    private static async Task<T> CompleteWithinAsync<T>(Task<T> task, TimeSpan bound)
    {
        var finished = await Task.WhenAny(task, Task.Delay(bound)).ConfigureAwait(false);
        Assert.True(ReferenceEquals(finished, task), $"operation did not finish within {bound}");
        return await task.ConfigureAwait(false);
    }

    private static void SetMsBuildRegistration(string sdkDirectory)
    {
        Environment.SetEnvironmentVariable(
            "MSBUILD_EXE_PATH",
            NativePaths.Resolve(sdkDirectory, "MSBuild.dll")
        );
        Environment.SetEnvironmentVariable("MSBuildExtensionsPath", sdkDirectory);
        Environment.SetEnvironmentVariable(
            "MSBuildSDKsPath",
            NativePaths.Resolve(sdkDirectory, "Sdks")
        );
    }

    private static void RestoreMsBuildRegistration()
    {
        Environment.SetEnvironmentVariable("MSBUILD_EXE_PATH", null);
        Environment.SetEnvironmentVariable("MSBuildExtensionsPath", null);
        Environment.SetEnvironmentVariable("MSBuildSDKsPath", null);
    }

    public void Dispose()
    {
        new DirectoryInfo(_root).Delete(recursive: true);
    }
}
