// Running Microsoft.Testing.Platform tests, end to end, inside the real
// extension host against six REAL projects the `dotnet` CLI built.
//
// Discovery is only half of issue #249: an MTP project also could not be RUN.
// `--filter FullyQualifiedName=` and `--logger trx` do not exist in MTP mode,
// so the whole outcome pipeline had nothing to read. The MTP path selects with
// `--filter-uid` and reports with `--report-trx`, and everything after the TRX
// file is shared with the VSTest path — which is exactly what these assertions
// prove: the same outcome mapping, the same worst-row merge, the same skip that
// is never a failure, and the same assertion text.
//
// F# comes FIRST throughout (project rule).
//
// Covers [TEST-MTP-RUN], and [TEST-RUN-TRX] through the shared reader.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { runMtpTests } from '../../test-mtp-run.js';
import { listMtpTests } from '../../test-mtp-discovery.js';
import {
  createSolution,
  mtpProjectXml,
  writeMtpGlobalJson,
  writeProject,
} from './dotnet-project-kit';
import {
  ALL_MTP_IDS,
  createMtpSolution,
  MTP_FIXTURES,
  mtpFixtureFor,
} from './test-explorer-mtp-fixtures';
import {
  activateTestExplorer,
  discoverSolution,
  runAlreadyCancelled,
  runViaProfile,
  teardownFixtureSolution,
} from './test-explorer-kit';
import {
  assertFailed,
  assertPassed,
  assertSkipped,
  cachedFor,
  itemsFor,
  sorted,
} from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** Every id that must come back green. */
const PASSING: readonly string[] = MTP_FIXTURES.flatMap((fixture) => [
  fixture.passing,
  fixture.parameterized,
]);
/** Every id that must come back red — the mixed theories included. */
const FAILING: readonly string[] = MTP_FIXTURES.flatMap((fixture) => [
  fixture.failing,
  ...(fixture.mixedParameterized === undefined ? [] : [fixture.mixedParameterized]),
]);
/** Every id that must come back skipped, and NEVER as a failure. */
const SKIPPED: readonly string[] = MTP_FIXTURES.map((fixture) => fixture.skipped);

/** An MTP project WITHOUT the TRX report extension — `--report-trx` fails on it. */
const NO_TRX_SOURCE = [
  'using Xunit;',
  '',
  'namespace Cs.NoTrxMtp.Fixtures',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact] public void Adds_TwoNumbers() => Assert.Equal(3, 1 + 2);',
  '    }',
  '}',
  '',
].join('\n');

