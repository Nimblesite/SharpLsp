using System.Reflection;
using Serilog;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Logging;
using SharpLsp.Sidecar.CSharp;

if (args.Length > 0 && args[0] == "--version")
{
    var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
    Console.WriteLine($"sharplsp-sidecar-csharp {version}");
    return;
}

SidecarLog.Initialize("csharp");

try
{
    MSBuildInstanceSelector.Register(Console.Error);
}
catch (Exception ex)
{
    // MSBuild registration must never take the sidecar down. Without it, Roslyn
    // features degrade per-request, but the process must still reach READY so it
    // can serve MSBuild-free requests (e.g. solution/read for the Solution
    // Explorer) instead of crash-looping. [DIST-SDK-DISCOVERY]
    Log.Error(ex, "MSBuild registration failed; continuing without Roslyn analysis");
}

await RunSidecarAsync(args).ConfigureAwait(false);

static async Task RunSidecarAsync(string[] args)
{
    var parsed = SidecarStartupOptions.Parse(args);
    if (parsed.IsError)
    {
        await Console
            .Error.WriteLineAsync(
                $"FATAL: {parsed.Match(_ => string.Empty, e => e)} (SharpLsp.Sidecar.CSharp)"
            )
            .ConfigureAwait(false);
        Environment.Exit(1);
    }

    try
    {
        var options = parsed.Match(o => o, _ => throw new InvalidOperationException());
        var sidecar = new CSharpSidecar();
        bool startupFailed;
        await using (sidecar.ConfigureAwait(false))
        {
            await sidecar.RunAsync(options).ConfigureAwait(false);
            startupFailed = sidecar.StartupFailed;
        }

        if (startupFailed)
        {
            // The listener never bound; exit non-zero so the failure is not an
            // opaque clean exit before READY. [DIST-FAILURE-UX] (GitHub #150)
            Environment.Exit(1);
        }
    }
    catch (Exception ex)
    {
        Log.Fatal(ex, "C# sidecar terminated unexpectedly");
        SidecarLog.Shutdown();
        Environment.Exit(1);
    }
}
