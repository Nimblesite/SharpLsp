/// Pure unit tests for the dead-code analyzer's FCS-independent surface
/// ([FS-ANALYZER-DEADCODE]). The semantic, project-wide behavior is covered by
/// the IPC end-to-end suite; these lock in the config, path, and range-mapping
/// helpers that the e2e fixtures cannot easily drive.
module SharpLsp.Sidecar.FSharp.Tests.FSharpAnalyzersTests

open Xunit
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp

[<Fact>]
let ``Default config enables dead-code and disables monorepo`` () =
    let cfg = FSharpAnalyzers.AnalyzerConfig.Default
    Assert.True(cfg.DeadCodeEnabled)
    Assert.False(cfg.Monorepo)

[<Fact>]
let ``Create config carries the supplied flags`` () =
    let cfg = FSharpAnalyzers.AnalyzerConfig.Create(false, true)
    Assert.False(cfg.DeadCodeEnabled)
    Assert.True(cfg.Monorepo)

[<Fact>]
let ``samePath is true for identical paths`` () =
    Assert.True(FSharpAnalyzers.samePath "/tmp/Foo.fs" "/tmp/Foo.fs")

[<Fact>]
let ``samePath normalizes relative segments`` () =
    Assert.True(FSharpAnalyzers.samePath "/tmp/sub/../Foo.fs" "/tmp/Foo.fs")

[<Fact>]
let ``samePath is false for different files`` () =
    Assert.False(FSharpAnalyzers.samePath "/tmp/Foo.fs" "/tmp/Bar.fs")

[<Fact>]
let ``samePath falls back to ordinal compare on invalid paths`` () =
    // A NUL byte makes Path.GetFullPath throw, exercising the catch branch.
    let bad = "bad\000path.fs"
    Assert.True(FSharpAnalyzers.samePath bad bad)
    Assert.False(FSharpAnalyzers.samePath bad "other\000path.fs")

[<Fact>]
let ``buildDiagnostic maps a 1-based range to 0-based positions`` () =
    // FCS's mkRange normalizes file names to native full paths (on Windows,
    // `/tmp/X.fs` becomes `C:\tmp\X.fs`), so anchor the fixture to a path
    // that is already in native full form on every platform.
    let path =
        System.IO.Path.GetFullPath(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "X.fs"))

    let r = Range.mkRange path (Position.mkPos 5 2) (Position.mkPos 5 9)
    let d = FSharpAnalyzers.buildDiagnostic "SLSPF0101" "Warning" "msg" r
    Assert.Equal(path, d.FilePath)
    Assert.Equal(4, d.StartLine)
    Assert.Equal(2, d.StartCharacter)
    Assert.Equal(4, d.EndLine)
    Assert.Equal(9, d.EndCharacter)
    Assert.Equal("SLSPF0101", d.Code)
    Assert.Equal("Warning", d.Severity)
    Assert.Equal("msg", d.Message)

[<Fact>]
let ``deadCodeDiagnostics returns empty when disabled`` () =
    let cfg = FSharpAnalyzers.AnalyzerConfig.Create(false, true)
    Assert.Empty(FSharpAnalyzers.deadCodeDiagnostics cfg [||])

[<Fact>]
let ``deadCodeDiagnostics returns empty for no symbol uses`` () =
    Assert.Empty(FSharpAnalyzers.deadCodeDiagnostics FSharpAnalyzers.AnalyzerConfig.Default [||])

[<Fact>]
let ``deadCodeDiagnosticsForFile returns empty for no symbol uses`` () =
    let result =
        FSharpAnalyzers.deadCodeDiagnosticsForFile
            FSharpAnalyzers.AnalyzerConfig.Default [||] "/tmp/X.fs"
    Assert.Empty(result)

[<Fact>]
let ``lineGetter returns the 1-based line and empty out of range`` () =
    let get = FSharpAnalyzers.lineGetter "alpha\nbeta\ngamma"
    Assert.Equal("alpha", get 1)
    Assert.Equal("beta", get 2)
    Assert.Equal("gamma", get 3)
    Assert.Equal("", get 0)
    Assert.Equal("", get 99)

[<Fact>]
let ``lineGetter normalizes CRLF endings`` () =
    let get = FSharpAnalyzers.lineGetter "one\r\ntwo"
    Assert.Equal("one", get 1)
    Assert.Equal("two", get 2)

[<Fact>]
let ``unusedOpenDiagnostics builds a hint per range`` () =
    let r = Range.mkRange "/tmp/O.fs" (Position.mkPos 3 0) (Position.mkPos 3 16)
    let diags = FSharpAnalyzers.unusedOpenDiagnostics [ r ]
    Assert.Equal(1, diags.Length)
    Assert.Equal("SLSPF0102", diags[0].Code)
    Assert.Equal("Hint", diags[0].Severity)
    Assert.Equal(2, diags[0].StartLine)
    Assert.Contains("open", diags[0].Message)

[<Fact>]
let ``unusedOpenDiagnostics is empty for no ranges`` () =
    Assert.Empty(FSharpAnalyzers.unusedOpenDiagnostics [])

[<Fact>]
let ``simplifyNameDiagnostics names the redundant qualifier`` () =
    let r = Range.mkRange "/tmp/Q.fs" (Position.mkPos 4 0) (Position.mkPos 4 12)
    let diags = FSharpAnalyzers.simplifyNameDiagnostics [ (r, "DateTime") ]
    Assert.Equal(1, diags.Length)
    Assert.Equal("SLSPF0103", diags[0].Code)
    Assert.Equal("Hint", diags[0].Severity)
    Assert.Contains("DateTime", diags[0].Message)
    Assert.Contains("Redundant", diags[0].Message)
