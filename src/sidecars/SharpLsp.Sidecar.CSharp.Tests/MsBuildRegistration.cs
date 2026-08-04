using System.Runtime.CompilerServices;

namespace SharpLsp.Sidecar.CSharp.Tests;

internal static class MsBuildRegistration
{
    [ModuleInitializer]
    internal static void Register()
    {
        MSBuildInstanceSelector.Register(TextWriter.Null);
    }
}
