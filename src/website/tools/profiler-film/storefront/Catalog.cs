using System.Text.Json;

namespace Storefront;

public sealed record Product(string Sku, string Name, decimal Price);

public sealed record Order(int Id, List<Product> Items, decimal Total, string Invoice);

public static class Catalog
{
    private static readonly string[] Adjectives = ["Ergonomic", "Rustic", "Sleek", "Vintage"];
    private static readonly string[] Nouns = ["Keyboard", "Lamp", "Backpack", "Kettle", "Monitor"];

    public static string Generate(int itemCount) =>
        JsonSerializer.Serialize(Enumerable.Range(0, itemCount).Select(Product).ToList());

    private static Product Product(int index) =>
        new(
            $"SKU-{index:D5}",
            $"{Adjectives[index % Adjectives.Length]} {Nouns[index % Nouns.Length]}",
            9.99m + index % 90
        );
}
