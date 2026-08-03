// Shared real-project overlays for the [SHARPLSP-FEATURES-REFACTORING] core lifecycle matrix.

export const EXPRESSION_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    private readonly int _seed;
    public RefactorTarget(int seed) => _seed = seed;

    public int Compute(int input)
    {
        return input * 2 + input * 2 + _seed; // expression-refactor-sentinel
    }
}
`;

export const INLINE_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    private readonly int _seed;
    public RefactorTarget(int seed) => _seed = seed;

    public int Compute(int input)
    {
        var doubled = input * 2;
        return doubled + _seed; // inline-sentinel
    }
}
`;

export const FIELD_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    public int EncapsulateTarget;
    public int Read() => EncapsulateTarget; // field-refactor-sentinel
}
`;

export const PROPERTY_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    public int AutoProperty { get; set; }
    public int Read() => AutoProperty; // property-refactor-sentinel
}
`;

export const IF_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    public int Invertible(int input)
    {
        if (input > 0)
        {
            return input;
        }

        return -input; // condition-refactor-sentinel
    }
}
`;

export const PARAMETER_SOURCE = `namespace SharpLsp.TestFixtures.Refactors;

public class RefactorTarget
{
    public int Compute(int input)
    {
        return input * 2 + 1; // introduce-parameter-sentinel
    }

    public int Invoke() => Compute(3);
}
`;

export const EXPRESSION_OPTIONS = [
  "Introduce local for 'input * 2'",
  "Introduce local for all occurrences of 'input * 2'",
  'Extract method',
  'Extract local function',
] as const;

export const FIELD_OPTIONS = [
  "Encapsulate field: 'EncapsulateTarget' (and use property)",
  "Encapsulate field: 'EncapsulateTarget' (but still use field)",
  "Generate constructor 'RefactorTarget(int encapsulateTarget)'",
] as const;

export const PROPERTY_OPTIONS = [
  "Replace 'AutoProperty' with methods",
  "Generate constructor 'RefactorTarget(int autoProperty)'",
  'Convert to full property',
  "Convert to 'field' property",
] as const;

export const IF_OPTIONS = [
  'Invert if',
  "Convert to 'switch' statement",
  "Convert to 'switch' expression",
] as const;

export const PARAMETER_OPTIONS = [
  'and update call sites directly',
  'into extracted method to invoke at call sites',
  'into new overload',
] as const;
