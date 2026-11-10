namespace CsPartials;

public static class Use
{
    public static int Measure(Widget widget) => widget.Area() + widget.Width;

    public static double Total(IShape shape, Polygon polygon, Square square) =>
        shape.Area() + polygon.Area() + square.Area();

    public static int Count()
    {
        var total = 0;
        total += 2;
        return total;
    }
}
