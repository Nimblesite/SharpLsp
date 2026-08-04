namespace RefactorFixtures;

public sealed class SortMembersCommand
{
    // Private helper must travel with its attribute.
    [System.Obsolete("private-helper")]
    private string Zebra()
    {
        return "ZEBRA";
    }

    /// <summary>Second public method.</summary>
    public string Beta()
    {
        return "BETA";
    }

    public string Omega { get; set; } = "OMEGA";

    private readonly int _zeta = 7;

    public const int AlphaConstant = 1;

    public SortMembersCommand()
    {
    }

    public string Alpha()
    {
        return "ALPHA";
    }
}

public struct SortMembersStruct
{
    public void Zebra()
    {
    }

    public int Alpha;
}

public interface ISortMembers
{
    void Zebra();

    int Alpha { get; }
}

public enum SortMembersEnum
{
    Zebra,
    Alpha,
    Middle
}

public record SortMembersRecord
{
    private void Zebra()
    {
    }

    public void Beta()
    {
    }

    public int Alpha { get; init; }
}
