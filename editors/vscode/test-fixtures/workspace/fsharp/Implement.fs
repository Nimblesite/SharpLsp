module FSharpFixtures.Implement

/// An interface with two unimplemented members, used by the "Implement interface"
/// code-action test ([FS-CODEFIX-INTERFACESTUB]).
type IShape =
    abstract member Area: unit -> float
    abstract member Name: string

/// Declares the interface but implements none of its members (FS0366). The
/// "Implement interface" quick fix generates stubs for Area and Name.
type Square() =
    interface IShape
