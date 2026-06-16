using System.Reflection;
using Serilog;
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
    Log.Fatal(ex, "MSBuild registration failed");
    SidecarLog.Shutdown();
    Environment.Exit(1);
}

await RunSidecarAsync(args).ConfigureAwait(false);

static async Task RunSidecarAsync(string[] args)
{
    if (args.Length < 1)
    {
        await Console
            .Error.WriteLineAsync("Usage: SharpLsp.Sidecar.CSharp <socket-path>")
            .ConfigureAwait(false);
        Environment.Exit(1);
    }

    try
    {
        var socketPath = args[0];
        var sidecar = new CSharpSidecar();
        await using (sidecar.ConfigureAwait(false))
        {
            await sidecar.RunAsync(socketPath).ConfigureAwait(false);
        }
    }
    catch (Exception ex)
    {
        Log.Fatal(ex, "C# sidecar terminated unexpectedly");
        SidecarLog.Shutdown();
        Environment.Exit(1);
    }
}
