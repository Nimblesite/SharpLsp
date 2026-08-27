using System;

namespace SharpLsp.TestFixtures.RenameCoverage;

public partial class PartialRenameTarget
{
    public int PartialMember { get; set; }

    public string MetadataCall(string input) => Console.ReadLine() ?? input;

    public string RenameStringSentinel => "PartialRenameTarget PartialMember";

    // PartialRenameTarget and PartialMember stay unchanged in this comment.
}

public partial class PartialRenameTarget
{
    public int UsePartialMember() => PartialMember;
}
