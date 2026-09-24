// A selection too big for ONE Microsoft.Testing.Platform invocation, and a run
// whose extension is missing — the two ways one module's run can be only
// PARTLY answered, end to end.
//
// A module's uids are split into batches that each fit the Windows command
// line. NUnit's bridge REFUSES any batch holding a uid with a space and
// parentheses — every idiomatic F# `[<TestCase>]` — and the unfiltered retry
// is what recovers those tests. When the refused uid sits in a LATER batch
// than one that succeeded, the success must not hide the refusal: the retry is
// still owed, or every test of the refused batch shows as a phantom failure.
//
// So the fixture is ONE F# NUnit module with enough long-named tests to fill a
// whole batch, plus one spaced `[<TestCase>]`, and no coverage extension.
//
// Covers [TEST-MTP-RUN].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { findCoberturaFiles } from '../../test-coverage.js';
import { statusLensTitle } from '../../test-lens.js';
import type { MtpModuleRun } from '../../test-listing-model.js';
import { listMtpTests } from '../../test-mtp-discovery.js';
import { runArgs, runMtpTests, trxNameFor, uidBatches, uidsFor } from '../../test-mtp-run.js';
import { COVERAGE_DIR } from '../../test-reporting.js';
import {
  createSolution,
  mtpProjectXml,
  MTP_NUNIT_PACKAGES,
  writeMtpGlobalJson,
  writeProject,
} from './dotnet-project-kit';
import {
  discoverSolution,
  rootsOf,
  runViaProfile,
  teardownFixtureSolution,
  activateWithScratch,
} from './test-explorer-kit';
import { assertPassed, cachedFor, itemsFor } from './test-explorer-outcome-assertions';
import { removeDirRecursive, assertContainsAll } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

const PROJECT = 'BatchMtpFs';
const MODULE = 'Fs.BatchMtp.Fixtures';

/** Enough long uids to overflow one batch several thousand characters over. */
const LONG_TEST_COUNT = 150;

/** The one uid NUnit refuses: a SPACE and parentheses, from `[<TestCase>]`. */
const SPACED = `${MODULE}.adds case`;
const SPACED_UID = `${MODULE}.adds case(2,2,4)`;

/** The name of long test `index`: ~190 characters, and no space in it. */
function longName(index: number): string {
  return `Long_${String(index).padStart(3, '0')}_${'x'.repeat(180)}`;
}

/** Every long test's id, in declaration order. */
const LONG_IDS = Array.from(
  { length: LONG_TEST_COUNT },
  (_, index) => `${MODULE}.${longName(index)}`,
);

/** Every id the module exposes. */
const EXPECTED = [...LONG_IDS, SPACED];

/** The F# module: the long passing tests, then the spaced data-driven one. */
function batchSource(): string {
  const longTests = Array.from({ length: LONG_TEST_COUNT }, (_, index) => [
    '[<Test>]',
    `let ${longName(index)} () = Assert.That(1 + 2, Is.EqualTo(3))`,
    '',
  ]).flat();
  return [
    `module ${MODULE}`,
    '',
    'open NUnit.Framework',
    '',
    ...longTests,
    '[<TestCase(2, 2, 4)>]',
    'let ``adds case`` (a: int) (b: int) (expected: int) = Assert.That(a + b, Is.EqualTo(expected))',
    '',
  ].join('\n');
}

/** The plan's one module, asserted present. */
async function batchModule(sln: string, root: string): Promise<MtpModuleRun> {
  const listing = await listMtpTests(sln, root);
  const module = listing.mtp?.modules.find((candidate) => candidate.modulePath.includes(PROJECT));
  assert.ok(module, `the ${PROJECT} module must be in the run plan`);
  return module;
}

