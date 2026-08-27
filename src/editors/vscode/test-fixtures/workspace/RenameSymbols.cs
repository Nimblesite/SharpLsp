using System;
using ResourceAlias = System.IO.MemoryStream;

namespace SharpLsp.TestFixtures.RenameCoverage;

public delegate int RenameDelegate(int delegateParameter);

public interface IRenameContract<TContract>
{
    TContract ContractValue { get; }

    TContract Transform<TMethod>(TContract methodParameter, TMethod genericParameter);
}

public readonly struct RenameStruct
{
    public RenameStruct(int value) => Value = value;

    public int Value { get; }
}

public record RenameRecord(int RecordComponent);

public enum RenameEnum
{
    FirstMember,
    SecondMember,
}

public abstract class RenameBase
{
    /// <summary>Calls <see cref="VirtualMember"/> through the base contract.</summary>
    public abstract int VirtualMember(int value);
}

public interface IExplicitRenameContract
{
    int ExplicitMember(int value);
}

public sealed class RenameDerived : RenameBase, IExplicitRenameContract
{
    public override int VirtualMember(int value) => value + 1;

    int IExplicitRenameContract.ExplicitMember(int value) => value + 2;

    public string DescribeMember() => nameof(VirtualMember);

    public static RenameDerived operator +(RenameDerived left, RenameDerived right) => left;

    public static explicit operator int(RenameDerived value) => value.VirtualMember(0);
}

public class RenameClass<TType> : IRenameContract<TType>
{
    public const int RenameConstant = 5;
    private int _renameField;

    public RenameClass(TType constructorParameter) => ContractValue = constructorParameter;

    public event EventHandler? RenameEvent;

    public TType ContractValue { get; }

    public int RenameProperty { get; set; }

    public int this[int indexParameter]
    {
        get => _renameField + indexParameter;
        set => _renameField = value - indexParameter;
    }

    public TType Transform<TMethod>(TType methodParameter, TMethod genericParameter)
    {
        _ = genericParameter;
        return methodParameter;
    }

    public int RenameMethod(int methodParameter)
    {
        int RenameLocalFunction(int localFunctionParameter) => localFunctionParameter + 1;
        var renameLocal = RenameLocalFunction(methodParameter);
        Func<int, int> lambda = lambdaParameter => lambdaParameter + RenameConstant;
        return lambda(renameLocal) + _renameField;
    }

    public int ExerciseLocals(int methodParameter)
    {
        var total = 0;
        foreach (var foreachValue in new[] { methodParameter, RenameConstant })
        {
            total += foreachValue;
        }

        try
        {
            throw new InvalidOperationException("rename-catch-sentinel");
        }
        catch (InvalidOperationException catchError)
        {
            total += catchError.Message.Length;
        }

        using var usingResource = new ResourceAlias();
        var (deconstructedLeft, deconstructedRight) = (methodParameter, total);
        object patternSource = deconstructedLeft;
        if (patternSource is int patternValue)
        {
            total += patternValue;
        }

        return total + deconstructedRight + (int)usingResource.Length;
    }

    public void RaiseEvent() => RenameEvent?.Invoke(this, EventArgs.Empty);

    public const string LiteralSentinel = "RenameClass RenameMethod renameLocal";
    // RenameClass RenameMethod renameLocal must remain untouched in comments.
}
