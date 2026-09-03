// The fixtures and shared assertions for DEBUGGING A TEST through the Test
// Explorer's Debug profile.
//
// [DEBUG-FEATURES-TESTS] is a table of rows — debug one test, debug a whole
// class or suite, honour breakpoints inside test methods, keep Just My Code on —
// and each of those has to be driven against several shapes of test: a plain
// fact, a fact that FAILS, a fact that is SKIPPED, a `[Theory]` whose rows run
// the same body twice, a second class, a second namespace, and the F# bindings
// [TEST-OVERVIEW] refuses to treat as a second-class case. One fixture per suite
// would mean one copy of that source per suite, so both the programs and the
// assertions every debug-a-test suite repeats live here.
//
// Covers [DEBUG-FEATURES-TESTS], with [TEST-DISCOVERY-FQN] for the names.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AnchoredSource } from './debug-anchors';
import type { DapRecorder } from './debug-dap-kit';
import { XUNIT_PACKAGES, createSolution, dotnet, projectXml } from './dotnet-project-kit';
import { isolateFromRepoMsbuild } from './run-debug-fixtures';
import { DEBUG_TYPE_ID, type DebugSessionRecorder, type ObservedSession } from './run-debug-kit';
import { deepEq, eq, requireAt, requireWorkspaceRoot } from './test-helpers';

/** The C# project the C# debug suites build. */
export const CS_PROJECT = 'DebugTestTarget';

/** The two namespaces its tests are declared in — the grouping permutation. */
export const CS_MATH_NAMESPACE = 'DebugTestTarget.Math';
export const CS_TEXT_NAMESPACE = 'DebugTestTarget.Text';

/** Every fully-qualified name the C# fixture exposes. */
export const CS_ADDS = `${CS_MATH_NAMESPACE}.CalculatorTests.Adds_Two_Numbers`;
export const CS_MULTIPLIES = `${CS_MATH_NAMESPACE}.CalculatorTests.Multiplies_Two_Numbers`;
export const CS_FAILS = `${CS_MATH_NAMESPACE}.CalculatorTests.Fails_On_Purpose`;
export const CS_SKIPPED = `${CS_MATH_NAMESPACE}.CalculatorTests.Skipped_Test`;
export const CS_ROWS = `${CS_MATH_NAMESPACE}.CalculatorTests.Adds_Rows`;
export const CS_TEXT = `${CS_TEXT_NAMESPACE}.TextTests.Joins_Two_Words`;

/** The whole C# tree, as discovery must report it. */
export const CS_ALL: readonly string[] = [
  CS_ADDS,
  CS_MULTIPLIES,
  CS_FAILS,
  CS_SKIPPED,
  CS_ROWS,
  CS_TEXT,
];

/**
 * The C# fixture, ANCHORED.
 *
 * Multi-line bodies rather than expression-bodied one-liners: a breakpoint needs
 * a statement to bind to. Two namespaces and two classes, so "debug the class",
 * "debug the namespace" and "debug the assembly" are three different selections
 * rather than three names for the same one.
 */
export const CS_SOURCE = new AnchoredSource(
  `
using Xunit;

namespace DebugTestTarget.Math
{
    public class CalculatorTests
    {
        private static int Add(int left, int right)
        {
            var sum = left + right;                                    // @anchor:add-body
            return sum;                                                // @anchor:add-return
        }

        [Fact]
        public void Adds_Two_Numbers()
        {
            var seed = 20;                                             // @anchor:adds-seed
            var result = Add(seed, 22);                                // @anchor:adds-call
            Assert.Equal(42, result);                                  // @anchor:adds-assert
        }

        [Fact]
        public void Multiplies_Two_Numbers()
        {
            var factor = 6;                                            // @anchor:multiplies-seed
            var product = factor * 7;                                  // @anchor:multiplies-call
            Assert.Equal(42, product);                                 // @anchor:multiplies-assert
        }

        [Fact]
        public void Fails_On_Purpose()
        {
            var wrong = Add(1, 2);                                     // @anchor:fails-seed
            Assert.Equal(4, wrong);                                    // @anchor:fails-assert
        }

        [Fact(Skip = "fixture: deliberately skipped")]
        public void Skipped_Test()
        {
            var never = 1;                                             // @anchor:skipped-body
            Assert.Equal(1, never);
        }

        [Theory]
        [InlineData(1, 2, 3)]
        [InlineData(10, 20, 30)]
        public void Adds_Rows(int left, int right, int expected)
        {
            var sum = Add(left, right);                                // @anchor:rows-body
            Assert.Equal(expected, sum);                               // @anchor:rows-assert
        }
    }
}

namespace DebugTestTarget.Text
{
    public class TextTests
    {
        [Fact]
        public void Joins_Two_Words()
        {
            var greeting = "hello";                                    // @anchor:text-seed
            var joined = greeting + " world";                          // @anchor:text-join
            Assert.Equal("hello world", joined);                       // @anchor:text-assert
        }
    }
}
`
    .trim()
    .split('\n'),
);

