// The two debuggee programs the step-through suites drive, plus their projects.
//
// Spec: [DEBUG-FEATURES-STEPPING], [DEBUG-FEATURES-BREAKPOINTS],
// [DEBUG-FEATURES-VARIABLES], [DEBUG-FEATURES-EXCEPTIONS],
// [DEBUG-FEATURES-STACK-ASYNC], [DEBUG-FSHARP-UNIONS], [DEBUG-FSHARP-STEPPING].
//
// ONE assembly per language serves every suite. The behaviour under test is
// selected by `argv[0]` — a launch configuration's `args`, which is itself part
// of the specified launch schema — so a suite that needs an unhandled exception
// and a suite that needs a clean run share a single restore and build instead of
// each paying for their own. The C# and F# programs are deliberate mirrors of
// one another: [DEBUG-MISSION] requires "the same specified behavior for C# and
// F#", and a reduced F# fixture would quietly exempt F# from that.
//
// Every interesting statement carries a `// @anchor:` comment — see
// debug-anchors.ts — so no test in this repo hardcodes a line number.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AnchoredSource } from './debug-anchors';
import { buildProjectXml, writeProject } from './dotnet-project-kit';
import { TFM, builtDll, type ConsoleProject } from './run-debug-fixtures';

/** `argv[0]` values the fixtures understand. A launch config passes one in `args`. */
export const MODE = {
  /** Runs to completion, throws nothing. */
  plain: 'plain',
  /** Throws an `InvalidOperationException` and CATCHES it. */
  caught: 'caught',
  /** Throws an `ApplicationException` with an inner cause and never catches it. */
  unhandled: 'unhandled',
  /** Drives the three-deep `async`/`task` chain. */
  async: 'async',
  /** Every branch above, in source order. */
  both: 'both',
} as const;

/** The text the programs print once they have completed their work. */
export const DONE_MARKER = 'done';

/** The message of the exception the `caught` mode throws and handles. */
export const CAUGHT_MESSAGE = 'caught-by-design';

/** The message of the exception the `unhandled` mode lets escape. */
export const UNHANDLED_MESSAGE = 'unhandled-by-design';

/** The message of that exception's `InnerException` — the P2 chain case. */
export const INNER_MESSAGE = 'inner-cause';

/** The CLR type the `caught` mode throws. */
export const CAUGHT_TYPE = 'System.InvalidOperationException';

/** The CLR type the `unhandled` mode throws. */
export const UNHANDLED_TYPE = 'System.ApplicationException';

/** A materialised debuggee: its project, its anchored source, its assembly. */
export interface DebugFixture extends ConsoleProject {
  /** The anchored program text, for addressing lines by name. */
  readonly source: AnchoredSource;
  /** The assembly `dotnet build -c Debug` produces — a launch `program`. */
  readonly dll: string;
  /** The source file as a `Uri`, for breakpoints and editors. */
  readonly uri: vscode.Uri;
  /** `csharp` or `fsharp` — the languageId the document must open as. */
  readonly languageId: string;
}

const CSHARP_TEXT = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;

namespace StepTarget;

[DebuggerDisplay("Box({Label},{Value})")]
public sealed class Box
{
    public Box(int value, string label)
    {
        Value = value;                                                 // @anchor:box-ctor-value
        Label = label;                                                 // @anchor:box-ctor-label
    }

    public int Value { get; }

    public string Label { get; }

    public string Describe()
    {
        var rendered = Label + "=" + Value.ToString();                 // @anchor:box-describe
        return rendered;                                               // @anchor:box-describe-return
    }
}

public static class Program
{
    public static int Total;                                           // @anchor:total-field

    public static int Add(int left, int right)
    {
        var sum = left + right;                                        // @anchor:add-body
        return sum;                                                    // @anchor:add-return
    }

    public static int Accumulate(int seed)
    {
        var running = seed;                                            // @anchor:accumulate-entry
        for (var index = 1; index <= 3; index++)
        {
            running = Add(running, index);                             // @anchor:accumulate-call
        }

        Total = running;                                               // @anchor:accumulate-store
        return running;                                                // @anchor:accumulate-return
    }

