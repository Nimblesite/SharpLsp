// The Expecto test project the Test Explorer and test-debugging suites share.
//
// Expecto tests are VALUES — `testList "name" [ testCase "name" ... ]` — not
// attributed methods, so a test's fully-qualified name is the path of list
// names joined by dots, spaces kept: no namespace, no class, no method. The
// project runs under VSTest through YoloDev.Expecto.TestSdk, the adapter the
// Expecto template ships, and needs its own entry point (the adapter refuses an
// assembly without one: "Test is null. Assembly may not be initialized").
//
// Covers [TEST-DISCOVERY-FQN] and "Expecto/FsCheck test debugging | P1 (F#
// parity)" of [DEBUG-FEATURES-TESTS].
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AnchoredSource } from './debug-anchors';
import { buildProjectXml, type PackageRef } from './dotnet-project-kit';

/**
 * The library, its VSTest adapter and the host. Pinned as a PAIR: each adapter
 * release is built against one Expecto range, and YoloDev.Expecto.TestSdk 1.0.0
 * declares `[9.0.0, 10.0.0)`, so no published adapter runs Expecto 11 yet —
 * 11.1.1 with 1.0.0 discovers but every run dies on a missing `TestPrinters`
 * constructor. 0.16.1 is built against 10.2.3.
 */
export const EXPECTO_PACKAGES: readonly PackageRef[] = [
  { id: 'Expecto', version: '10.2.3' },
  { id: 'YoloDev.Expecto.TestSdk', version: '0.16.1' },
  { id: 'Microsoft.NET.Test.Sdk', version: '18.12.0' },
];

/** The project directory and file base name. */
export const EXPECTO_PROJECT = 'Fs.Expecto';

/** The source file holding the tests; `Main.fs` follows it in compile order. */
export const EXPECTO_SOURCE_FILE = 'Tests.fs';

/** Each test's id: its list path, spaces and all. */
export const EXPECTO_PASSING = 'calculator.adds two numbers';
export const EXPECTO_FAILING = 'calculator.fails on purpose';
export const EXPECTO_PENDING = 'calculator.skipped on purpose';
export const EXPECTO_NESTED = 'calculator.nested.multiplies';
export const EXPECTO_ALL: readonly string[] = [
  EXPECTO_PASSING,
  EXPECTO_FAILING,
  EXPECTO_PENDING,
  EXPECTO_NESTED,
];

/** The message the failing case's expectation carries, which a run must surface. */
export const EXPECTO_FAILURE_MESSAGE = 'the sum is wrong on purpose';

/** The tests, ANCHORED: the passing case has locals and a helper call to stop on. */
export const EXPECTO_SOURCE = new AnchoredSource(
  `
module Fs.Expecto.Tests

open Expecto

let private add left right =
    let sum = left + right                                             // @anchor:ex-add-body
    sum                                                                // @anchor:ex-add-return

[<Tests>]
let calculator =
  testList "calculator" [
    testCase "adds two numbers" <| fun _ ->
      let seed = 20                                                    // @anchor:ex-seed
      let result = add seed 22                                         // @anchor:ex-call
      Expect.equal result 42 "sum"                                     // @anchor:ex-assert
    testCase "fails on purpose" <| fun _ ->
      Expect.equal (1 + 2) 4 "${EXPECTO_FAILURE_MESSAGE}"
    ptestCase "skipped on purpose" <| fun _ -> ()
    testList "nested" [
      testCase "multiplies" <| fun _ -> Expect.equal (2 * 3) 6 "product"
    ]
  ]
`
    .trim()
    .split('\n'),
);

/** The entry point the adapter requires, as `dotnet new expecto` writes it. */
const EXPECTO_MAIN = [
  'module Fs.Expecto.Main',
  '',
  'open Expecto',
  '',
  '[<EntryPoint>]',
  'let main argv = Tests.runTestsInAssemblyWithCLIArgs [] argv',
  '',
].join('\n');

/** The project file; `properties` merge over the Expecto ones (e.g. a Configuration). */
export function expectoProjectXml(properties: Readonly<Record<string, string>> = {}): string {
  return buildProjectXml({
    packages: EXPECTO_PACKAGES,
    compileIncludes: [EXPECTO_SOURCE_FILE, 'Main.fs'],
    properties: { OutputType: 'Exe', GenerateProgramFile: 'false', ...properties },
  });
}

/** Write the project into `dir` and return the path of its test source. */
export function writeExpectoProject(
  dir: string,
  properties: Readonly<Record<string, string>> = {},
): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${EXPECTO_PROJECT}.fsproj`),
    expectoProjectXml(properties),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'Main.fs'), EXPECTO_MAIN, 'utf8');
  const sourceFile = path.join(dir, EXPECTO_SOURCE_FILE);
  fs.writeFileSync(sourceFile, EXPECTO_SOURCE.text, 'utf8');
  return sourceFile;
}
