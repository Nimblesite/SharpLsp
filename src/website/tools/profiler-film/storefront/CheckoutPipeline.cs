using System.Text.Json;

namespace Storefront;

public sealed class CheckoutPipeline(string catalogJson)
{
    public Order Checkout(int orderId)
    {
        var products = ParseCatalog();
        var basket = PickBasket(products, orderId);
        var total = PriceBasket(basket);
        var invoice = RenderInvoice(orderId, basket, total);
        return new Order(orderId, basket, total, invoice);
    }

    private List<Product> ParseCatalog() =>
        JsonSerializer.Deserialize<List<Product>>(catalogJson) ?? [];

    private static List<Product> PickBasket(List<Product> products, int seed)
    {
        var random = new Random(seed);
        return products.OrderBy(_ => random.Next()).Take(12).ToList();
    }

    private static decimal PriceBasket(List<Product> basket)
    {
        decimal total = 0;
        foreach (var product in basket)
        {
            total += ApplyDiscounts(product.Price, product.Sku);
        }
        return total;
    }

    private static decimal ApplyDiscounts(decimal price, string sku)
    {
        var hash = 17;
        for (var round = 0; round < 5_000; round++)
        {
            hash = (hash * 31) ^ sku[round % sku.Length];
        }
        return hash % 7 == 0 ? price * 0.9m : price;
    }

    private static string RenderInvoice(int orderId, List<Product> basket, decimal total)
    {
        var invoice = $"INVOICE #{orderId}\n";
        foreach (var product in basket)
        {
            invoice += $"{product.Sku,-12}{product.Name,-28}{product.Price,10:C}\n";
        }
        return invoice + $"TOTAL {total:C}";
    }
}