/** The F# project the F# debug suite builds. F# is not the afterthought here. */
export const FS_PROJECT = 'DebugTestTargetFs';

/** The F# module every binding below is declared in. */
export const FS_MODULE = 'Fs.Debug.Fixtures';

/** An idiomatic backtick binding: its fully-qualified name contains SPACES. */
export const FS_SPACED = `${FS_MODULE}.adds two numbers with spaces`;

/** An F# `[<Theory>]`: one name, two rows. */
export const FS_ROWS = `${FS_MODULE}.adds rows`;

/** Every fully-qualified name the F# fixture exposes. */
export const FS_ALL: readonly string[] = [FS_SPACED, FS_ROWS];

/** The F# fixture, ANCHORED. */
export const FS_SOURCE = new AnchoredSource(
  `
module Fs.Debug.Fixtures

open Xunit

let private add left right =
    let sum = left + right                                             // @anchor:fs-add-body
    sum                                                                // @anchor:fs-add-return

[<Fact>]
let \`\`adds two numbers with spaces\`\` () =
    let seed = 20                                                      // @anchor:fs-seed
    let result = add seed 22                                           // @anchor:fs-call
    Assert.Equal(42, result)                                           // @anchor:fs-assert

[<Theory>]
[<InlineData(1, 2, 3)>]
[<InlineData(10, 20, 30)>]
let \`\`adds rows\`\` (left: int) (right: int) (expected: int) =
    let sum = add left right                                           // @anchor:fs-rows-body
    Assert.Equal(expected, sum)                                        // @anchor:fs-rows-assert
`
    .trim()
    .split('\n'),
);

/** A built fixture solution and the single source file its tests live in. */
export interface TestDebugFixture {
  readonly scratchDir: string;
  readonly sourceFile: string;
  readonly sourceUri: vscode.Uri;
  readonly solutionPath: string;
}

/** What language a fixture is written in. Drives the project and file names. */
export type FixtureLanguage = 'csharp' | 'fsharp';

/**
 * Write and solution-ify one fixture project under a fresh scratch directory.
 *
 * Inside the WORKSPACE root, not the OS temp dir: a debug session is bound to a
 * workspace folder, and a debuggee outside every folder is refused before the
 * adapter is ever consulted.
 */
