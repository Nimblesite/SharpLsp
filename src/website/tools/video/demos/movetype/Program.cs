using Shop;

var order = new Order();
order.Add("Coffee", 4.5m);
order.State = Order.Status.Paid;
Console.WriteLine(new Receipt().Render(order));
