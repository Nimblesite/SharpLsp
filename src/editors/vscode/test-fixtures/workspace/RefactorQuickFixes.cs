namespace SharpLsp.TestFixtures.Refactors;

public interface IQuickContract
{
    int Compute(int input);

    string Name { get; }
}

public sealed class QuickFixTarget : IQuickContract
{
    public string Name => "quick-fix-sentinel";

    public int Compute(int input) => input * 2;

    public int Existing(int value) => value + 1;
}
