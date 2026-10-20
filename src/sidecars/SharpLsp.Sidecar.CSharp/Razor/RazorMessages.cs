using MessagePack;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// A nested document symbol. Positionally identical to the F# sidecar's
/// <c>DocumentSymbolResult</c>, so the host decodes both with one wire type.
/// Implements [RAZOR-FEATURES-STRUCTURE].
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class DocumentSymbolResult
{
    [Key(0)]
    public string Name { get; set; } = "";

    [Key(1)]
    public string Kind { get; set; } = "";

    [Key(2)]
    public int StartLine { get; init; }

    [Key(3)]
    public int StartCharacter { get; init; }

    [Key(4)]
    public int EndLine { get; init; }

    [Key(5)]
    public int EndCharacter { get; init; }

    [Key(6)]
    public int SelectionStartLine { get; init; }

    [Key(7)]
    public int SelectionStartCharacter { get; init; }

    [Key(8)]
    public int SelectionEndLine { get; init; }

    [Key(9)]
    public int SelectionEndCharacter { get; init; }

    [Key(10)]
    public List<DocumentSymbolResult> Children { get; set; } = [];
}

/// <summary>A foldable line range. Implements [RAZOR-FEATURES-STRUCTURE].</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class FoldingRangeResult
{
    [Key(0)]
    public int StartLine { get; init; }

    [Key(1)]
    public int EndLine { get; init; }
}
