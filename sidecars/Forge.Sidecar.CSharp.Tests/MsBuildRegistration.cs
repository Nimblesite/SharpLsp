using System.Runtime.CompilerServices;
using Microsoft.Build.Locator;

namespace Forge.Sidecar.CSharp.Tests;

internal static class MsBuildRegistration
{
    [ModuleInitializer]
    internal static void Register()
    {
        if (!MSBuildLocator.IsRegistered)
        {
            _ = MSBuildLocator.RegisterDefaults();
        }
    }
}
