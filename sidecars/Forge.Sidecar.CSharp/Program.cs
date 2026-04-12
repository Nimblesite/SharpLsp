using System.Reflection;
using Forge.Sidecar.CSharp;
using Microsoft.Build.Locator;

if (args.Length > 0 && args[0] == "--version")
{
    var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
    Console.WriteLine($"forge-sidecar-csharp {version}");
    return;
}

try
{
    _ = MSBuildLocator.RegisterDefaults();
}
catch (Exception ex)
{
    await Console
        .Error.WriteLineAsync($"MSBuild locator failed: {ex.Message}")
        .ConfigureAwait(false);
    Environment.Exit(1);
}

await RunSidecarAsync(args).ConfigureAwait(false);

static async Task RunSidecarAsync(string[] args)
{
    if (args.Length < 1)
    {
        await Console
            .Error.WriteLineAsync("Usage: Forge.Sidecar.CSharp <socket-path>")
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
        await Console.Error.WriteLineAsync($"Sidecar failed: {ex.Message}").ConfigureAwait(false);
        Environment.Exit(1);
    }
}
