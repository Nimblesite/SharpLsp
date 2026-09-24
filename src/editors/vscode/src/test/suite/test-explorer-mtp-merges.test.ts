// The pure rules that decide what a Microsoft.Testing.Platform run REPORTS,
// asserted at their own boundary rather than only through real modules.
//
//   • How two invocations merge. Two that answer for DIFFERENT tests — two
//     batches, two modules, two runners — keep every failure, because a failure
//     is the only account its tests get and the reason a refusal is retried.
//     Only the unfiltered retry, the same tests again, replaces a failure.
//   • Which runner gets which id, when one tree holds both.
//   • Which runners a sweep's listings call for.
//   • Where the Cobertura reports of a run are, at the depth each collector
//     writes them.
//   • Which projects a folder or a project file means, the way `dotnet`
//     resolves it — never by walking the folder.
//
// Covers [TEST-MTP-RUN], [TEST-MTP-ROUTING], [TEST-MTP-MODULES] and [TEST-COVERAGE].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestRunOutcome } from '../../test-execution.js';
import { findCoberturaFiles } from '../../test-coverage.js';
import type { MtpRunPlan, TestListing } from '../../test-listing-model.js';
import { projectsOf } from '../../test-mtp-modules.js';
import { mergeKeepingFailures, mergeOutcomes } from '../../test-mtp-run.js';
import { COVERAGE_DIR, freshCoverageDir } from '../../test-reporting.js';
import { runnersFor, splitByRunner, VSTEST_ONLY } from '../../test-run-routes.js';
import type { TestOutcome, TestRunSummary } from '../../test-run-output.js';
import type { TrxTestResult } from '../../test-trx.js';
import { removeDirRecursive, assertContainsAll } from './test-helpers';

/** One TRX result for `id`. */
function result(id: string, outcome: TestOutcome, durationMs = 5): TrxTestResult {
  return {
    fullyQualifiedName: id,
    displayName: id,
    outcome,
    durationMs,
    message: outcome === 'failed' ? `${id} failed` : undefined,
    stackTrace: undefined,
  };
}

/** One invocation's outcome: its results, and its failure if it had one. */
function outcome(
  results: readonly TrxTestResult[],
  failure?: string,
  retriedUnfiltered = false,
): TestRunOutcome {
  return {
    results: new Map(results.map((one) => [one.fullyQualifiedName, one])),
    summary: undefined,
    failure,
    runInfos: [],
    retriedUnfiltered,
    durationMs: 10,
    output: failure ?? '',
  };
}

/** A plan whose one module owns `ids`, built from `target`. */
function planOwning(...ids: readonly string[]): MtpRunPlan {
  return {
    modules: [
      {
        modulePath: '/repo/Mtp/bin/Mtp.dll',
        buildTarget: '/repo/Mtp',
        uidsById: new Map(ids.map((id) => [id, [`uid-${id}`]])),
      },
    ],
  };
}

/** A listing that named `names`, with an MTP plan when `mtp` is given. */
function listing(names: readonly string[], mtp?: MtpRunPlan): TestListing {
  return { names, ok: true, warnings: [], byAssembly: [], ...(mtp === undefined ? {} : { mtp }) };
}

