using Forge.Sidecar.CSharp;
using Microsoft.Build.Locator;

// MSBuildLocator must be called before any Roslyn workspace types are loaded.
MSBuildLocator.RegisterDefaults();

await RunSidecarAsync(args).ConfigureAwait(false);

static async Task RunSidecarAsync(string[] args)
{
    if (args.Length < 1)
    {
        Console.Error.WriteLine("Usage: Forge.Sidecar.CSharp <socket-path>");
        Environment.Exit(1);
    }

    var socketPath = args[0];
    await using var sidecar = new CSharpSidecar();
    await sidecar.RunAsync(socketPath).ConfigureAwait(false);
}