    public static void ThrowCaught()
    {
        try
        {
            throw new InvalidOperationException("caught-by-design");    // @anchor:throw-caught
        }
        catch (InvalidOperationException error)
        {
            Console.WriteLine("handled " + error.Message);              // @anchor:catch-caught
        }
    }

    public static void ThrowUnhandled()
    {
        throw new ApplicationException("unhandled-by-design", new FormatException("inner-cause")); // @anchor:throw-unhandled
    }

    public static int Inspect(Box box)
    {
        var numbers = new List<int> { 10, 20, 30 };                    // @anchor:inspect-list
        var lookup = new Dictionary<string, int> { ["alpha"] = 1 };    // @anchor:inspect-map
        var letters = new[] { 'a', 'b' };                              // @anchor:inspect-array
        int? maybe = 42;                                               // @anchor:inspect-nullable
        var text = box.Describe();                                     // @anchor:inspect-describe
        Console.WriteLine(text + " " + lookup.Count.ToString() + " " + letters.Length.ToString()); // @anchor:inspect-print
        return numbers.Count + maybe.Value;                            // @anchor:inspect-return
    }

    public static async Task<int> LeafAsync(int seed)
    {
        await Task.Yield();                                            // @anchor:leaf-await
        return seed + 1;                                               // @anchor:leaf-return
    }

    public static async Task<int> MiddleAsync(int seed)
    {
        var leaf = await LeafAsync(seed);                              // @anchor:middle-await
        return leaf * 2;                                               // @anchor:middle-return
    }

    public static async Task<int> RootAsync(int seed)
    {
        var middle = await MiddleAsync(seed);                          // @anchor:root-await
        return middle + 1;                                             // @anchor:root-return
    }

    public static int Main(string[] args)
    {
        var mode = args.Length > 0 ? args[0] : "plain";                // @anchor:main-mode
        var total = Accumulate(2);                                     // @anchor:main-accumulate
        var box = new Box(total, "boxed");                             // @anchor:main-box
        Console.WriteLine("total=" + total.ToString());                // @anchor:main-print
        var count = Inspect(box);                                      // @anchor:main-inspect
        if (mode == "caught" || mode == "both")
        {
            ThrowCaught();                                             // @anchor:main-caught
        }

        if (mode == "async" || mode == "both")
        {
            Console.WriteLine(RootAsync(1).GetAwaiter().GetResult());  // @anchor:main-async
        }

        if (mode == "unhandled" || mode == "both")
        {
            ThrowUnhandled();                                          // @anchor:main-unhandled
        }

        Console.WriteLine("done " + mode + " " + count.ToString());    // @anchor:main-done
        return 0;                                                      // @anchor:main-return
    }
}
`;

const FSHARP_TEXT = `
module FsStepTarget.Program

open System
open System.Threading.Tasks

/// [DEBUG-FSHARP-UNIONS]: the variables panel must render this as Circle 5,
/// never as FSharpOption-style raw Tag/field pairs.
type Shape =
    | Circle of radius: int
    | Rect of width: int * height: int

/// [DEBUG-FEATURES-VARIABLES] lists F# record and tuple inspection as P1.
type Point = { X: int; Y: int }

let area (shape: Shape) =
    match shape with
    | Circle radius -> radius * radius * 3                             // @anchor:area-circle
    | Rect (width, height) -> width * height                           // @anchor:area-rect

let add left right =
    let sum = left + right                                             // @anchor:add-body
    sum                                                                // @anchor:add-return

let accumulate seed =
    let mutable running = seed                                         // @anchor:accumulate-entry
    for index in 1 .. 3 do
        running <- add running index                                   // @anchor:accumulate-call
    running                                                            // @anchor:accumulate-return

let throwCaught () =
    try
        raise (InvalidOperationException("caught-by-design"))           // @anchor:throw-caught
    with :? InvalidOperationException as error ->
        printfn "handled %s" error.Message                             // @anchor:catch-caught

