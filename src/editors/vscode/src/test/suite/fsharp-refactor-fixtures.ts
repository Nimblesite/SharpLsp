// Real-project overlay fixtures for [ANALYZERS-FSAC-PARITY] and [RENAME-TESTS].

export interface CodeFixScenario {
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly title: string;
  readonly diagnostic: string;
  readonly replacement: string;
  readonly occurrence?: number;
}

export const OPEN_SCENARIOS: readonly CodeFixScenario[] = [
  {
    name: 'System.IO Path',
    source:
      'module FSharpFixtures.RefactorOpen\n\nlet value = Path.GetTempPath()\nlet sentinel = 41\n',
    target: 'Path.GetTempPath',
    title: "Add 'open System.IO'",
    diagnostic: 'FS0039',
    replacement: 'open System.IO\n',
  },
  {
    name: 'System.IO File',
    source:
      'module FSharpFixtures.RefactorOpen\n\nlet value = File.Exists("item")\nlet sentinel = 41\n',
    target: 'File.Exists',
    title: "Add 'open System.IO'",
    diagnostic: 'FS0039',
    replacement: 'open System.IO\n',
  },
  {
    name: 'System.IO Directory',
    source:
      'module FSharpFixtures.RefactorOpen\n\nlet value = Directory.GetCurrentDirectory()\nlet sentinel = 41\n',
    target: 'Directory.GetCurrentDirectory',
    title: "Add 'open System.IO'",
    diagnostic: 'FS0039',
    replacement: 'open System.IO\n',
  },
  {
    name: 'regular expressions',
    source:
      'module FSharpFixtures.RefactorOpen\n\nlet value = Regex.IsMatch("abc", "a")\nlet sentinel = 42\n',
    target: 'Regex.IsMatch',
    title: "Add 'open System.Text.RegularExpressions'",
    diagnostic: 'FS0039',
    replacement: 'open System.Text.RegularExpressions\n',
  },
  {
    name: 'tasks',
    source: 'module FSharpFixtures.RefactorOpen\n\nlet value = Task.Delay(1)\nlet sentinel = 43\n',
    target: 'Task.Delay',
    title: "Add 'open System.Threading.Tasks'",
    diagnostic: 'FS0039',
    replacement: 'open System.Threading.Tasks\n',
  },
  {
    name: 'generic Dictionary',
    source:
      'module FSharpFixtures.RefactorOpen\n\nlet value = Dictionary<int, string>()\nlet sentinel = 44\n',
    target: 'Dictionary<int, string>',
    title: "Add 'open System.Collections.Generic'",
    diagnostic: 'FS0039',
    replacement: 'open System.Collections.Generic\n',
  },
];

export function falseOpenSource(name: string): string {
  return `module FSharpFixtures.RefactorOpen\n\nlet value = ${name} 1\nlet sentinel = "heuristic-negative"\n`;
}

export const UNUSED_VALUE_SOURCE =
  'module FSharpFixtures.RefactorUnused\n\nlet run () =\n    let unusedValue = 42\n    ()\n\nlet sentinel = 45\n';

export const IGNORE_SOURCE =
  'module FSharpFixtures.RefactorIgnore\n\nlet run () =\n    1 + 1\n    ()\n\nlet sentinel = 46\n';

export const MATCH_FIX_SOURCE = `module FSharpFixtures.RefactorMatch

type Shape = A | B

let incomplete shape =
    match shape with
    | A -> 1

let later shape =
    match shape with
    | A -> 10
    | B -> 20

let redundant shape =
    match shape with
    | A -> 100
    | B -> 200
    | A -> 300

let sentinel = 47
`;

type ConversionInput = readonly [string, string, string, string, string, string];

const CONVERSION_INPUTS: readonly ConversionInput[] = [
  ['float from int', 'float', 'int', '1', "Convert to float using 'float'", '(float actualValue)'],
  [
    'float from decimal',
    'float',
    'decimal',
    '1M',
    "Convert to float using 'float'",
    '(float actualValue)',
  ],
  ['int from float', 'int', 'float', '1.0', "Convert to int using 'int'", '(int actualValue)'],
  [
    'string from int',
    'string',
    'int',
    '1',
    "Convert to string using 'string'",
    '(string actualValue)',
  ],
  [
    'float32 from float',
    'float32',
    'float',
    '1.0',
    "Convert to float32 using 'float32'",
    '(float32 actualValue)',
  ],
  [
    'float from float32',
    'float',
    'float32',
    '1.0f',
    "Convert to float using 'float'",
    '(float actualValue)',
  ],
  ['int64 from int', 'int64', 'int', '1', "Convert to int64 using 'int64'", '(int64 actualValue)'],
  [
    'int64 from float',
    'int64',
    'float',
    '1.0',
    "Convert to int64 using 'int64'",
    '(int64 actualValue)',
  ],
  ['int from int64', 'int', 'int64', '1L', "Convert to int using 'int'", '(int actualValue)'],
];

