using System;

namespace CrossLanguageNavigationFixtures;

/// <summary>The C# declarations F# reaches. [DEFINITION-CROSSLANG]</summary>
public class NavCSharpClass
{
    public const int NavCSharpConstant = 7;
    public int NavCSharpField = 1;

    public NavCSharpClass(int seed) => NavCSharpProperty = seed;

    public int NavCSharpProperty { get; }

    public event EventHandler? NavCSharpEvent;

    public int NavCSharpMethod(int amount) => NavCSharpProperty + amount;

    public int NavCSharpOverload(int value) => value;

    public int NavCSharpOverload(string value) => value.Length;

    public T NavCSharpGeneric<T>(T value) => value;

    public static int NavCSharpStatic(int value) => value * 2;

    public void RaiseNavCSharpEvent() => NavCSharpEvent?.Invoke(this, EventArgs.Empty);

    public class NavCSharpNested
    {
        public int NavCSharpNestedValue { get; set; }
    }
}

public interface INavCSharpContract
{
    int NavCSharpCall(int value);
}

public enum NavCSharpEnum
{
    NavCSharpEnumOne = 1,
    NavCSharpEnumTwo = 2,
}

public struct NavCSharpStruct
{
    public NavCSharpStruct(int value) => NavCSharpStructValue = value;

    public int NavCSharpStructValue { get; }
}

public record NavCSharpRecord(int NavCSharpPositional);

public class NavCSharpBox<T>
{
    public NavCSharpBox(T value) => NavCSharpBoxed = value;

    public T NavCSharpBoxed { get; }
}

public delegate int NavCSharpDelegate(int value);

public static class NavCSharpExtensions
{
    public static int NavCSharpExtended(this NavCSharpClass value) => value.NavCSharpProperty;
}