let throwUnhandled () =
    raise (ApplicationException("unhandled-by-design", FormatException("inner-cause"))) // @anchor:throw-unhandled

let leafTask seed =
    task {
        do! Task.Yield()                                               // @anchor:leaf-await
        return seed + 1                                                // @anchor:leaf-return
    }

let rootTask seed =
    task {
        let! leaf = leafTask seed                                      // @anchor:root-await
        return leaf * 2                                                // @anchor:root-return
    }

[<EntryPoint>]
let main argv =
    let mode = if argv.Length > 0 then argv[0] else "plain"            // @anchor:main-mode
    let total = accumulate 2                                           // @anchor:main-accumulate
    let shape = Rect(3, 4)                                             // @anchor:main-shape
    let point = { X = total; Y = area shape }                          // @anchor:main-point
    let maybe = Some 42                                                // @anchor:main-option
    let pair = (total, "boxed")                                        // @anchor:main-tuple
    let numbers = [ 10; 20; 30 ]                                       // @anchor:main-list
    printfn "total=%d y=%d" total point.Y                              // @anchor:main-print
    if mode = "caught" || mode = "both" then throwCaught ()            // @anchor:main-caught
    if mode = "async" || mode = "both" then printfn "%d" ((rootTask 1).Result) // @anchor:main-async
    if mode = "unhandled" || mode = "both" then throwUnhandled ()      // @anchor:main-unhandled
    printfn "done %s %A %A %d" mode maybe pair numbers.Length          // @anchor:main-done
    0                                                                  // @anchor:main-return
`;

/** The anchored C# debuggee. Shared by every C# stepping suite. */
export const CSHARP_SOURCE = new AnchoredSource(CSHARP_TEXT.trim().split('\n'));

/** The anchored F# debuggee — the same program, statement for statement. */
export const FSHARP_SOURCE = new AnchoredSource(FSHARP_TEXT.trim().split('\n'));

/** The project name both the namespace and the assembly of the C# fixture use. */
export const CSHARP_NAME = 'StepTarget';

/** The project name both the module and the assembly of the F# fixture use. */
export const FSHARP_NAME = 'FsStepTarget';

/** `OutputType=Exe` plus a full portable PDB — a debuggee without one is unusable. */
const DEBUGGABLE: Readonly<Record<string, string>> = {
  OutputType: 'Exe',
  DebugType: 'portable',
  DebugSymbols: 'true',
  Optimize: 'false',
};

/** Assemble the fixture record once, so both writers agree on every field. */
function fixtureFor(
  dir: string,
  name: string,
  sourceFileName: string,
  source: AnchoredSource,
  languageId: string,
): DebugFixture {
  const project: ConsoleProject = {
    projectFile: path.join(dir, `${name}.${languageId === 'fsharp' ? 'fsproj' : 'csproj'}`),
    sourceFile: path.join(dir, sourceFileName),
    dir,
    assemblyName: name,
  };
  return {
    ...project,
    source,
    languageId,
    dll: builtDll(project, TFM),
    uri: vscode.Uri.file(project.sourceFile),
  };
}

/** Write the C# debuggee: project XML through the XML writer, source verbatim. */
export function writeCSharpStepTarget(dir: string): DebugFixture {
  writeProject(
    dir,
    `${CSHARP_NAME}.csproj`,
    buildProjectXml({ properties: DEBUGGABLE }),
    'Program.cs',
    CSHARP_SOURCE.text,
  );
  return fixtureFor(dir, CSHARP_NAME, 'Program.cs', CSHARP_SOURCE, 'csharp');
}

/** Write the F# debuggee. `<Compile Include>` is mandatory — F# never globs. */
export function writeFSharpStepTarget(dir: string): DebugFixture {
  writeProject(
    dir,
    `${FSHARP_NAME}.fsproj`,
    buildProjectXml({ properties: DEBUGGABLE, compileIncludes: ['Program.fs'] }),
    'Program.fs',
    FSHARP_SOURCE.text,
  );
  return fixtureFor(dir, FSHARP_NAME, 'Program.fs', FSHARP_SOURCE, 'fsharp');
}
