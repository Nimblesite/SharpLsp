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

/** Press ▶ on `ids` (the whole tree when empty) and return the ONE run it wrote. */
async function press(
  api: SharpLspExtensionApi,
  observer: RunObserver,
  ids: readonly string[],
): Promise<RunRecord> {
  const before = observer.runs.length;
  const items = ids.length === 0 ? [] : itemsFor(api, ids);
  await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
  assert.equal(observer.runs.length, before + 1, 'one ▶ creates exactly one run');
  const record = observer.runs[before];
  assert.ok(record, 'the run ▶ created must be recorded');
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

/** One runner's suite: its projects built and discovered once, then ▶ twice. */
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

    test('▶ on a selection shows the selected tests their output, and no other test', async function () {
      this.timeout(FIXTURE_BUILD_MS);
      assert.ok(observer);
      await assertSelection(api, observer, fixtures);
    });
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
