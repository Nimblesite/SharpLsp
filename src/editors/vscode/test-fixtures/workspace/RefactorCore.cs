namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    private readonly int _seed;

    public RefactorTarget(int seed) => _seed = seed;

    public int AutoProperty { get; set; }

    public int EncapsulateTarget;

    public int Compute(int input)
    {
        var doubled = input * 2;
        return doubled + _seed;
    }

    public int Invertible(int input)
    {
        if (input > 0)
        {
            return input;
        }

        return -input;
    }
}
