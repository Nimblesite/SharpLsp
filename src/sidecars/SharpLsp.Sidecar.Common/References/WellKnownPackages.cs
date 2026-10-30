using System.Text.Json;

namespace SharpLsp.Sidecar.Common.References;

/// <summary>A type a well-known package ships: its full name and the package id.</summary>
/// <param name="FullName">The type's (or F# module's) full name, namespace included.</param>
/// <param name="PackageId">The package that ships it.</param>
public sealed record WellKnownType(string FullName, string PackageId)
{
    /// <summary>The namespace that declares the type: its full name up to the last dot.</summary>
    public string Namespace => FullName[..Math.Max(0, FullName.LastIndexOf('.'))];

    /// <summary>The type's own name: its full name after the last dot.</summary>
    public string Name => FullName[(FullName.LastIndexOf('.') + 1)..];
}

/// <summary>
/// The curated table of commonly used packages and the types they ship, for names no project of
/// the solution can reach yet. Both sidecars read this one table. Implements
/// [REFACTOR-IMPORT-REFERENCE] (a well-known package).
/// </summary>
public static class WellKnownPackages
{
    private const string Resource = "SharpLsp.WellKnownPackages.json";

    private static readonly Lazy<IReadOnlyList<WellKnownType>> Types = new(Load);

    /// <summary>Every well-known type named <paramref name="name"/>, in table order.</summary>
    public static IReadOnlyList<WellKnownType> Named(string name)
    {
        return [.. Types.Value.Where(type => type.Name == name)];
    }

    /// <summary>Every type of the embedded table.</summary>
    internal static IReadOnlyList<WellKnownType> All => Types.Value;

    private static IReadOnlyList<WellKnownType> Load()
    {
        using var stream =
            typeof(WellKnownPackages).Assembly.GetManifestResourceStream(Resource)
            ?? throw new InvalidOperationException($"{Resource} is not embedded");
        using var document = JsonDocument.Parse(stream);
        return
        [
            .. document.RootElement.GetProperty("packages").EnumerateArray().SelectMany(TypesOf),
        ];
    }

    private static IEnumerable<WellKnownType> TypesOf(JsonElement package)
    {
        var id = package.GetProperty("id").GetString() ?? "";
        return package
            .GetProperty("types")
            .EnumerateArray()
            .Select(type => new WellKnownType(type.GetString() ?? "", id));
    }
}
