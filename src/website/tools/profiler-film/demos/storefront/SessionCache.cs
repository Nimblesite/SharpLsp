namespace Storefront;

// Remembers every order "for analytics", and never forgets one.
public static class SessionCache
{
    private static readonly Dictionary<int, CustomerSession> Sessions = [];

    public static void Remember(Order order) => Sessions[order.Id] = new CustomerSession(order);
}

public sealed class CustomerSession(Order order)
{
    private readonly byte[] _snapshot = new byte[4 * 1024];

    public Order Order { get; } = order;

    public int SnapshotBytes => _snapshot.Length;
}
