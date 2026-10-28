// What a test WRITES is shown in Test Results, where its framework sends it
// ([TEST-RUN-OUTPUT]).
//
// The report every run reads carries each test's output, and the reader kept
// only the verdict and the assertion text: an `ITestOutputHelper` line, a
// `TestContext.WriteLine`, a captured `Console.WriteLine` — none of it was shown
// in Test Results, the Debug Console or any output channel. Nor was the runner's
// own console, where NUnit's `TestContext.Progress` and xUnit's diagnostic
// messages go.
//
// Both suites press the REAL ▶ over a real, built, discovered solution and
// watch the real run the profile writes into (see `test-output-kit.ts`): xUnit,
// NUnit and MSTest, F# and C#, every channel each framework captures
// (`test-output-fixtures.ts` holds the audit), on VSTest and on
// Microsoft.Testing.Platform — and through all three report shapes.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { createSolution, writeMtpGlobalJson } from './dotnet-project-kit';
import { useScratchSuite } from './test-explorer-harness';
import { discoverSolution, runViaProfile } from './test-explorer-kit';
import { itemsFor } from './test-explorer-outcome-assertions';
import {
  DEBUGGEE,
  FAILS,
  MTP_OUTPUT_FIXTURES,
  VSTEST_OUTPUT_FIXTURES,
  idsOf,
  markerOf,
  testIdOf,
  type OutputFixture,
} from './test-output-fixtures';
import {
  assertShownWhereSent,
  assertTerminalText,
  debuggeeOf,
  linesFor,
  observeRuns,
  runShows,
  testsShown,
  type RunObserver,
  type RunRecord,
} from './test-output-kit';
import { writeOutputProject } from './test-output-sources';
import { FIXTURE_BUILD_MS } from './test-timeouts';

/** The fixture for `tag`, which every suite here declares. */
function fixtureTagged(fixtures: readonly OutputFixture[], tag: string): OutputFixture {
  const fixture = fixtures.find((candidate) => candidate.tag === tag);
  assert.ok(fixture, `no output fixture tagged ${tag}`);
  return fixture;
}

/** Press ▶ (or `kind`) on `ids` (the whole tree when empty) and return the ONE run it wrote. */
async function press(
  api: SharpLspExtensionApi,
  observer: RunObserver,
  ids: readonly string[],
  kind: vscode.TestRunProfileKind = vscode.TestRunProfileKind.Run,
): Promise<RunRecord> {
  const before = observer.runs.length;
  const items = ids.length === 0 ? [] : itemsFor(api, ids);
  await runViaProfile(api.testController, kind, items);
  assert.equal(observer.runs.length, before + 1, 'one press creates exactly one run');
  const record = observer.runs[before];
  assert.ok(record, 'the run the press created must be recorded');
  await record.ended;
  return record;
}

/**
 * ▶ on two tests of different projects: the F# NUnit test that fails (its
 * spaced name is REFUSED by NUnit's filter, so the run is retried unfiltered and
 * every test of the module runs) and the C# MSTest test writing to stderr.
 * Only the two selected tests are shown output — the retry's others are not.
 */
async function assertSelection(
  api: SharpLspExtensionApi,
  observer: RunObserver,
  fixtures: readonly OutputFixture[],
): Promise<void> {
  const nunit = fixtureTagged(fixtures, `fs-nunit-${fixtures[0]?.runner ?? ''}`);
  const mstest = fixtureTagged(fixtures, `cs-mstest-${fixtures[0]?.runner ?? ''}`);
  const selected = [testIdOf(nunit, FAILS), testIdOf(mstest, 'console-error')];
  const record = await press(api, observer, selected);
  const attached = testsShown(record).sort();
  assert.deepEqual(attached, [...selected].sort(), 'only the selected tests are shown output');
  assert.ok(linesFor(record, selected[0] ?? '').includes(markerOf(nunit, FAILS)));
  assert.ok(linesFor(record, selected[1] ?? '').includes(markerOf(mstest, 'console-error')));
  assert.deepEqual([...record.verdicts.keys()].sort(), [...selected].sort());
  assert.equal(record.verdicts.get(selected[0] ?? ''), 'failed');
  assertTerminalText(record);
}

/** The pid of every debug session, in the order each started and each ended. */
interface SessionLog {
  readonly started: number[];
  readonly ended: number[];
  /** Settles once the session attached to `pid` has ended. */
  endOf(pid: number): Promise<void>;
  dispose(): void;
}

/** The process a test debug session is attached to. */
function pidOf(session: vscode.DebugSession): number {
  return Number(session.configuration.processId);
}

/** Settles once the session on `pid` has ended, which `ended` may already record. */
async function sessionEnded(ended: readonly number[], pid: number): Promise<void> {
  if (ended.includes(pid)) return;
  await new Promise<void>((resolve) => {
    const watch = vscode.debug.onDidTerminateDebugSession((session) => {
      if (pidOf(session) !== pid) return;
      watch.dispose();
      resolve();
    });
  });
}

