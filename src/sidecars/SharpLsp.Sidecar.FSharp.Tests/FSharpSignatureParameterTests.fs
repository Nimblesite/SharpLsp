/// Active-parameter resolution for F# signature help. Implements [FS-SIGHELP].
///
/// `signatureHelp` always reports `ActiveParameter = 0`, so every parameter after
/// the first is highlighted wrongly: the caret on the 2nd or 3rd argument of a
/// static member must report 1 and 2. Nested calls, commas in strings and overlay
/// edits can only be resolved from the caret, never from the line's raw text.
module SharpLsp.Sidecar.FSharp.Tests.FSharpSignatureParameterTests

open Xunit
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.FSharpCoverageTests
open SharpLsp.Sidecar.FSharp.Tests.FSharpRenameSemanticTests

// Line indices (0-based): 3 = flat call, 4 = nested, 5 = comma in a string.
let private SIGNATURE_SOURCE =
    source
        [ "module Signatures"
          "type Calc ="
          "    static member Add(a: int, b: int, c: int) = a + b + c"
          "let first = Calc.Add(1, 2, 3)"
          "let nested = Calc.Add(1, Calc.Add(4, 5, 6), 3)"
          "let text = Calc.Add(\"x,y\".Length, 2, 3)" ]

let private EDITED_SOURCE =
    source
        [ "module Signatures"
          "type Calc ="
          "    static member Add(a: int, b: int, c: int) = a + b + c"
          "let edited = Calc.Add(7, 8, 9)" ]

/// 0-based (line, character) of the `nth` occurrence of `needle` on `lineIdx`.
let private at (lines: string array) lineIdx (needle: string) (nth: int) =
    let line = lines[lineIdx]
    let rec scan (from: int) (n: int) =
        match line.IndexOf(needle, from) with
        | -1 -> failwith $"'{needle}' missing on line {lineIdx} (occurrence {nth})"
        | idx when n = 0 -> idx
        | idx -> scan (idx + needle.Length) (n - 1)
    (lineIdx, scan 0 nth)

let private linesOf (text: string) = text.Replace("\r\n", "\n").Split('\n')

/// The active parameter reported with the caret on `needle` must be `expected`.
let private assertActive state path text lineIdx needle expected =
    task {
        let line, character = at (linesOf text) lineIdx needle 0
        let! help = FSharpSignature.signatureHelp state path line character
        match help with
        | None -> failwith $"no signature help at ({line}, {character})"
        | Some help ->
            Assert.NotEmpty(help.Signatures)
            Assert.Equal<string list>([ "a"; "b"; "c" ], help.Signatures[0].Parameters)
            Assert.Equal(expected, help.ActiveParameter)
    }

[<Fact>]
let ``signature help reports the parameter the caret sits on`` () =
    task {
        let! (state, dir, _fsproj, paths) = loadWorkspace [ "Signatures.fs", SIGNATURE_SOURCE ]

        try
            // Flat call: each argument position, in order.
            do! assertActive state paths[0] SIGNATURE_SOURCE 3 "1," 0
            do! assertActive state paths[0] SIGNATURE_SOURCE 3 "2," 1
            do! assertActive state paths[0] SIGNATURE_SOURCE 3 "3)" 2

            // Nested call: the outer call keeps its own parameter index.
            do! assertActive state paths[0] SIGNATURE_SOURCE 4 "1, Calc" 0
            do! assertActive state paths[0] SIGNATURE_SOURCE 4 "Calc.Add(4" 1
            do! assertActive state paths[0] SIGNATURE_SOURCE 4 "3)" 2

            // Inner call: the innermost call wins, again from argument 0.
            do! assertActive state paths[0] SIGNATURE_SOURCE 4 "4, 5" 0
            do! assertActive state paths[0] SIGNATURE_SOURCE 4 "5, 6" 1
            do! assertActive state paths[0] SIGNATURE_SOURCE 4 "6)" 2

            // A comma inside a string literal is part of argument 0, not a separator.
            do! assertActive state paths[0] SIGNATURE_SOURCE 5 "y\"." 0
            do! assertActive state paths[0] SIGNATURE_SOURCE 5 "2," 1
            do! assertActive state paths[0] SIGNATURE_SOURCE 5 "3)" 2

            // Unsaved edits: the overlay text is what the caret is resolved against.
            FSharpWorkspace.applyDidChange state paths[0] EDITED_SOURCE
            do! assertActive state paths[0] EDITED_SOURCE 3 "7," 0
            do! assertActive state paths[0] EDITED_SOURCE 3 "8," 1
            do! assertActive state paths[0] EDITED_SOURCE 3 "9)" 2
        finally
            cleanup dir
    }

