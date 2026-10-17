using System.Globalization;
using OptionsResult = Outcome.Result<SharpLsp.Sidecar.Common.SidecarStartupOptions, string>;

namespace SharpLsp.Sidecar.Common;

/// <summary>
/// The command line a host launches a sidecar with:
/// <c>&lt;endpoint&gt; [--parent-pid &lt;pid&gt;]</c>. The parent PID arms the
/// parent-death watchdog and process-tree containment; without it (in-process
/// tests, a manual launch) the sidecar runs unsupervised. Implements the
/// parent-PID half of [SIDECAR-STARTUP-SPAWN] (GitHub #163).
/// </summary>
/// <param name="Endpoint">The IPC endpoint the listener binds.</param>
/// <param name="ParentPid">The launching host's PID, when supervised.</param>
public sealed record SidecarStartupOptions(string Endpoint, int? ParentPid)
{
    /// <summary>The accepted argument shape, for usage errors.</summary>
    public const string Usage = "<endpoint> [--parent-pid <pid>]";

    private const string ParentPidFlag = "--parent-pid";

    /// <summary>
    /// Parse the sidecar arguments strictly: anything but the documented shape
    /// is a usage error, never a silently ignored flag.
    /// </summary>
    public static OptionsResult Parse(string[] args)
    {
        return args switch
        {
            [var endpoint] when !IsFlag(endpoint) => Ok(endpoint, null),
            [var endpoint, ParentPidFlag, var pid] when !IsFlag(endpoint) => ParsePid(
                endpoint,
                pid
            ),
            _ => OptionsResult.Failure($"invalid arguments; usage: {Usage}"),
        };
    }

    private static OptionsResult ParsePid(string endpoint, string pid)
    {
        return
            int.TryParse(pid, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
            && parsed > 0
            ? Ok(endpoint, parsed)
            : OptionsResult.Failure($"{ParentPidFlag} must be a positive integer; usage: {Usage}");
    }

    private static OptionsResult Ok(string endpoint, int? parentPid)
    {
        return new OptionsResult.Ok<SidecarStartupOptions, string>(
            new SidecarStartupOptions(endpoint, parentPid)
        );
    }

    private static bool IsFlag(string arg)
    {
        return arg.StartsWith("--", StringComparison.Ordinal);
    }
}
