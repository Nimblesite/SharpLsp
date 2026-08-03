using FSharpFixtures.CrossLanguage;

namespace CSharpConsumer;

/// <summary>Real C# consumer for [RENAME-CROSSLANGUAGE].</summary>
public static class FSharpConsumer
{
    public static int Read(FSharpOrigin origin)
    {
        return origin.Value;
    }
}
