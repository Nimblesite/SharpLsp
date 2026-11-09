/// F# inlay hints read like FSAC's on a real project: types in their short display
/// names, no parameter names on operators, each parameter name before its own
/// argument, and a pipeline's input type before its `|>`. Real `.fsproj`, real
/// FSharpChecker (GitHub #389).
module SharpLsp.Sidecar.FSharp.Tests.FSharpInlayHintTests

open System.IO
open Xunit
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open SharpLsp.Sidecar.FSharp.Tests.SidecarEndToEndTests

/// A value of a .NET type, a function over operators, a pipeline, a method call and a
/// curried call of three arguments.
let private appended =
    [ "let random = System.Random()"
      "let isLucky x = x % 7 = 0"
      "let lengths = [ \"a\"; \"bb\" ] |> List.map String.length"
      "let parts = \"a,b\".Split ','"
      "let total = List.fold (fun acc item -> acc + item) 0 [ 1; 2 ]"
      "let (|>) (value: int) (mapping: int -> string) = mapping value"
      "let rendered = 5 |> string" ]

/// The line of `source` that starts with `prefix`, and the column of `text` on it.
let private at (lines: string array) (prefix: string) (text: string) =
    let line = lines |> Array.findIndex _.StartsWith(prefix)
    line, lines[line].IndexOf(text, System.StringComparison.Ordinal)

/// The labels of the hints of `kind` on `line`, by column.
let private labelsOn (hints: FSharpInlayHints.InlayHintItem list) kind line =
    hints
    |> List.filter (fun hint -> hint.Kind = kind && hint.Line = line)
    |> List.map (fun hint -> hint.Character, hint.Label)
    |> List.sort

[<Fact>]
let ``inlay hints use short type names, skip operators and sit before each argument`` () =
    task {
        let dir = createTestProject ()
        try
            let ws = FSharpWorkspace.create ()
            let! _ = FSharpWorkspaceLoading.loadProject ws dir
            let src = NativePaths.Resolve(dir, "Library.fs")
            let edited = File.ReadAllText(src).Replace("\r\n", "\n") + "\n" + String.concat "\n" appended + "\n"
            FSharpWorkspace.applyDidChange ws src edited
            let lines = edited.Split('\n')
            let! hints = FSharpInlayHints.getInlayHints ws src 0 (lines.Length - 1)

            let randomLine, randomColumn = at lines "let random" "random"
            Assert.Contains((randomColumn + 6, ": Random"), labelsOn hints 1 randomLine)

            let luckyLine, luckyColumn = at lines "let isLucky" "isLucky"
            Assert.Contains((luckyColumn + 7, ": int -> bool"), labelsOn hints 1 luckyLine)
            Assert.Empty(labelsOn hints 2 luckyLine)

            let lengthsLine, pipe = at lines "let lengths" "|>"
            Assert.Contains((pipe, ": string list"), labelsOn hints 1 lengthsLine)
            let _, mapped = at lines "let lengths" "String.length"
            Assert.Equal<(int * string) list>([ mapped, "mapping:" ], labelsOn hints 2 lengthsLine)

            let partsLine, separator = at lines "let parts" "','"
            Assert.Equal<(int * string) list>([ separator, "separator:" ], labelsOn hints 2 partsLine)

            let totalLine, folder = at lines "let total" "(fun"
            let _, state = at lines "let total" "0 ["
            let _, list = at lines "let total" "[ 1; 2 ]"
            let expected = [ folder, "folder:"; state, "state:"; list, "list:" ]
            Assert.Equal<(int * string) list>(expected, labelsOn hints 2 totalLine)

            let renderedLine, customPipe = at lines "let rendered" "|>"
            Assert.Contains((customPipe, ": int"), labelsOn hints 1 renderedLine)

            Assert.DoesNotContain(hints, fun hint -> hint.Label.Contains "Microsoft.FSharp")
            Assert.DoesNotContain(hints, fun hint -> hint.Label.Contains "System.")
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }

// [SHARPLSP-FEATURES-INTELLIGENCE] Each positional argument gets its own parameter name.
[<Theory>]
[<InlineData("let result = System.Math.Clamp(5, 0, 10)", "31:value:|34:min:|37:max:")>]
[<InlineData("let result = \"abcd\".Substring(1, 2)", "30:startIndex:|33:length:")>]
[<InlineData("let result = System.Math.Clamp(value = 5, min = 0, max = 10)", "")>]
[<InlineData("let result = System.Math.Clamp(5, min = 0, max = 10)", "31:value:")>]
[<InlineData("let result = \"abcd\".Substring(startIndex = 1, length = 2)", "")>]
[<InlineData("let result = \"abcd\".Substring(1, length = 2)", "30:startIndex:")>]
let ``tupled calls label each positional argument and omit names already written`` (source: string) (expected: string) =
    task {
        let dir = createTestProject ()
        try
            let ws = FSharpWorkspace.create ()
            let! _ = FSharpWorkspaceLoading.loadProject ws dir
            let file = NativePaths.Resolve(dir, "Library.fs")
            FSharpWorkspace.applyDidChange ws file ("module TestProject.Library\n" + source + "\n")
            let! _, check, _ = FSharpCodeActionKit.checkedFixture ws file
            Assert.DoesNotContain(check.Diagnostics, fun diagnostic -> diagnostic.Severity = FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Error)
            let! hints = FSharpInlayHints.getInlayHints ws file 1 1
            let actual = labelsOn hints 2 1 |> List.map (fun (column, label) -> $"{column}:{label}") |> String.concat "|"
            Assert.Equal(expected, actual)
        finally
            try Directory.Delete(dir, true) with _ -> ()
    }
