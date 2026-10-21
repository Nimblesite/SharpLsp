using MessagePack;

namespace SharpLsp.Sidecar.CSharp;

// Cross-sidecar symbol identity used to bridge C# and F# rename references.
[MessagePackObject(AllowPrivate = true)]
internal sealed class RenameIdentityResultWire
{
    [Key(0)]
    public bool Found { get; init; }

    [Key(1)]
    public string AssemblyName { get; set; } = "";

    [Key(2)]
    public string XmlDocSig { get; set; } = "";
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class RenameForeignRequest
{
    [Key(0)]
    public string AssemblyName { get; set; } = "";

    [Key(1)]
    public string XmlDocSig { get; set; } = "";

    [Key(2)]
    public string NewName { get; set; } = "";
}

/// <summary>A symbol another sidecar names by identity. [REFERENCES-CROSS-LANGUAGE]</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class ForeignSymbolRequest
{
    [Key(0)]
    public string AssemblyName { get; set; } = "";

    [Key(1)]
    public string XmlDocSig { get; set; } = "";

    [Key(2)]
    public bool IncludeDeclaration { get; init; }
}
