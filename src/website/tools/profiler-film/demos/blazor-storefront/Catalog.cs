namespace BlazorStorefront;

/// <summary>A product on sale: what it is called, and what it costs.</summary>
public sealed record Product(string Name, decimal Price);

public static class Catalog
{
    /// <summary>Every product the store sells, cheapest first.</summary>
    public static IReadOnlyList<Product> Products { get; } =
    [
        new("Rustic Lamp", 19.99m),
        new("Sleek Kettle", 34.50m),
        new("Ergonomic Keyboard", 89.00m),
    ];
}
