using MessagePack;

namespace SharpLsp.Sidecar.CSharp;

// Cross-sidecar symbol identity used to bridge C# and F# rename references.
[MessagePackObject(AllowPrivate = true)]
internal sealed record RenameIdentityResultWire(
    [property: Key(0)] bool Found,
    [property: Key(1)] string AssemblyName,
    [property: Key(2)] string XmlDocSig
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record RenameForeignRequest(
    [property: Key(0)] string AssemblyName,
    [property: Key(1)] string XmlDocSig,
    [property: Key(2)] string NewName
);

/// <summary>A symbol another sidecar names by identity. [REFERENCES-CROSS-LANGUAGE]</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed record ForeignSymbolRequest(
    [property: Key(0)] string AssemblyName,
    [property: Key(1)] string XmlDocSig,
    [property: Key(2)] bool IncludeDeclaration
);
