using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using SharpLsp.Sidecar.Common;

#pragma warning disable CA1515 // Public xUnit fixture type
#pragma warning disable RS1035 // Real-file writes are intentional: the fixture is built for real
#pragma warning disable IDE0058 // Directory.CreateDirectory's result is not needed

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// The Razor fixture as a user sees it whose newest SDK is newer than the sidecar's Roslyn,
/// with no <c>global.json</c> (#399): the command-line build works, but the Razor generator
/// the sidecar's design-time builds hand Roslyn was built against a newer Roslyn, which
/// Roslyn refuses to load. Implements [RAZOR-TESTING] for [RAZOR-ARCHITECTURE-GENERATOR].
/// </summary>
public sealed class NewerSdkRazorFixture : IDisposable
{
    /// <summary>Where the copy keeps the newer SDK's Razor generator, as the SDK does.</summary>
    private static readonly string[] Generators = ["newer-sdk", "source-generators"];

    /// <summary>The Razor compiler's file in an SDK.</summary>
    internal const string Compiler = "Microsoft.CodeAnalysis.Razor.Compiler.dll";

    /// <summary>Every file of an SDK's Razor generator, in ordinal order.</summary>
    internal static readonly string[] GeneratorFiles =
    [
        "Microsoft.AspNetCore.Razor.Utilities.Shared.dll",
        Compiler,
        "Microsoft.Extensions.ObjectPool.dll",
    ];

    /// <summary>
    /// The copy's design-time builds replace the SDK's Razor generator with the newer one,
    /// as an SDK newer than the sidecar's would supply it.
    /// </summary>
    private const string DesignTimeGenerators = """
        <Project>
          <Target
            Name="UseNewerSdkRazorGenerator"
            AfterTargets="_PrepareRazorSourceGenerators"
            Condition="'$(DesignTimeBuild)' == 'true'">
            <ItemGroup>
              <Analyzer Remove="@(_RazorAnalyzer)" />
              <Analyzer Include="$(MSBuildThisFileDirectory)newer-sdk/source-generators/*.dll" />
            </ItemGroup>
          </Target>
        </Project>
        """;

    /// <summary>The built fixture.</summary>
    public RazorFixture Razor { get; } = new(InstallNewerSdkGenerator);

    public void Dispose()
    {
        Razor.Dispose();
    }

    /// <summary>Give the copy at <paramref name="root"/> the newer SDK's Razor generator.</summary>
    private static void InstallNewerSdkGenerator(string root)
    {
        var generators = NativePaths.Join([root, .. Generators]);
        Directory.CreateDirectory(generators);
        File.WriteAllBytes(NativePaths.Join(generators, Compiler), NewerRazorCompiler());
        foreach (
            var dependency in GeneratorFiles.Where(file => !NativePaths.SameName(file, Compiler))
        )
        {
            File.Copy(
                NativePaths.Join(AppContext.BaseDirectory, dependency),
                NativePaths.Join(generators, dependency)
            );
        }

        File.WriteAllText(NativePaths.Join(root, "Directory.Build.targets"), DesignTimeGenerators);
    }

    /// <summary>
    /// The Razor compiler as Roslyn reads it from a newer SDK: an assembly of that name, at a
    /// version above the sidecar's own copy, whose generator references a
    /// <c>Microsoft.CodeAnalysis</c> newer than any running. Its generator has the real one's
    /// name, so a process that has already loaded its own copy stands that copy in, as it
    /// would for a real newer SDK.
    /// </summary>
    private static byte[] NewerRazorCompiler()
    {
        var roslyn = Compile(
            "Microsoft.CodeAnalysis",
            """
            [assembly: System.Reflection.AssemblyVersion("99.0.0.0")]

            namespace Microsoft.CodeAnalysis
            {
                public sealed class GeneratorAttribute : System.Attribute { }
            }
            """,
            []
        );
        return Emit(
            Compile(
                "Microsoft.CodeAnalysis.Razor.Compiler",
                """
                [assembly: System.Reflection.AssemblyVersion("99.0.0.0")]

                namespace Microsoft.NET.Sdk.Razor.SourceGenerators
                {
                    [Microsoft.CodeAnalysis.Generator]
                    public sealed class RazorSourceGenerator { }
                }
                """,
                [roslyn.ToMetadataReference()]
            )
        );
    }

    private static CSharpCompilation Compile(
        string name,
        string source,
        IEnumerable<MetadataReference> references
    )
    {
        return CSharpCompilation.Create(
            name,
            [CSharpSyntaxTree.ParseText(source)],
            [.. Basic.Reference.Assemblies.Net100.References.All, .. references],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        );
    }

    private static byte[] Emit(CSharpCompilation compilation)
    {
        using var image = new MemoryStream();
        var emitted = compilation.Emit(image);
        Assert.True(emitted.Success, string.Join('\n', emitted.Diagnostics));
        return image.ToArray();
    }
}
