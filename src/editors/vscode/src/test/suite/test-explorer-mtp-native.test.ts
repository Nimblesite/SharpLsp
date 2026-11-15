// Issue #581, end to end: an MTP project with NO `global.json` opt-in and NO
// runner switch is discovered and run through its own module — never the VSTest
// target the .NET 10 SDK refuses for it.
//
// `xunit.v3` 4.0.1+ ships its own runner console for exactly this shape, so the
// fixtures in `test-explorer-mtp-native-fixtures.ts` speak NEITHER of MTP's own
// options nor of VSTest's. Before the fix, discovery ran `dotnet test
// --list-tests`, the SDK answered "Testing with VSTest target is no longer
// supported", the module's own listing was never asked for, and the tree showed
// nothing but the failure row. The tests here press the REAL profiles against
// REAL projects the `dotnet` CLI built, F# FIRST (project rule), with the C#
// project reproducing the issue's exact package set.
//
// Covers [TEST-MTP-DETECT], [TEST-MTP-DISCOVERY] and [TEST-MTP-RUN].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { listTests } from '../../test-discovery.js';
import { usesMtpRunner } from '../../test-mtp.js';
import { writeMtpGlobalJson } from './dotnet-project-kit';
import {
  createNativeSolution,
  nativeIdsOf,
  NATIVE_FIXTURES,
  type NativeFixture,
} from './test-explorer-mtp-native-fixtures';
import {
  activateWithScratch,
  collectLeafIds,
  discoverSolution,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { cachedFor, runIds } from './test-explorer-outcome-assertions';
import { observeRuns, RUN_OUTPUT, runShows } from './test-output-kit';
import { removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS } from './test-timeouts';

/** What the .NET 10 SDK says when the VSTest target runs for an MTP project. */
const VSTEST_REFUSAL = 'no longer supported';

/** The F# fixture, F# first everywhere. */
const FS = NATIVE_FIXTURES.find((fixture) => fixture.language === 'fsharp');
/** The C# fixture: the issue's exact package set. */
const CS = NATIVE_FIXTURES.find((fixture) => fixture.language === 'csharp');

/** One fixture against the real profiles; `optIn` writes the SDK switch. */
async function scenario(fixture: NativeFixture, optIn: boolean): Promise<void> {
  const { api, root } = await activateWithScratch('slsp-mtp-native-');
  try {
    if (optIn) writeMtpGlobalJson(root);
    assert.equal(usesMtpRunner(root), optIn, 'the fixture opts in exactly through the SDK switch');
    const solution = await createNativeSolution(root, [fixture]);
    await discoverSolution(api, solution, nativeIdsOf(fixture));

    // 1. Discovery listed every id — the F# backtick names with SPACES included.
    const ids = collectLeafIds(api.testController.items);
    for (const id of nativeIdsOf(fixture))
      assert.ok(ids.includes(id), `the tree must carry ${id}; it carries ${ids.join(', ')}`);

    // 2. The VSTest target never ran: its refusal is neither a warning nor an
    //    error row, because the package graph named the project MTP first.
    const listing = await listTests(solution);
    assert.equal(listing.ok, true, `discovery must succeed: ${listing.warnings.join(' | ')}`);
    for (const id of nativeIdsOf(fixture))
      assert.ok(listing.names.includes(id), `the listing must report ${id}`);
    for (const warning of listing.warnings)
      assert.ok(
        !warning.includes(VSTEST_REFUSAL),
        `the VSTest refusal must not appear: ${warning}`,
      );

    // 3. One Run of the whole fixture reports every outcome, the data-driven
    //    id judged by its worst row, and the module's own assertion text kept.
    await runIds(api, vscode.TestRunProfileKind.Run, nativeIdsOf(fixture));
    await api.testController.whenIdle();
    assert.equal(cachedFor(api, fixture.passing).outcome, 'passed');
    assert.equal(cachedFor(api, fixture.failing).outcome, 'failed');
    assert.ok(
      cachedFor(api, fixture.failing).message?.includes(fixture.failureText),
      `the failure keeps its own text: ${cachedFor(api, fixture.failing).message ?? '(none)'}`,
    );
    assert.equal(cachedFor(api, fixture.skipped).outcome, 'skipped');
    assert.equal(cachedFor(api, fixture.mixedParameterized).outcome, 'failed');

    // 4. The plan names the module that owns the ids, so a single ▶ runs
    //    exactly its selection through the module's own command.
    assert.ok(listing.mtp !== undefined, 'the plan names the module that owns the ids');
    assert.equal(
      listing.mtp?.modules.every((module) => module.uidsById.has(fixture.passing)),
      true,
      'the module owns the selected id',
    );
    await runIds(api, vscode.TestRunProfileKind.Run, [fixture.passing]);
    await api.testController.whenIdle();
    assert.equal(cachedFor(api, fixture.passing).outcome, 'passed', 'a single run reruns its test');
  } finally {
    await teardownFixtureSolution(api, root, removeDirRecursive);
  }
}

/** Assert a helper resolved, so a kit typo fails loudly instead of skipping. */
function required<T>(value: T | undefined, what: string): T {
  assert.ok(value, `no ${what} fixture`);
  return value;
}

suite('Test Explorer e2e — xunit.v3 native MTP console (#581)', () => {
  test('the F# project with no opt-in discovers and runs through its module', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await scenario(required(FS, 'F#'), false);
  });

  test('the C# repro project (Test SDK + VSTest adapter) discovers and runs too', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await scenario(required(CS, 'C#'), false);
  });

  test('the global.json opt-in changes nothing for a native module', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await scenario(required(FS, 'F#'), true);
  });

  test("a native run's own output reaches Test Results", async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const fixture = required(FS, 'F#');
    const { api, root } = await activateWithScratch('slsp-mtp-native-out-');
    try {
      const solution = await createNativeSolution(root, [fixture]);
      await discoverSolution(api, solution, nativeIdsOf(fixture));
      const observer = observeRuns(api.testController.testing);
      try {
        await runIds(api, vscode.TestRunProfileKind.Run, [fixture.failing]);
        await api.testController.whenIdle();
        const record = observer.runs.at(-1);
        assert.ok(record, 'the profile created a run');
        await record.ended;
        assert.equal(record.verdicts.get(fixture.failing), 'failed');
        assert.ok(runShows(record, 'Finished:'), 'the module console is the run output');
        assert.ok((record.output.get(RUN_OUTPUT) ?? '') !== '', 'the run carried output');
      } finally {
        observer.dispose();
      }
    } finally {
      await teardownFixtureSolution(api, root, removeDirRecursive);
    }
  });

  test('the Coverage profile still runs a native module', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const fixture = required(FS, 'F#');
    const { api, root } = await activateWithScratch('slsp-mtp-native-cov-');
    try {
      const solution = await createNativeSolution(root, [fixture]);
      await discoverSolution(api, solution, nativeIdsOf(fixture));
      await runIds(api, vscode.TestRunProfileKind.Coverage, [fixture.passing]);
      await api.testController.whenIdle();
      assert.equal(cachedFor(api, fixture.passing).outcome, 'passed');
    } finally {
      await teardownFixtureSolution(api, root, removeDirRecursive);
    }
  });
});
