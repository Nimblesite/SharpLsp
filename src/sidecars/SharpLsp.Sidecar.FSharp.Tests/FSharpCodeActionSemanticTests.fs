/// Code-action and navigation semantics over real F# projects: generated stubs,
/// numeric conversion quick fixes, and declaration navigation.
/// Implements [SHARPLSP-FEATURES-REFACTORING] / [SHARPLSP-FEATURES-NAVIGATION].
module SharpLsp.Sidecar.FSharp.Tests.FSharpCodeActionSemanticTests

open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

// ── Generated stubs ────────────────────────────────────────────────

let private GENERATION_SOURCE =
    source
        [ "module Generation"
          "type Choice ="
          "    | First of int"
          "    | Second"
          ""
          "type Config = { Alpha: int; Beta: string }"
          ""
          "type IService ="
          "    abstract member Run: int -> int"
          "    abstract member Reset: unit -> unit"
          ""
          "let describe (value: Choice) ="
          "    match value with"
          "    | First number -> number"
          ""
          "let incomplete = { Alpha = 1 }"
          ""
          "type Service() ="
          "    interface IService"
          ""
          "type Partial() ="
          "    interface IService with"
          "        member _.Run value = value"
          ""
          "let complete (value: Choice) ="
          "    match value with"
          "    | First number -> number"
          "    | Second -> 0"
          ""
          "let whole = { Alpha = 1; Beta = \"b\" }" ]

let internal checkedFixture state path =
    task {
        let! checkedFile = FSharpWorkspace.checkFileWithParse state path
        match checkedFile with
        | None -> return failwith "FCS could not check the generation fixture"
        | Some(parse, check, src) -> return (parse, check, src)
    }

let private generationProject () = loadWorkspace [ "Generation.fs", GENERATION_SOURCE ]

/// Generated stubs must never carry trailing whitespace: the repository's own
/// `git diff --check` gate rejects it the moment a user accepts the fix.
let internal trailingWhitespaceLines (text: string) =
    text.Split('\n')
    |> Array.map _.TrimEnd('\r')
    |> Array.filter (fun line -> line.Length > 0 && line <> line.TrimEnd())

/// The union-case generator must offer only the cases the match is missing, and
/// must offer nothing at all once the match is exhaustive. [SHARPLSP-FEATURES-REFACTORING]
[<Fact>]
let ``union stub generation fills the missing case and stays quiet when exhaustive`` () = task {
    let! (state, dir, _fsproj, paths) = generationProject ()
    try
        let! (parse, check, src) = checkedFixture state paths[0]
        let generate line = FSharpCodeActions.tryGenerateUnionStubs check parse src paths[0] line 4
        match generate 12 with
        | None -> failwith "no union stub offered for the incomplete match"
        | Some action ->
            let text = action.Edits |> List.map _.NewText |> String.concat ""
            Assert.Contains("Second", text)
            Assert.DoesNotContain("First", text)
        Assert.True((generate 25).IsNone, "an exhaustive match must offer no union stub")
    finally
        cleanup dir
}

/// The record generator must add only the absent fields, and must not fire on a
/// record expression that is already complete.
[<Fact>]
let ``record stub generation fills the absent field and stays quiet when complete`` () = task {
    let! (state, dir, _fsproj, paths) = generationProject ()
    try
        let! (parse, check, src) = checkedFixture state paths[0]
        let generate line col =
            FSharpCodeActions.tryGenerateRecordStubs check parse src paths[0] line col
        match generate 15 20 with
        | None -> failwith "no record stub offered for the incomplete record"
        | Some action ->
            let text = action.Edits |> List.map _.NewText |> String.concat ""
            Assert.Contains("Beta", text)
            Assert.DoesNotContain("Alpha", text)
        Assert.True((generate 29 16).IsNone, "a complete record must offer no field stub")
    finally
        cleanup dir
}

/// The interface generator must emit the unimplemented member, and must never
/// leave trailing whitespace — the repository's own diff gate rejects it.
[<Fact>]
let ``interface stub generation emits the member without trailing whitespace`` () = task {
    let! (state, dir, _fsproj, paths) = generationProject ()
    try
        let! (parse, check, src) = checkedFixture state paths[0]
        let! action =
            FSharpCodeActions.tryGenerateInterfaceStub check parse src paths[0] 18 15
            |> Async.StartAsTask
        match action with
        | None -> failwith "no interface stub offered for the unimplemented interface"
        | Some generated ->
            let text = generated.Edits |> List.map _.NewText |> String.concat ""
            Assert.Contains("Run", text)
            Assert.Contains("Reset", text)
            Assert.Empty(trailingWhitespaceLines text)
    finally
        cleanup dir
}

