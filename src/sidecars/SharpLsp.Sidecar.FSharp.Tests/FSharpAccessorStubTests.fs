/// Interface-stub insertion when the existing implementation uses explicit
/// property accessors. Implements [SHARPLSP-FEATURES-REFACTORING].
///
/// The insertion point for a generated member is the end of the *last* binding
/// already present in the interface block. A `member _.P with get () = ... and
/// set v = ...` is a single `SynMemberDefn.GetSetMember` holding two bindings,
/// so choosing the last one means comparing the two accessor ranges rather than
/// taking the member's own range. Getter-only and setter-only forms are distinct
/// shapes again. None of those branches were reached by any test, so a stub
/// could have been spliced in above an existing accessor -- producing code that
/// does not compile -- without anything failing.
module SharpLsp.Sidecar.FSharp.Tests.FSharpAccessorStubTests

open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionSemanticTests

// Line indices below are 0-based into this list, and the column points into the
// interface's name on the `interface IStore ...` line.
//
//   7 -> BothAccessors' interface block
//  13 -> GetterOnly's
//  18 -> SetterOnly's
let private ACCESSOR_SOURCE =
    source
        [ "module Accessors"
          "type IStore ="
          "    abstract member Value: int with get, set"
          "    abstract member Reset: unit -> unit"
          ""
          "type BothAccessors() ="
          "    let mutable current = 0"
          "    interface IStore with"
          "        member _.Value"
          "            with get () = current"
          "            and set value = current <- value"
          ""
          "type GetterOnly() ="
          "    interface IStore with"
          "        member _.Value with get () = 0"
          ""
          "type SetterOnly() ="
          "    let mutable current = 0"
          "    interface IStore with"
          "        member _.Value with set value = current <- value" ]

let private accessorProject () = loadWorkspace [ "Accessors.fs", ACCESSOR_SOURCE ]

/// Text of the stub offered at an interface position, or None if none is.
let private stubTextAt state (paths: string list) line col =
    task {
        let! (parse, check, src) = checkedFixture state paths[0]

        let! action =
            FSharpCodeActions.tryGenerateInterfaceStub check parse src paths[0] line col
            |> Async.StartAsTask

        match action with
        | None -> return None
        | Some generated -> return Some(generated.Edits |> List.map _.NewText |> String.concat "")
    }

/// A get/set member holds two bindings, which is the shape the insertion-point
/// scan has to compare ranges across.
///
/// `Value` is fully implemented here -- verified against the compiler, the
/// `with get () = ... and set v = ...` form does satisfy
/// `abstract member Value: int with get, set` -- yet the generator still offers
/// it. That is a real gap, tracked in #206; restating `Value` beside the
/// existing accessors would not compile. This test asserts what is correct
/// today (the genuinely missing `Reset` is offered, and nothing carries
/// trailing whitespace) rather than pinning the duplicate as expected.
[<Fact>]
let ``a get-and-set member still offers the genuinely missing member`` () =
    task {
        let! (state, dir, _fsproj, paths) = accessorProject ()

        try
            let! text = stubTextAt state paths 7 15

            match text with
            | None -> failwith "no interface stub offered for the get/set implementation"
            | Some text ->
                Assert.Contains("Reset", text)
                Assert.Empty(trailingWhitespaceLines text)
        finally
            cleanup dir
    }

/// A getter-only implementation leaves the setter half of `Value` outstanding,
/// so `Value` is legitimately offered again alongside `Reset`. The point of the
/// case is the getter-only `GetSetMember` shape, which the insertion-point scan
/// has to handle without a setter to compare against.
[<Fact>]
let ``a getter-only member still offers the missing setter`` () =
    task {
        let! (state, dir, _fsproj, paths) = accessorProject ()

        try
            let! text = stubTextAt state paths 13 15

            match text with
            | None -> failwith "no interface stub offered for the getter-only implementation"
            | Some text ->
                Assert.Contains("Reset", text)
                Assert.Contains("Value", text)
                Assert.Empty(trailingWhitespaceLines text)
        finally
            cleanup dir
    }

/// The mirror image: a setter with no getter.
[<Fact>]
let ``a setter-only member still offers the missing getter`` () =
    task {
        let! (state, dir, _fsproj, paths) = accessorProject ()

        try
            let! text = stubTextAt state paths 18 15

            match text with
            | None -> failwith "no interface stub offered for the setter-only implementation"
            | Some text ->
                Assert.Contains("Reset", text)
                Assert.Contains("Value", text)
                Assert.Empty(trailingWhitespaceLines text)
        finally
            cleanup dir
    }