export async function writeDebugTestFixture(
  prefix: string,
  language: FixtureLanguage,
): Promise<TestDebugFixture> {
  const scratchDir = fs.mkdtempSync(path.join(requireWorkspaceRoot(), prefix));
  isolateFromRepoMsbuild(scratchDir);
  const csharp = language === 'csharp';
  const project = csharp ? CS_PROJECT : FS_PROJECT;
  const sourceName = csharp ? 'CalculatorTests.cs' : 'Tests.fs';
  const projectDir = path.join(scratchDir, project);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${project}.${csharp ? 'csproj' : 'fsproj'}`),
    csharp ? projectXml(XUNIT_PACKAGES) : projectXml(XUNIT_PACKAGES, sourceName),
    'utf8',
  );
  const sourceFile = path.join(projectDir, sourceName);
  fs.writeFileSync(sourceFile, (csharp ? CS_SOURCE : FS_SOURCE).text, 'utf8');
  const solutionPath = await createSolution(scratchDir, `${project}Sln`, [projectDir]);
  // BUILT HERE, not by whichever test happens to run first. Discovery and every
  // debug run shell out to `dotnet test`, which RESTORES and COMPILES on its
  // first invocation in a fresh scratch directory — for F# that is FSharp.Core
  // plus a cold compiler start, well past the per-test DEBUG_TEST_MS budget on a
  // CI runner. The first test then timed out mid-build and every later one timed
  // out queued behind it, so a whole suite failed for a cost that is not the
  // thing under test. `suiteSetup` owns FIXTURE_BUILD_MS; this is what it is for.
  await dotnet(['build', solutionPath, '-c', 'Debug'], scratchDir);
  return {
    scratchDir,
    sourceFile,
    sourceUri: vscode.Uri.file(sourceFile),
    solutionPath,
  };
}

/** A `SourceBreakpoint` on an anchored line of a fixture source. */
export function breakpointAt(
  source: AnchoredSource,
  uri: vscode.Uri,
  anchor: string,
): vscode.SourceBreakpoint {
  return new vscode.SourceBreakpoint(new vscode.Location(uri, source.position(anchor)));
}

/** A breakpoint the user armed and then TURNED OFF in the Breakpoints view. */
export function disabledBreakpointAt(
  source: AnchoredSource,
  uri: vscode.Uri,
  anchor: string,
): vscode.SourceBreakpoint {
  return new vscode.SourceBreakpoint(
    new vscode.Location(uri, source.position(anchor)),
    /* enabled */ false,
  );
}

/** A breakpoint that only stops when `condition` holds — a row selector. */
export function conditionalBreakpointAt(
  source: AnchoredSource,
  uri: vscode.Uri,
  anchor: string,
  condition: string,
): vscode.SourceBreakpoint {
  return new vscode.SourceBreakpoint(
    new vscode.Location(uri, source.position(anchor)),
    true,
    condition,
  );
}

/** Assert a debug session was started for the test run, and hand it back. */
export function requireDebugSession(sessions: DebugSessionRecorder): ObservedSession {
  assert.ok(
    sessions.ours.length > 0,
    '[DEBUG-FEATURES-TESTS] makes "Debug individual test" a P1 row: the Debug run profile must ' +
      'start a real `sharplsp-coreclr` session. Running the test WITHOUT a debugger attached ' +
      'is the silent degradation this row exists to prevent — the run goes green, the ' +
      'breakpoints never bind, and the user concludes their code is unreachable',
  );
  return requireAt(sessions.ours, 0, 'the debug session the test run started');
}

/** The live session, asserted still attached at a stop. */
export function requireActive(why: string): vscode.DebugSession {
  const active = vscode.debug.activeDebugSession;
  assert.ok(active, `${why}: the debug session must still be live at the stop`);
  return active;
}

/**
 * Assert the ONE session a debug run must produce, and what it must carry.
 *
 * [TEST-RUN-TRX] makes a run one `dotnet test` invocation for the whole
 * selection, so a selection of any size is one debug session; and
 * [DEBUG-FEATURES-TESTS] pins Just My Code on for it, without which stepping out
 * of a test lands the user inside the xUnit runner.
 */
export function assertOneTestSession(sessions: DebugSessionRecorder, why: string): ObservedSession {
  const session = requireDebugSession(sessions);
  eq(
    sessions.ours.length,
    1,
    `${why}: ONE selection is ONE session; started ${String(sessions.ours.length)}`,
  );
  eq(session.type, DEBUG_TYPE_ID, `${why}: the SharpLsp adapter must be the one that attached`);
  eq(session.configuration['type'], DEBUG_TYPE_ID, `${why}: and the configuration must say so`);
  eq(session.configuration['justMyCode'], true, `${why}: Just My Code is a P1 row in test context`);
  assert.ok(session.name.trim() !== '', `${why}: the CALL STACK view needs a session name`);
  return session;
}

/**
 * Assert the DAP launch handshake that has to precede any stop.
 *
 * A breakpoint the workbench sent AFTER `configurationDone` races the debuggee,
 * and a session that never sent `configurationDone` leaves the adapter waiting
 * for configuration it will never receive — both present as "the breakpoint did
 * nothing", the report [DEBUG-FEATURES-TESTS] exists to make impossible.
 */
export function assertHandshakeOrder(recorder: DapRecorder, why: string): void {
  const order = recorder.requestOrder();
  eq(order[0], 'initialize', `${why}: the DAP conversation opens with initialize (${order[0]})`);
  eq(
    order.includes('configurationDone'),
    true,
    `${why}: the workbench must finish configuration; observed ${order.join(' -> ')}`,
  );
  eq(
    order.indexOf('setBreakpoints') < order.indexOf('configurationDone'),
    true,
    `${why}: breakpoints are configured BEFORE configurationDone; observed ${order.join(' -> ')}`,
  );
  eq(recorder.events('initialized').length, 1, `${why}: 'initialized' is announced exactly once`);
  deepEq(recorder.errors, [], `${why}: a conforming session produces no adapter transport error`);
}
