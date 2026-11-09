namespace CsPartials;

// An interface member, its override chain and an attribute. [REFERENCES-CSHARP-RESOLUTION]
public interface IShape
{
    double Area();
}

public abstract class Polygon : IShape
{
    public abstract double Area();
}

public sealed class Square : Polygon
{
    public override double Area() => 4;
}

[Marker]
public sealed class Tagged { }

public sealed class MarkerAttribute : System.Attribute { }