/// An interface block that already implements one member must have the missing
/// one appended after the existing binding, not restated from scratch — the
/// insertion point is computed from the last binding in the block.
[<Fact>]
let ``interface stub generation appends after an already implemented member`` () = task {
    let! (state, dir, _fsproj, paths) = generationProject ()
    try
        let! (parse, check, src) = checkedFixture state paths[0]
        let! action =
            FSharpCodeActions.tryGenerateInterfaceStub check parse src paths[0] 21 15
            |> Async.StartAsTask
        match action with
        | None -> failwith "no interface stub offered for the partial implementation"
        | Some generated ->
            let text = generated.Edits |> List.map _.NewText |> String.concat ""
            // Only the unimplemented member may be generated; regenerating `Run`
            // beside the existing one would not compile.
            Assert.Contains("Reset", text)
            Assert.DoesNotContain("member _.Run", text)
            Assert.Empty(trailingWhitespaceLines text)
    finally
        cleanup dir
}

// ── Navigation out of an implementation ────────────────────────────

/// Go-to-declaration on a member that implements an interface must land on the
/// interface's abstract member, not back on the implementation itself. Falling
/// back to the implementation would make the command a no-op exactly where a
/// developer needs it most. [SHARPLSP-FEATURES-NAVIGATION]
[<Fact>]
let ``declaration of an interface implementation resolves to the abstract member`` () = task {
    let! (state, dir, _fsproj, paths) = generationProject ()
    try
        let! location =
            FSharpSemanticNavigation.getDeclaration (FSharpWorkspace.checkFile state) paths[0] 22 18
        match location with
        | None -> failwith "no declaration found for the interface implementation"
        | Some found ->
            Assert.Equal(8, found.Line)
            Assert.NotEqual(22, found.Line)
    finally
        cleanup dir
}

/// Go-to-definition on a type annotation must reach the type declaration.
[<Fact>]
let ``definition of a type annotation resolves to its declaration`` () = task {
    let! (state, dir, _fsproj, paths) = generationProject ()
    try
        let! location =
            FSharpSemanticNavigation.getDefinition (FSharpWorkspace.checkFile state) paths[0] 24 23
        match location with
        | None -> failwith "no definition found for the type annotation"
        | Some found -> Assert.Equal(1, found.Line)
    finally
        cleanup dir
}

// ── Numeric conversion quick fixes ─────────────────────────────────

/// One mismatched binding per conversion the fixer knows about. Each line is a
/// real compiler error whose message the fixer parses to pick a function.
let private CONVERSION_SOURCE =
    source
        [ "module Conversions"
          "let toFloatFromInt (v: int) : float = v"
          "let toFloatFromDecimal (v: decimal) : float = v"
          "let toIntFromFloat (v: float) : int = v"
          "let toStringFromInt (v: int) : string = v"
          "let toFloat32 (v: float) : float32 = v"
          "let toFloatFrom32 (v: float32) : float = v"
          "let toInt64FromInt (v: int) : int64 = v"
          "let toInt64FromFloat (v: float) : int64 = v"
          "let toIntFromInt64 (v: int64) : int = v" ]

/// The two interface shapes whose insertion point differs from a plain
/// `interface IService`: one that already carries `with`, and an object
/// expression. Kept in their own project so parse recovery on the bare `with`
/// cannot disturb the other generation fixtures.
let private INTERFACE_SHAPES_SOURCE =
    source
        [ "module Shapes"
          "type IService ="
          "    abstract member Run: int -> int"
          "    abstract member Reset: unit -> unit"
          ""
          "type WithKeyword() ="
          "    interface IService with"
          ""
          "let objectExpr ="
          "    { new IService with"
          "        member _.Run v = v }" ]

let private interfaceStubAt state path line col =
    task {
        let! checkedFile = FSharpWorkspace.checkFileWithParse state path
        match checkedFile with
        | None -> return failwith "FCS could not check the interface-shapes fixture"
        | Some(parse, check, src) ->
            let! action =
                FSharpCodeActions.tryGenerateInterfaceStub check parse src path line col
                |> Async.StartAsTask
            return action |> Option.map (fun a -> a.Edits |> List.map _.NewText |> String.concat "")
    }