/** Log every debug session from now until disposed. */
function logSessions(): SessionLog {
  const started: number[] = [];
  const ended: number[] = [];
  const watches = [
    vscode.debug.onDidStartDebugSession((session) => started.push(pidOf(session))),
    vscode.debug.onDidTerminateDebugSession((session) => ended.push(pidOf(session))),
  ];
  return {
    started,
    ended,
    endOf: async (pid) => {
      await sessionEnded(ended, pid);
    },
    dispose: () => {
      for (const watch of watches) watch.dispose();
    },
  };
}

/**
 * Debug on ONE test of every project, with nothing armed so it runs to its end.
 * The test is shown its own line and verdict, as ▶ shows them, and the line it
 * wrote proves a debugger was attached to the process that RAN it: the session
 * kept is the test host's. On MTP a module that reports TRX first starts a
 * controller that waits too; its session is released once the test host waits,
 * so it ends before the test host's ([TEST-MTP-DEBUG], [TEST-RUN-OUTPUT]).
 */
async function assertDebugged(
  api: SharpLspExtensionApi,
  observer: RunObserver,
  fixtures: readonly OutputFixture[],
): Promise<void> {
  for (const fixture of fixtures) {
    const id = testIdOf(fixture, DEBUGGEE);
    const sessions = logSessions();
    try {
      const record = await press(api, observer, [id], vscode.TestRunProfileKind.Debug);
      assert.equal(record.verdicts.get(id), 'passed', `${id} passes under the debugger`);
      assert.deepEqual(testsShown(record), [id], 'the debugged test alone is shown output');
      assertTerminalText(record);
      const { pid, attached } = debuggeeOf(record, fixture);
      assert.equal(attached, 'True', `a debugger is attached to the process that ran ${id}`);
      await sessions.endOf(pid);
      assertReleased(sessions, pid, id);
    } finally {
      sessions.dispose();
    }
  }
}

/** The session on the test host `pid` started, and every other one ended before it did. */
function assertReleased(sessions: SessionLog, pid: number, id: string): void {
  assert.ok(sessions.started.includes(pid), `a session is attached to the host that ran ${id}`);
  for (const other of sessions.started.filter((each) => each !== pid)) {
    const released = sessions.ended.indexOf(other);
    assert.ok(
      released !== -1 && released < sessions.ended.indexOf(pid),
      `pid ${String(other)} runs no test, so its session must end before the test host's`,
    );
  }
}

/** The gestures on a SELECTION every runner's suite presses, after ▶ on the whole tree. */
const SELECTIONS = [
  ['▶ on a selection shows the selected tests their output, and no other test', assertSelection],
  ['Debug shows each debugged test its output, as ▶ does', assertDebugged],
] as const;

/** One runner's suite: its projects built and discovered once, then ▶ twice and Debug once. */
function outputSuite(title: string, fixtures: readonly OutputFixture[], runSummary: string): void {
  suite(title, () => {
    let api: SharpLspExtensionApi;
    let observer: RunObserver | undefined;

    useScratchSuite(`sharplsp-output-${fixtures[0]?.runner ?? ''}-`, async (scratch) => {
      ({ api } = scratch);
      const dirs = fixtures.map((fixture) => writeOutputProject(scratch.root, fixture));
      if (fixtures[0]?.runner === 'mtp') writeMtpGlobalJson(scratch.root);
      const solution = await createSolution(scratch.root, 'OutputFixtures', dirs);
      await discoverSolution(api, solution, idsOf(fixtures));
    });

    setup(() => {
      observer = observeRuns(api.testController.testing);
    });

    teardown(() => {
      observer?.dispose();
    });

    test('▶ on the whole tree shows every channel where its framework sends it', async function () {
      this.timeout(FIXTURE_BUILD_MS);
      assert.ok(observer);
      const record = await press(api, observer, []);
      assertShownWhereSent(record, fixtures);
      assert.ok(
        runShows(record, runSummary),
        `the run's own output must carry the runner's console ("${runSummary}")`,
      );
    });

    for (const [title, check] of SELECTIONS) {
      test(title, async function () {
        this.timeout(FIXTURE_BUILD_MS);
        assert.ok(observer);
        await check(api, observer, fixtures);
      });
    }
  });
}

outputSuite(
  'Test Explorer: what a VSTest test writes, in Test Results [TEST-RUN-OUTPUT]',
  VSTEST_OUTPUT_FIXTURES,
  'Failed!',
);

outputSuite(
  'Test Explorer: what an MTP test writes, in Test Results [TEST-RUN-OUTPUT]',
  MTP_OUTPUT_FIXTURES,
  'Test run summary:',
);
