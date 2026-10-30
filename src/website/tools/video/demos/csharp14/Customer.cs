namespace Shop;

public class Customer
{
    public string Name { get; set; } = "";

    public Address? Address { get; set; }
}

public class Address
{
    public string City { get; set; } = "";
}
