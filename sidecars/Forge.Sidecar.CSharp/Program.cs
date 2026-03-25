using Forge.Sidecar.CSharp;
using Microsoft.Build.Locator;

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
