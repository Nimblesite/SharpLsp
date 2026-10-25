using System.Text.Json;
using System.Xml.Linq;

namespace SharpLsp.Sidecar.Common;

/// <summary>Prove declared references match SDK assets; defer unknown evaluation. [DIAG-RESTORE]</summary>
internal static class WorkspaceRestoreReferences
{
    internal static bool AreCurrent(string project, XDocument document)
    {
        var declared = DeclaredReferences(document);
        using var restored = PackageAssets.ReadDocument(project);
        var frameworks = restored
            .RootElement.GetProperty("project")
            .GetProperty("frameworks")
            .EnumerateObject()
            .ToArray();
        return declared is not null
            && FrameworksCurrent(document, restored.RootElement)
            && frameworks.Length > 0
            && frameworks.All(framework => FrameworkMatches(framework.Value, declared));
    }

    private static bool FrameworksCurrent(XDocument document, JsonElement restored)
    {
        var declared = DeclaredFrameworks(document);
        var project = restored.GetProperty("project").GetProperty("restore");
        var actual = project
            .GetProperty("originalTargetFrameworks")
            .EnumerateArray()
            .Select(value => value.GetString())
            .ToHashSet(StringComparer.Ordinal);
        return declared.Length > 0 && actual.SetEquals(declared);
    }

    private static string[] DeclaredFrameworks(XDocument document)
    {
        var properties = document
            .Descendants()
            .Where(element => element.Name.LocalName is "TargetFramework" or "TargetFrameworks")
            .ToArray();
        // Multiple declarations/imported evaluation remain the SDK's responsibility. [DIAG-RESTORE]
        return properties is [var property]
            ? property.Value.Split(
                ';',
                StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries
            )
            : [];
    }

    private static Dictionary<string, string>? DeclaredReferences(XDocument document)
    {
        var declared = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (
            var element in document
                .Descendants()
                .Where(element => element.Name.LocalName == "PackageReference")
        )
        {
            var reference = LiteralReference(element);
            if (reference is null || !declared.TryAdd(reference.Value.Id, reference.Value.Version))
            {
                return null;
            }
        }
        return declared;
    }

    private static (string Id, string Version)? LiteralReference(XElement element)
    {
        var id = element.Attribute("Include")?.Value;
        var version =
            element.Attribute("Version")?.Value
            ?? element
                .Elements()
                .SingleOrDefault(child => child.Name.LocalName == "Version")
                ?.Value;
        return
            string.IsNullOrWhiteSpace(id)
            || string.IsNullOrWhiteSpace(version)
            || !HasOnlyVersionMetadata(element)
            ? null
            : (id, version);
    }

    private static bool HasOnlyVersionMetadata(XElement element)
    {
        return element
                .Attributes()
                .All(attribute => attribute.Name.LocalName is "Include" or "Version")
            && element.Elements().All(child => child.Name.LocalName == "Version");
    }

    private static bool FrameworkMatches(JsonElement framework, Dictionary<string, string> declared)
    {
        var dependencies = framework.TryGetProperty("dependencies", out var restored)
            ? restored.EnumerateObject().ToArray()
            : [];
        // Implicit/centrally supplied dependencies are evaluated by the SDK, never guessed here.
        return dependencies.Length == declared.Count
            && dependencies.All(dependency =>
                declared.TryGetValue(dependency.Name, out var version)
                && VersionMatches(version, dependency.Value)
            );
    }

    private static bool VersionMatches(string declared, JsonElement dependency)
    {
        var restored = dependency.GetProperty("version").GetString();
        // Only recognize the SDK's unchanged literal/minimum spelling; normalization defers to NuGet.
        // Removed metadata must not remain hidden in an older SDK snapshot (#485).
        return dependency.EnumerateObject().All(property => property.Name is "target" or "version")
            && dependency.GetProperty("target").GetString() == "Package"
            && (
                string.Equals(restored, declared, StringComparison.Ordinal)
                || string.Equals(restored, $"[{declared}, )", StringComparison.Ordinal)
            );
    }
}