suite('Test Explorer e2e — Microsoft.Testing.Platform runs', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-run-'));
    slnPath = await createMtpSolution(root);
    await discoverSolution(api, slnPath, ALL_MTP_IDS);
  });

  teardown(async () => {
    await api.testController.whenIdle();
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('▶ on the whole tree attributes a pass, a fail and a skip to each test', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const items = itemsFor(api, [...PASSING, ...FAILING, ...SKIPPED]);

    // 1. Press ▶ on the whole selection, in ONE run.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items);
    await api.testController.whenIdle();

    // 2. Every pass and every skip is attributed on its own terms, six
    //    projects at once. A skip is NEVER a failure.
    for (const id of PASSING) assertPassed(cachedFor(api, id), id);
    for (const id of SKIPPED) assertSkipped(cachedFor(api, id), id);

    // 3. Every failure carries the text ITS OWN framework wrote — xUnit's
    //    `Assert.Equal() Failure`, MSTest's `Assertion failed. …`, NUnit's
    //    `Assert.That(…)` — never a generic "Test failed".
    for (const fixture of MTP_FIXTURES) {
      assertFailed(cachedFor(api, fixture.failing), fixture.failing, fixture.failureText);
      if (fixture.mixedParameterized === undefined) continue;
      assertFailed(
        cachedFor(api, fixture.mixedParameterized),
        fixture.mixedParameterized,
        fixture.failureText,
      );
    }
  });

  test('a data-driven test whose rows DISAGREE is judged by its worst row', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const csharp = mtpFixtureFor('xunit-csharp');
    const mixed = csharp.mixedParameterized;
    assert.ok(mixed, 'the C# xUnit fixture carries the disagreeing theory');
    const [item] = itemsFor(api, [mixed]);
    assert.ok(item, 'the theory must be one row in the tree');

    // 1. Both rows run under the one id, because the id owns both uids.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
    await api.testController.whenIdle();

    // 2. One row passes and one fails, and the merged outcome is the failure.
    const result = cachedFor(api, mixed);
    assert.equal(result.outcome, 'failed', 'a green theory whose second row failed is a lie');
    assert.equal(result.passed, false);
    assert.ok(result.message, "and it carries the failing row's assertion text");

    // 3. The all-passing theory of the same class stays green.
    const [allGreen] = itemsFor(api, [csharp.parameterized]);
    assert.ok(allGreen);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [allGreen]);
    await api.testController.whenIdle();
    assert.equal(cachedFor(api, csharp.parameterized).outcome, 'passed');
  });

  test('▶ on one test runs that test and no other, across every module', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const fsharp = mtpFixtureFor('xunit-fsharp');

    // 1. Run ONE F# backtick test whose id carries spaces.
    const [only] = itemsFor(api, [fsharp.passing]);
    assert.ok(only);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [only]);
    await api.testController.whenIdle();

    const result = cachedFor(api, fsharp.passing);
    assert.equal(result.outcome, 'passed', 'a uid carrying spaces in its display name still runs');
    assert.equal(result.passed, true);
    assert.equal(typeof result.duration, 'number');

    // 2. A module the selection does not touch must not be started, so the run
    //    is a single invocation rather than six.
    const listing = await listMtpTests(slnPath, root);
    assert.ok(listing.mtp);
    const outcome = await runMtpTests(listing.mtp, [fsharp.passing], root);
    assert.deepStrictEqual(
      sorted([...outcome.results.keys()]),
      [fsharp.passing],
      'exactly the selected test reported a result',
    );
    assert.equal(outcome.failure, undefined, 'a good run reports no process-level failure');
  });

  test('a class row runs its members, and an NUnit uid is never escaped', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const nunit = mtpFixtureFor('nunit-csharp');
    const [parameterized] = itemsFor(api, [nunit.parameterized]);
    assert.ok(parameterized?.parent, 'the NUnit case sits under its class row');

    // 1. Press ▶ on the CLASS row, which expands to its members.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [parameterized.parent]);
    await api.testController.whenIdle();

    // 2. Its uid is `Ns.Class.Adds_Case(2,2,4)` — parentheses and commas, passed
    //    literally. Escaping them the way a VSTest filter needs would match
    //    nothing and report "No result reported" instead.
    const cased = cachedFor(api, nunit.parameterized);
    assert.equal(cased.outcome, 'passed', 'a decorated uid must match its own test');
    assert.equal(cachedFor(api, nunit.passing).outcome, 'passed');
    assert.equal(cachedFor(api, nunit.failing).outcome, 'failed');
    assert.equal(cachedFor(api, nunit.skipped).outcome, 'skipped', 'a skip is never a failure');
  });

  test('⏹ stops the run, and an already-cancelled token starts nothing', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const items = itemsFor(api, [...PASSING]);
    const before = api.testController.items.size;

    // 1. Press ⏹ shortly after ▶: the run resolves rather than rejecting.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, items, 200);
    await api.testController.whenIdle();
    assert.equal(api.testController.items.size, before, 'the tree stands after a cancelled run');

    // 2. A token already cancelled when the handler is entered starts nothing.
    await runAlreadyCancelled(api.testController, vscode.TestRunProfileKind.Run, items);
    await api.testController.whenIdle();
    assert.equal(api.testController.items.size, before, 'and still stands');

    // 3. The queue drained, so the next run is not poisoned.
    const [one] = itemsFor(api, [mtpFixtureFor('xunit-fsharp').passing]);
    assert.ok(one);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [one]);
    await api.testController.whenIdle();
    assert.equal(cachedFor(api, mtpFixtureFor('xunit-fsharp').passing).outcome, 'passed');
  });

  test('an F# [<TestCase>] NUnit selection recovers from the adapter refusing it', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    // NUnit's bridge translates `--filter-uid` back into a VSTest filter
    // EXPRESSION and then rejects its own translation for any uid carrying a
    // SPACE — which is every idiomatic F# backtick binding. Without the
    // unfiltered retry the whole module reports nothing and four perfectly
    // runnable tests show as phantom failures.
    const fsharp = mtpFixtureFor('nunit-fsharp');
    const listing = await listMtpTests(slnPath, root);
    assert.ok(listing.mtp);
    const module = listing.mtp.modules.find((candidate) =>
      candidate.modulePath.includes(fsharp.projectName),
    );
    assert.ok(module, `the ${fsharp.projectName} module must be in the run plan`);
    assert.deepStrictEqual(
      module.uidsById.get(fsharp.parameterized),
      ['Fs.NunitMtp.Fixtures.adds case(2,2,4)'],
      'the uid really does carry a space AND parentheses',
    );

    // 1. Running the refused selection still reports every test.
    const ids = [...module.uidsById.keys()];
    const outcome = await runMtpTests({ modules: [module] }, ids, root);
    assert.equal(outcome.retriedUnfiltered, true, 'the refusal must trigger ONE unfiltered retry');
    assert.deepStrictEqual(
      sorted([...outcome.results.keys()]),
      sorted(ids),
      'every selected test reports an outcome after the retry',
    );
    assert.equal(outcome.failure, undefined, 'a recovered run reports no process-level failure');

    // 2. The recovered outcomes are the real ones, not a blanket verdict.
    assert.equal(outcome.results.get(fsharp.passing)?.outcome, 'passed');
    assert.equal(outcome.results.get(fsharp.failing)?.outcome, 'failed');
    assert.equal(outcome.results.get(fsharp.skipped)?.outcome, 'skipped');
    assert.equal(outcome.results.get(fsharp.parameterized)?.outcome, 'passed');

    // 3. The SAME framework in C# has no space in its uids, so it is accepted
    //    and never retried — the recovery is the adapter's say-so, not a habit.
    const csharp = mtpFixtureFor('nunit-csharp');
    const csModule = listing.mtp.modules.find((candidate) =>
      candidate.modulePath.includes(csharp.projectName),
    );
    assert.ok(csModule);
    const plain = await runMtpTests({ modules: [csModule] }, [csharp.passing], root);
    assert.equal(plain.retriedUnfiltered, false, 'an accepted selection needs no recovery');
    assert.deepStrictEqual(
      [...plain.results.keys()],
      [csharp.passing],
      'and only the selected test ran',
    );
  });

  test('a module without the TRX extension says which package to reference', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    // `--report-trx` is an EXTENSION, not part of MTP. A module that does not
    // register it exits with code 5. Reporting that as itself is the whole
    // point: silence would report every selected test as "No result reported"
    // and hide the cause.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-notrx-'));
    try {
      writeMtpGlobalJson(bare);
      const dir = writeProject(
        path.join(bare, 'NoTrxMtpCs'),
        'NoTrxMtpCs.csproj',
        mtpProjectXml([{ id: 'xunit.v3', version: '4.0.0' }]),
        'Tests.cs',
        NO_TRX_SOURCE,
      );
      const sln = await createSolution(bare, 'NoTrx', [dir]);

      // 1. Discovery still works: `--list-tests json` needs no extension.
      const listing = await listMtpTests(sln, bare);
      assert.deepStrictEqual(
        [...listing.names],
        ['Cs.NoTrxMtp.Fixtures.CalculatorTests.Adds_TwoNumbers'],
        `the test must be discovered; warnings: ${listing.warnings.join(' | ') || '(none)'}`,
      );
      assert.ok(listing.mtp, 'and a run plan must come back with it');

      // 2. The RUN cannot report per-test outcomes, and says exactly why.
      const outcome = await runMtpTests(listing.mtp, [...listing.names], bare);
      assert.equal(outcome.results.size, 0, 'no TRX means no per-test result');
      assert.ok(outcome.failure, 'and the run must not fail silently');
      assert.match(
        outcome.failure,
        /Microsoft\.Testing\.Extensions\.TrxReport/,
        `the message must name the missing package, got: ${outcome.failure}`,
      );
      assert.match(outcome.failure, /--report-trx/, 'and the option that was refused');
    } finally {
      removeDirRecursive(bare);
    }
  });
});
