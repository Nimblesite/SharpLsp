namespace Shop;

public class Order
{
    private readonly List<LineItem> _lines = [];
    private readonly Totals _totals = new();

    private static decimal Tax(decimal amount) => amount * 0.1m;

    internal static decimal Round(decimal amount) => Math.Round(amount, 2);

    public Status State { get; set; } = Status.Open;

    public void Add(string name, decimal price) => _lines.Add(new LineItem(name, price));

    public decimal Total() => Round(_totals.Add(_lines.Sum(line => line.Price)));

    private sealed class Totals
    {
        private decimal _sum;

        public decimal Add(decimal amount) => _sum += amount + Tax(amount);
    }

    public enum Status { Open, Paid, Shipped }

    /// <summary>One line of the order.</summary>
    private sealed record LineItem(string Name, decimal Price)
    {
        public decimal Rounded => Round(Price);
    }
}

public class Receipt
{
    private readonly string _shop = "Corner Shop";

    public string Render(Order order) => $"{_shop}: {order.Total()} ({order.State})";
}