/// An `interface IService with` that declares no member yet must insert after the
/// `with` keyword rather than re-emitting one, and an object expression must
/// append beside the member it already has. Both take different insertion paths
/// from a bare `interface IService`. [SHARPLSP-FEATURES-REFACTORING]
[<Fact>]
let ``interface stubs insert correctly for a bare with keyword and an object expression`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Shapes.fs", INTERFACE_SHAPES_SOURCE ]
    try
        match! interfaceStubAt state paths[0] 6 15 with
        | None -> failwith "no stub offered for the interface carrying a bare with keyword"
        | Some text ->
            Assert.Contains("Run", text)
            Assert.DoesNotContain("interface IService", text)
        match! interfaceStubAt state paths[0] 9 12 with
        | None -> failwith "no stub offered for the partial object expression"
        | Some text ->
            Assert.Contains("Reset", text)
            Assert.DoesNotContain("member _.Run", text)
    finally
        cleanup dir
}

let private conversionTitlesAt state path line =
    task {
        let fixes = FSharpCodeFixes.createState ()
        let! actions = FSharpCodeFixes.getCodeActions fixes state path line 0 line 80
        return actions |> List.map _.Title
    }

/// The quick fix must suggest the conversion that actually bridges the two types.
/// A fixer that offered `int` for a `float32` mismatch would produce code that
/// still does not compile, and only asserting "some fix was offered" would miss
/// it — so each case pins the function name it must propose.
[<Theory>]
[<InlineData(2, "float")>]
[<InlineData(3, "int")>]
[<InlineData(4, "string")>]
[<InlineData(5, "float32")>]
[<InlineData(6, "float")>]
[<InlineData(8, "int64")>]
[<InlineData(9, "int")>]
let ``conversion quick fix proposes the function that bridges the two types``
    (line: int)
    (expected: string)
    =
    task {
        let! (state, dir, _fsproj, paths) = loadWorkspace [ "Conversions.fs", CONVERSION_SOURCE ]
        try
            let! titles = conversionTitlesAt state paths[0] line
            let offered = String.concat " | " titles
            Assert.True(
                titles |> List.exists (fun title -> title.Contains(expected)),
                $"no conversion to '{expected}' among: {offered}"
            )
        finally
            cleanup dir
    }

/// F# 6 widens `int` to `float` and to `int64` implicitly, so those lines are not
/// errors at all. Offering a conversion there would be noise on correct code, so
/// the fixer must stay silent — the mapping exists for mismatches reported in
/// other positions, not for these.
[<Theory>]
[<InlineData(1)>]
[<InlineData(7)>]
let ``implicitly widened numerics offer no conversion at all`` (line: int) =
    task {
        let! (state, dir, _fsproj, paths) = loadWorkspace [ "Conversions.fs", CONVERSION_SOURCE ]
        try
            let! titles = conversionTitlesAt state paths[0] line
            Assert.Empty(titles)
        finally
            cleanup dir
    }


// ── Call and type hierarchy ────────────────────────────────────────

let private HIERARCHY_SOURCE =
    source
        [ "module Hier"
          "type IShape ="
          "    abstract member Area: unit -> int"
          ""
          "type Square() ="
          "    interface IShape with"
          "        member _.Area() = 4"
          ""
          "let helper (x: int) = x + 1"
          "let caller () = helper 1"
          "let outer () = caller ()" ]

let private hierarchyProject () = loadWorkspace [ "Hier.fs", HIERARCHY_SOURCE ]

let private names (items: FSharpHierarchy.HierItem list) = items |> List.map _.Name

/// Call hierarchy must resolve in both directions from the same binding: who
/// calls `helper`, and what `caller` calls. A direction that silently returns
/// nothing looks identical to "no callers" in the editor.
[<Fact>]
let ``call hierarchy resolves callers and callees`` () = task {
    let! (state, dir, _fsproj, paths) = hierarchyProject ()
    try
        let! prepared = FSharpHierarchy.prepareCall state paths[0] 8 5
        Assert.True(prepared.IsSome, "helper must be preparable as a call-hierarchy item")
        let! incoming = FSharpHierarchy.incomingCalls state paths[0] 8 5
        Assert.Contains("caller", names incoming)
        let! outgoing = FSharpHierarchy.outgoingCalls state paths[0] 9 5
        Assert.Contains("helper", names outgoing)
    finally
        cleanup dir
}

/// Type hierarchy must walk both ways across an interface implementation.
[<Fact>]
let ``type hierarchy resolves supertypes and subtypes`` () = task {
    let! (state, dir, _fsproj, paths) = hierarchyProject ()
    try
        let! prepared = FSharpHierarchy.prepareType state paths[0] 4 6
        Assert.True(prepared.IsSome, "Square must be preparable as a type-hierarchy item")
        let! supers = FSharpHierarchy.supertypes state paths[0] 4 6
        Assert.Contains("IShape", names supers)
        let! subs = FSharpHierarchy.subtypes state paths[0] 1 6
        Assert.Contains("Square", names subs)
    finally
        cleanup dir
}