suite('Test Explorer MTP — the merge, routing and resolution rules', () => {
  test('invocations for DIFFERENT tests keep every failure; the same tests again replace it', function () {
    const reported = outcome([result('A.one', 'passed')]);
    const refused = outcome([], 'Unexpected FQN in selection expression');

    // 1. A batch that reported nothing keeps its failure beside one that did —
    //    in either order — and the results of both survive.
    for (const merged of [
      mergeKeepingFailures(reported, refused),
      mergeKeepingFailures(refused, reported),
    ]) {
      assert.equal(merged.failure, 'Unexpected FQN in selection expression');
      assert.deepStrictEqual([...merged.results.keys()], ['A.one']);
      assert.equal(merged.durationMs, 20, 'the invocations ran one after the other');
    }

    // 2. Two failures are both kept, in order: each is some test's only account.
    const both = mergeKeepingFailures(outcome([], 'first'), outcome([], 'second'));
    assert.equal(both.failure, 'first\nsecond');

    // 3. The unfiltered retry reran the SAME tests: its results replace the
    //    refusal, and an id reported twice keeps its WORSE verdict.
    const retried = mergeOutcomes(
      outcome([result('A.one', 'passed')], 'refused'),
      outcome([result('A.one', 'failed'), result('A.two', 'passed')], undefined, true),
    );
    assert.equal(retried.failure, undefined, 'results clear the refusal');
    assert.equal(retried.results.get('A.one')?.outcome, 'failed', 'the worse verdict wins');
    assert.equal(retried.results.get('A.one')?.durationMs, 10, 'both rows ran, so both count');
    assert.equal(retried.retriedUnfiltered, true, 'and the retry is still on record');

    // 4. [TEST-MTP-RUN]: the two target frameworks of ONE project report the same
    //    id from two modules. One failing framework must not read as a pass.
    const net9 = outcome([result('A.one', 'passed')]);
    const net10 = outcome([result('A.one', 'failed')]);
    assert.equal(mergeKeepingFailures(net9, net10).results.get('A.one')?.outcome, 'failed');
    assert.equal(mergeKeepingFailures(net10, net9).results.get('A.one')?.outcome, 'failed');

    // 5. Counts are summed ACROSS modules, and the run is as bad as its worst one.
    const counted = (summary: TestRunSummary): TestRunOutcome => ({ ...outcome([]), summary });
    const summed = mergeKeepingFailures(
      counted({ outcome: 'passed', passed: 2, failed: 0, skipped: 1, total: 3 }),
      counted({ outcome: 'failed', passed: 1, failed: 1, skipped: 0, total: 2 }),
    ).summary;
    assert.deepStrictEqual(summed, {
      outcome: 'failed',
      passed: 3,
      failed: 1,
      skipped: 1,
      total: 5,
    });

    // 6. Two invocations that both answered carry no failure between them, and a
    //    retry on EITHER side stays on record.
    const clean = mergeKeepingFailures(
      reported,
      outcome([result('A.two', 'skipped')], undefined, true),
    );
    assert.equal(clean.failure, undefined, 'nothing failed, so nothing is reported as failing');
    assert.deepStrictEqual([...clean.results.keys()], ['A.one', 'A.two']);
    assert.equal(clean.retriedUnfiltered, true, 'the retry of either side is kept');
  });

  test('each id goes to the runner that discovered it, and only started runners run', function () {
    const plan = planOwning('Mtp.one', 'Mtp.two');

    // 1. One runner discovered: it gets EVERY id, owned or not.
    assert.deepStrictEqual(splitByRunner(VSTEST_ONLY, ['Mtp.one', 'Other']), [
      { runner: 'vstest', ids: ['Mtp.one', 'Other'] },
    ]);
    assert.deepStrictEqual(splitByRunner({ mtp: plan, vstest: false }, ['Unknown']), [
      { runner: 'mtp', plan, ids: ['Unknown'] },
    ]);

    // 2. Both discovered: the whole tree starts both, over everything.
    const mixed = { mtp: plan, vstest: true };
    assert.deepStrictEqual(splitByRunner(mixed, []), [
      { runner: 'vstest', ids: [] },
      { runner: 'mtp', plan, ids: [] },
    ]);

    // 3. A selection is split by ownership, VSTest first, and a runner left
    //    with no id is not started at all.
    assert.deepStrictEqual(splitByRunner(mixed, ['Vs.one', 'Mtp.two', 'Vs.two']), [
      { runner: 'vstest', ids: ['Vs.one', 'Vs.two'] },
      { runner: 'mtp', plan, ids: ['Mtp.two'] },
    ]);
    assert.deepStrictEqual(splitByRunner(mixed, ['Mtp.one']), [
      { runner: 'mtp', plan, ids: ['Mtp.one'] },
    ]);
    assert.deepStrictEqual(splitByRunner(mixed, ['Vs.one']), [
      { runner: 'vstest', ids: ['Vs.one'] },
    ]);

    // 4. [TEST-MTP-ROUTING] with one runner, the whole tree goes to that one alone.
    assert.deepStrictEqual(splitByRunner(VSTEST_ONLY, []), [{ runner: 'vstest', ids: [] }]);
    assert.deepStrictEqual(splitByRunner({ mtp: plan, vstest: false }, []), [
      { runner: 'mtp', plan, ids: [] },
    ]);

    // 5. With both, an id no module owns is a VSTest filter value, as it always was,
    //    and each half keeps the order the selection gave it.
    assert.deepStrictEqual(splitByRunner(mixed, ['Unknown']), [
      { runner: 'vstest', ids: ['Unknown'] },
    ]);
    assert.deepStrictEqual(splitByRunner(mixed, ['Mtp.two', 'Vs.b', 'Mtp.one', 'Vs.a']), [
      { runner: 'vstest', ids: ['Vs.b', 'Vs.a'] },
      { runner: 'mtp', plan, ids: ['Mtp.two', 'Mtp.one'] },
    ]);

    // 6. Ownership spans EVERY module of the plan, not just the first.
    const second = planOwning('Other.one').modules.map((module) => ({
      ...module,
      modulePath: '/repo/Other/bin/Other.dll',
    }));
    const twoModules = { mtp: { modules: [...plan.modules, ...second] }, vstest: true };
    const [call, ...none] = splitByRunner(twoModules, ['Other.one', 'Mtp.one']);
    assert.deepStrictEqual(none, [], 'owned ids start no VSTest run');
    assert.deepStrictEqual(call?.ids, ['Other.one', 'Mtp.one'], 'both modules own theirs');
  });

  test("a sweep's listings decide the runners: MTP where a plan came back, VSTest where names did", function () {
    const plan = planOwning('Mtp.one');

    // 1. Nothing MTP: VSTest runs everything, as before MTP existed.
    assert.deepStrictEqual(runnersFor([listing(['Vs.one'])]), { mtp: undefined, vstest: true });
    assert.deepStrictEqual(runnersFor([]), { mtp: undefined, vstest: true });

    // 2. Only MTP: VSTest is not started for anything.
    const onlyMtp = runnersFor([listing(['Mtp.one'], plan)]);
    assert.equal(onlyMtp.vstest, false);
    assert.deepStrictEqual(
      onlyMtp.mtp?.modules.map((module) => module.modulePath),
      ['/repo/Mtp/bin/Mtp.dll'],
    );

    // 3. A folder of each: both. A folder whose VSTest listing named NOTHING —
    //    it failed and became an error row — does not make VSTest a runner.
    assert.equal(runnersFor([listing(['Vs.one']), listing(['Mtp.one'], plan)]).vstest, true);
    assert.equal(runnersFor([listing([]), listing(['Mtp.one'], plan)]).vstest, false);

    // 4. [TEST-MTP-ROUTING] a sweep that named nothing at all still leaves VSTest
    //    where every id has always gone.
    assert.deepStrictEqual(runnersFor([listing([])]), { mtp: undefined, vstest: true });

    // 5. Two MTP folders: one plan holding EVERY module, each still owning its ids.
    const other = planOwning('Other.one').modules.map((module) => ({
      ...module,
      modulePath: '/repo/Other/bin/Other.dll',
      buildTarget: '/repo/Other',
    }));
    const merged = runnersFor([
      listing(['Mtp.one'], plan),
      listing(['Other.one'], { modules: other }),
    ]);
    assert.deepStrictEqual(
      merged.mtp?.modules.map((module) => module.modulePath),
      ['/repo/Mtp/bin/Mtp.dll', '/repo/Other/bin/Other.dll'],
    );
    assert.equal(merged.vstest, false, 'two MTP folders start no VSTest run');

    // 6. [TEST-MTP-RUN]: each module keeps the target it was discovered from — the
    //    build a run starts with — and the uids that run its ids.
    assert.deepStrictEqual(
      merged.mtp?.modules.map((module) => module.buildTarget),
      ['/repo/Mtp', '/repo/Other'],
    );
    assert.deepStrictEqual(merged.mtp?.modules[1]?.uidsById.get('Other.one'), ['uid-Other.one']);
  });

  test('Cobertura reports are read at the depth EACH collector writes them, and nowhere else', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-cobertura-'));
    try {
      // MTP writes `<guid>.cobertura.xml` into the results directory itself;
      // coverlet writes `coverage.cobertura.xml` one run-id folder down.
      const write = (relative: string): void => {
        fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
        fs.writeFileSync(path.join(dir, relative), '<coverage />', 'utf8');
      };
      write('3f2a.cobertura.xml');
      write(path.join('run-1', 'coverage.cobertura.xml'));
      write(path.join('run-2', 'other.xml'));
      write(path.join('deep', 'nested', 'coverage.cobertura.xml'));
      write('notes.txt');

      assert.deepStrictEqual(findCoberturaFiles(dir), [
        path.join(dir, '3f2a.cobertura.xml'),
        path.join(dir, 'run-1', 'coverage.cobertura.xml'),
      ]);
      assert.deepStrictEqual(findCoberturaFiles(path.join(dir, 'absent')), [], 'no dir, no report');

      // [TEST-COVERAGE]: EVERY report is read — a second module's MTP report and a
      // second project's coverlet folder alike — and only at those two depths.
      write('9b1c.cobertura.xml');
      write(path.join('run-3', 'coverage.cobertura.xml'));
      write(path.join('run-4', '5e6f.cobertura.xml'));
      const every = findCoberturaFiles(dir);
      assertContainsAll(
        every,
        [path.join(dir, '9b1c.cobertura.xml'), path.join(dir, 'run-3', 'coverage.cobertura.xml')],
        'the second',
      );
      assert.ok(
        !every.includes(path.join(dir, 'run-4', '5e6f.cobertura.xml')),
        'no MTP name below',
      );
      assert.deepStrictEqual(every, [...every].sort(), 'in one order, never directory order');

      // The coverage directory is emptied before a run, so no earlier report is read.
      const fresh = path.join(dir, COVERAGE_DIR);
      write(path.join(COVERAGE_DIR, 'stale.cobertura.xml'));
      assert.equal(freshCoverageDir(dir), fresh, `<solution folder>/${COVERAGE_DIR}`);
      assert.deepStrictEqual(findCoberturaFiles(fresh), [], 'the stale report is gone');
    } finally {
      removeDirRecursive(dir);
    }
  });

  test('a folder is the ONE project in it, and a project file is itself — never the neighbours', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-resolve-'));
    try {
      const touch = (relative: string): string => {
        const file = path.join(dir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '<Project />', 'utf8');
        return file;
      };
      // 1. One project directly in the folder: that project.
      const only = touch(path.join('one', 'One.csproj'));
      assert.deepStrictEqual(await projectsOf(path.join(dir, 'one'), 1_000), [only]);

      // 2. Two in the folder (MSB1011), or none but some below it (MSB1003):
      //    nothing — the folder is never walked.
      touch(path.join('two', 'A.csproj'));
      touch(path.join('two', 'B.fsproj'));
      assert.deepStrictEqual(await projectsOf(path.join(dir, 'two'), 1_000), []);
      touch(path.join('below', 'Sub', 'Sub.csproj'));
      assert.deepStrictEqual(await projectsOf(path.join(dir, 'below'), 1_000), []);

      // 3. A project file is itself, whatever sits beside or below it.
      const app = touch(path.join('app', 'App.fsproj'));
      touch(path.join('app', 'Tests', 'Tests.csproj'));
      assert.deepStrictEqual(await projectsOf(app, 1_000), [app]);

      // 4. [TEST-MTP-MODULES]: an F# project alone is that project, and files that
      //    are not a project or a solution never count against it.
      const fsharp = touch(path.join('fs', 'Lib.fsproj'));
      touch(path.join('fs', 'Directory.Build.props'));
      touch(path.join('fs', 'global.json'));
      touch(path.join('fs', 'README.md'));
      assert.deepStrictEqual(await projectsOf(path.join(dir, 'fs'), 1_000), [fsharp]);

      // 5. A project AND a solution in one folder are two: MSB1011, so nothing.
      touch(path.join('both', 'Both.csproj'));
      touch(path.join('both', 'Both.sln'));
      assert.deepStrictEqual(await projectsOf(path.join(dir, 'both'), 1_000), []);

      // 6. An empty folder is MSB1003: nothing. A project file beside another is
      //    still only itself.
      fs.mkdirSync(path.join(dir, 'empty'));
      assert.deepStrictEqual(await projectsOf(path.join(dir, 'empty'), 1_000), []);
      const lone = path.join(dir, 'two', 'B.fsproj');
      assert.deepStrictEqual(await projectsOf(lone, 1_000), [lone]);
      // A folder's ONE project is the one DIRECTLY in it, whatever sits below.
      assert.deepStrictEqual(await projectsOf(path.join(dir, 'app'), 1_000), [app]);
    } finally {
      removeDirRecursive(dir);
    }
  });
});