/// Named arguments are matched to the declaration by name, not by position, so
/// an out-of-order named call must report declaration indices (2, 0, 1) rather
/// than argument positions (0, 1, 2). Line indices: 3 = out-of-order named,
/// 4 = mixed positional + named. The unsaved overlay appends a new call at line 6.
let private NAMED_SOURCE =
    source
        [ "module Signatures"
          "type Calc ="
          "    static member Add(a: int, b: int, c: int) = a + b + c"
          "let named = Calc.Add(c = 3, a = 1, b = 2)"
          "let mixed = Calc.Add(1, c = 3, b = 2)" ]

[<Fact>]
let ``signature help resolves named arguments out of declaration order`` () =
    task {
        let! (state, dir, _fsproj, paths) = loadWorkspace [ "Signatures.fs", NAMED_SOURCE ]

        try
            // Out-of-order named call: each name selects its declaration index.
            do! assertActive state paths[0] NAMED_SOURCE 3 "c = 3" 2
            do! assertActive state paths[0] NAMED_SOURCE 3 "a = 1" 0
            do! assertActive state paths[0] NAMED_SOURCE 3 "b = 2" 1

            // Mixed positional + named: positional fills `a`, then names win.
            do! assertActive state paths[0] NAMED_SOURCE 4 "1, c" 0
            do! assertActive state paths[0] NAMED_SOURCE 4 "c = 3" 2
            do! assertActive state paths[0] NAMED_SOURCE 4 "b = 2" 1

            // Unsaved overlay permutation: resolution follows the overlay text.
            let edited = SIGNATURE_SOURCE + "let overlay = Calc.Add(b = 8, c = 9, a = 7)\n"
            FSharpWorkspace.applyDidChange state paths[0] edited
            do! assertActive state paths[0] edited 6 "b = 8" 1
            do! assertActive state paths[0] edited 6 "c = 9" 2
            do! assertActive state paths[0] edited 6 "a = 7" 0
        finally
            cleanup dir
    }

[<Fact>]
let ``signature help keeps the current parameter while the closing parenthesis is missing`` () = task {
    let! (state, dir, _fsproj, paths) = loadWorkspace [ "Signatures.fs", SIGNATURE_SOURCE ]
    try
        for call, expected in
            [ "Calc.Add(", 0; "Calc.Add(1", 0; "Calc.Add(1,", 1
              "Calc.Add(1, 2", 1; "Calc.Add(1, 2,", 2; "Calc.Add(1, 2, 3", 2 ] do
            let pending = "let pending = " + call
            FSharpWorkspace.applyDidChange state paths[0] (SIGNATURE_SOURCE + pending)
            let! result = FSharpSignature.signatureHelp state paths[0] 6 pending.Length
            match result with
            | None -> failwith $"no signature help while typing {call}"
            | Some help ->
                Assert.NotEmpty(help.Signatures)
                Assert.Equal<string list>([ "a"; "b"; "c" ], help.Signatures[0].Parameters)
                Assert.Equal(expected, help.ActiveParameter)
    finally
        cleanup dir
}