const IMPLICIT_CONVERSION_NAMES = new Set(['float from int', 'int64 from int']);

function conversionScenario([
  name,
  expected,
  actualType,
  literal,
  title,
  replacement,
]: ConversionInput): CodeFixScenario {
  return {
    name,
    source: `module FSharpFixtures.RefactorConversion\n\nlet accept (value: ${expected}) = value\nlet actualValue: ${actualType} = ${literal}\nlet value = accept actualValue\nlet sentinel = 48\n`,
    target: 'actualValue',
    title,
    diagnostic: 'FS0001',
    replacement,
    occurrence: 1,
  };
}

export const CONVERSION_SCENARIOS: readonly CodeFixScenario[] = CONVERSION_INPUTS.filter(
  ([name]) => !IMPLICIT_CONVERSION_NAMES.has(name),
).map(conversionScenario);

export const IMPLICIT_CONVERSION_SCENARIOS: readonly CodeFixScenario[] = CONVERSION_INPUTS.filter(
  ([name]) => IMPLICIT_CONVERSION_NAMES.has(name),
).map(conversionScenario);

export const UNSUPPORTED_CONVERSION_SOURCE =
  'module FSharpFixtures.RefactorConversion\n\nlet value : bool = 1\nlet sentinel = 49\n';

export const UNION_SOURCE = `module FSharpFixtures.RefactorUnion

type Payload =
    | Anchor
    | Empty
    | One of int
    | Many of int * string

let render payload =
    match payload with
    | Anchor -> "anchor"

let sentinel = "union-sentinel"
`;

export const MATCH_BANG_SOURCE = `module FSharpFixtures.RefactorMatchBang

open System.Threading.Tasks

type Choice = First | Second

let choose (pending: Task<Choice>) = task {
    match! pending with
    | First -> return 1
}

let sentinel = 50
`;

export const EXHAUSTIVE_UNION_SOURCE = `module FSharpFixtures.RefactorUnion

type Choice = First | Second
let choose value =
    match value with
    | First -> 1
    | Second -> 2
`;

export const RECORD_SOURCE = `module FSharpFixtures.RefactorRecord

type Defaults =
    { Keep: int
      Text: string
      Number: int
      Number32: int32
      Number64: int64
      Float: float
      Double: double
      Money: decimal
      Flag: bool
      Maybe: int option
      Items: int list
      Values: int array
      Other: System.Guid }

let value: Defaults = { Keep = 1 }
let sentinel = 51
`;

export const COMPLETE_RECORD_SOURCE = `module FSharpFixtures.RefactorRecord

type Point = { X: int; Y: int }
let point: Point = { X = 1; Y = 2 }
`;

export const RECORD_COPY_UPDATE_SOURCE = `module FSharpFixtures.RefactorRecord

type Point = { X: int; Y: int }
let point: Point = { X = 1; Y = 2 }
let updated = { point with X = 3 }
let sentinel = 56
`;

export const WILDCARD_UNION_SOURCE = `module FSharpFixtures.RefactorUnion

type Choice = First | Second | Third
let choose value =
    match value with
    | _ -> 0
let sentinel = 57
`;

export const PARTIAL_INTERFACE_SOURCE = `module FSharpFixtures.RefactorInterface

type IShape =
    abstract member Area: unit -> float
    abstract member Name: string

type Square() =
    interface IShape with
        member _.Name = "square"

let sentinel = 52
`;

export const GENERIC_INTERFACE_SOURCE = `module FSharpFixtures.RefactorInterface

type IBox<'T> =
    abstract member Value: 'T
    abstract member Map: 'T -> 'T

type StringBox() =
    interface IBox<string> with
        member _.Value = "ready"

let sentinel = 53
`;

export const NESTED_GENERIC_INTERFACE_SOURCE = `module FSharpFixtures.RefactorInterface

type IOther =
    abstract member Code: string

type IWrapper<'T> =
    abstract member Wrap: 'T -> 'T

type Wrapper() =
    interface IWrapper<IOther> with

let sentinel = 54
`;

export const OBJECT_EXPRESSION_INTERFACE_SOURCE = `module FSharpFixtures.RefactorInterface

type IShape =
    abstract member Area: unit -> float
    abstract member Name: string

let shape =
    { new IShape with
        member _.Name = "shape" }

let sentinel = 55
`;

export const EMPTY_INTERFACE_WITH_SOURCE = `module FSharpFixtures.RefactorInterface

type IShape =
    abstract member Area: unit -> float

type Square() =
    interface IShape with

let sentinel = 52
`;

export const EMPTY_INTERFACE_SOURCE = `module FSharpFixtures.RefactorInterface

type IShape =
    abstract member Area: unit -> float

type Square() =
    interface IShape

let sentinel = 52
`;

export const COMPLETE_INTERFACE_SOURCE = `module FSharpFixtures.RefactorInterface

type IShape =
    abstract member Area: unit -> float

type Square() =
    interface IShape with
        member _.Area() = 1.0
`;