suite('Test Explorer e2e — Microsoft.Testing.Platform selections past one invocation', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    ({ api, root } = await activateWithScratch('sharplsp-mtp-batches-'));
    writeMtpGlobalJson(root);
    const dir = writeProject(
      path.join(root, PROJECT),
      `${PROJECT}.fsproj`,
      mtpProjectXml(MTP_NUNIT_PACKAGES, 'Tests.fs'),
      'Tests.fs',
      batchSource(),
    );
    slnPath = await createSolution(root, 'BatchMtp', [dir]);
    await discoverSolution(api, slnPath, EXPECTED);
  });

  teardown(async () => {
    await api.testController.whenIdle();
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('a refusal in a LATER batch is still retried, whatever an earlier batch reported', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const module = await batchModule(slnPath, root);

    // 1. The shape that hides the refusal: several batches, the refused uid in
    //    the LAST one only, after a batch the module will accept.
    const ids = [...LONG_IDS, SPACED];
    const batches = uidBatches(uidsFor(module, ids));
    assert.ok(
      batches.length >= 2,
      `the selection must span batches; got ${String(batches.length)}`,
    );
    assert.deepStrictEqual(
      batches.map((batch) => batch.includes(SPACED_UID)),
      batches.map((_, index) => index === batches.length - 1),
      'the spaced uid is in the last batch and no other',
    );
    // [TEST-MTP-DISCOVERY]: NUnit's uid is the decorated name, owned by its one id.
    assert.deepStrictEqual(module.uidsById.get(SPACED), [SPACED_UID], 'one row, one uid');
    // [TEST-MTP-RUN]: batching loses and reorders nothing …
    assert.deepStrictEqual(batches.flat(), uidsFor(module, ids), 'every uid once, in order');
    // … every invocation stays under the Windows 32 767-character ceiling …
    const commandLines = batches.map((batch) =>
      ['dotnet', ...runArgs(module.modulePath, batch, root, {}, trxNameFor(PROJECT, 0))].join(' '),
    );
    const widest = Math.max(...commandLines.map((line) => line.length));
    assert.ok(widest < 32_767, `the widest command line is ${String(widest)} characters`);
    // … the uid is passed LITERALLY, never escaped …
    const last = runArgs(module.modulePath, batches.at(-1) ?? [], root, {}, 'x.trx');
    assert.ok(last.includes(SPACED_UID), 'the parentheses and comma reach NUnit as they are');
    // … and the deprecated `--no-progress` is never sent.
    assert.ok(!last.includes('--no-progress'), 'MTP 2.3 warns on every run that uses it');

    // 2. The run recovers EVERY test of the refused batch, with its real verdict.
    const outcome = await runMtpTests({ modules: [module] }, ids, root);
    assert.equal(outcome.retriedUnfiltered, true, 'the refused batch must earn the retry');
    const missing = ids.filter((id) => !outcome.results.has(id));
    assert.deepStrictEqual(
      missing.slice(0, 5),
      [],
      `${String(missing.length)} test(s) went unreported`,
    );
    assert.equal(outcome.results.get(SPACED)?.outcome, 'passed', 'the refused test really passes');
    assert.equal(outcome.failure, undefined, 'a recovered run reports no process-level failure');
    // The retry read every outcome by name out of the module's one report — the
    // module's own tests, and nothing but them.
    assert.deepStrictEqual(
      [...outcome.results.keys()].sort(),
      [...EXPECTED].sort(),
      'the unfiltered report answers for exactly the module',
    );

    // 3. ▶ on the module's root in the Testing view: every test comes back green.
    const [moduleRoot] = rootsOf(api.testController.items).filter((item) => item.label === PROJECT);
    assert.ok(moduleRoot, 'the module is a root of the tree');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [moduleRoot]);
    await api.testController.whenIdle();
    const notPassed = EXPECTED.filter((id) => cachedFor(api, id).outcome !== 'passed');
    assert.deepStrictEqual(
      notPassed.slice(0, 5).map((id) => `${id}: ${cachedFor(api, id).message ?? ''}`),
      [],
      `${String(notPassed.length)} test(s) did not pass`,
    );
  });

  test('Run with Coverage on a module without the coverage extension names the package', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    // `--coverage` is an EXTENSION, like `--report-trx`: a module that does not
    // reference Microsoft.Testing.Extensions.CodeCoverage exits with code 5 and
    // reports no test at all. The message must say what to add, exactly as the
    // TRX message does, or every test shows a result with no cause.
    const module = await batchModule(slnPath, root);
    // A test NUnit accepts, so the only thing wrong with the run is coverage.
    const plain = LONG_IDS[0] ?? '';

    // 1. The run itself names the package and the module.
    const outcome = await runMtpTests({ modules: [module] }, [plain], root, { coverage: true });
    const failure = outcome.failure ?? '';
    assert.match(failure, /Microsoft\.Testing\.Extensions\.CodeCoverage/, `got: ${failure}`);
    assert.ok(failure.includes(`${PROJECT}.dll`), `and names the module: ${failure}`);
    // [TEST-MTP-RUN]: the option it refused, and the exit code, reported as themselves …
    assertContainsAll(failure, ['--coverage', 'exit code 5'], 'failure');
    // … it ran NO test …
    assert.deepStrictEqual([...outcome.results.keys()], [], 'a refused command line runs nothing');
    // … and a REJECTED option earns no unfiltered retry: it would be rejected again.
    assert.equal(outcome.retriedUnfiltered, false, 'no retry for a missing extension');

    // 2. The Run with Coverage profile paints the same cause onto the test.
    const [item] = itemsFor(api, [plain]);
    assert.ok(item);
    const neighbour = LONG_IDS[1] ?? '';
    const neighbourBefore = api.testController.getResult(neighbour);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Coverage, [item]);
    await api.testController.whenIdle();
    const cached = cachedFor(api, plain);
    assert.equal(cached.outcome, 'notRun', `no test ran, so none passed: ${cached.message ?? ''}`);
    assert.match(cached.message ?? '', /Microsoft\.Testing\.Extensions\.CodeCoverage/);
    // [TEST-STATUS-LENS]: the lens says "Not run" with the cause, never "Failed".
    assert.equal(cached.passed, false, 'a test that never ran is not a pass');
    assert.equal(statusLensTitle(cached), `$(circle-slash) Not run: ${cached.message ?? ''}`);
    // [TEST-COVERAGE]: the results directory was emptied, and no report was invented.
    assert.deepStrictEqual(findCoberturaFiles(path.join(root, COVERAGE_DIR)), [], 'no coverage');
    // [TEST-MTP-RUN]: a test the selection did not touch is not run or re-cached.
    assert.equal(api.testController.getResult(neighbour), neighbourBefore, 'the neighbour stands');

    // 3. The plain Run profile is unaffected: the same test runs green.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, plain), plain);
  });
});
