using FSharpFixtures.CrossLanguage;

namespace CSharpConsumer;

/// <summary>Real C# consumer for [RENAME-CROSSLANGUAGE].</summary>
public static class FSharpConsumer
{
    // A same-name field must never be swept into request-local foreign recovery.
    public const string BridgedFSharpType = "UNCHANGED-CSHARP-SENTINEL";
    public const string BridgedFSharpMember = "UNCHANGED-CSHARP-MEMBER-SENTINEL";

    public static int Read(FSharpOrigin origin)
    {
        return origin.FSharpValue;
    }
}
