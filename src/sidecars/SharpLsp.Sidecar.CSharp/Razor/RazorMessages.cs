using MessagePack;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// A nested document symbol. Positionally identical to the F# sidecar's
/// <c>DocumentSymbolResult</c>, so the host decodes both with one wire type.
/// Implements [RAZOR-FEATURES-STRUCTURE].
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed record DocumentSymbolResult(
    [property: Key(0)] string Name,
    [property: Key(1)] string Kind,
    [property: Key(2)] int StartLine,
    [property: Key(3)] int StartCharacter,
    [property: Key(4)] int EndLine,
    [property: Key(5)] int EndCharacter,
    [property: Key(6)] int SelectionStartLine,
    [property: Key(7)] int SelectionStartCharacter,
    [property: Key(8)] int SelectionEndLine,
    [property: Key(9)] int SelectionEndCharacter,
    [property: Key(10)] List<DocumentSymbolResult> Children
);

/// <summary>A foldable line range. Implements [RAZOR-FEATURES-STRUCTURE].</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed record FoldingRangeResult(
    [property: Key(0)] int StartLine,
    [property: Key(1)] int EndLine
);
