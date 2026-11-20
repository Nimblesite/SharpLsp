// The two F#-native test frameworks through the Test Explorer, end to end:
// REAL Expecto and FsCheck projects in one REAL solution, built by the real
// `dotnet` CLI and run through the extension's own controller. F# is a
// first-class citizen, and these are how a large share of F# code is tested.
//
//   • Expecto tests are VALUES — `testList "name" [ testCase "name" ... ]` — run
//     by YoloDev.Expecto.TestSdk; an id is the path of list names joined by
//     dots, spaces kept: no namespace, no class, no method.
//   • FsCheck properties are `[<Property>]` bindings run by FsCheck.Xunit; an id
//     is the module path plus a backtick name with spaces, and a failure is a
//     shrunk counterexample ("Falsifiable"), not an assertion message.
//
// Nothing about either shape may be specific to xUnit, NUnit or MSTest.
//
// Covers [TEST-DISCOVERY-FQN], [TEST-FILTER-ESCAPE] and [TEST-RUN-TRX] for
// "Expecto/FsCheck test debugging | P1 (F# parity)" of [DEBUG-FEATURES-TESTS].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { SharpLspExtensionApi } from '../../extension.js';
import type { CachedTestResult } from '../../testing.js';
import {
  XUNIT_PACKAGES,
  buildProjectXml,
  createSolution,
  warmDiscovery,
  writeProject,
} from './dotnet-project-kit';
import {
  EXPECTO_ALL,
  EXPECTO_FAILING,
  EXPECTO_FAILURE_MESSAGE,
  EXPECTO_NESTED,
  EXPECTO_PASSING,
  EXPECTO_PENDING,
  EXPECTO_PROJECT,
  writeExpectoProject,
} from './expecto-fixture';
import { assertLeafItem, collectLeafIds, discoverSolution, findItem } from './test-explorer-kit';
import { useScratchSuite } from './test-explorer-harness';
import { DOTNET_CLI_MS } from './test-timeouts';

/** FsCheck's xUnit integration, on the xUnit the other F# fixtures use. */
const FSCHECK_PACKAGES = [{ id: 'FsCheck.Xunit', version: '3.6.0' }, ...XUNIT_PACKAGES];
const FSCHECK_PROJECT = 'Fs.FsCheck';
const FSCHECK_MODULE = 'Fs.FsCheck.Properties';
const FSCHECK_HOLDS = `${FSCHECK_MODULE}.reversing twice is identity`;
const FSCHECK_FALSIFIED = `${FSCHECK_MODULE}.every list is empty on purpose`;
const FSCHECK_SKIPPED = `${FSCHECK_MODULE}.skipped property`;
const FSCHECK_ALL = [FSCHECK_HOLDS, FSCHECK_FALSIFIED, FSCHECK_SKIPPED];

const FSCHECK_SOURCE = [
  `module ${FSCHECK_MODULE}`,
  '',
  'open FsCheck.Xunit',
  '',
  '[<Property>]',
  'let ``reversing twice is identity`` (xs: int list) = List.rev (List.rev xs) = xs',
  '',
  '[<Property>]',
  'let ``every list is empty on purpose`` (xs: int list) = List.isEmpty xs',
  '',
  '[<Property(Skip = "fixture: deliberately skipped")>]',
  'let ``skipped property`` (x: int) = x = x',
  '',
].join('\n');

/** Every id the solution exposes, Expecto first. */
const ALL = [...EXPECTO_ALL, ...FSCHECK_ALL];

/** A result's outcome and message, for one assertion that names both. */
function described(result: CachedTestResult | undefined): string {
  return `${result?.outcome ?? 'no result'}: ${result?.message ?? 'no message'}`;
}

suite('Test Explorer e2e — Expecto and FsCheck (F#)', () => {
  let api: SharpLspExtensionApi;
  let expectoDir: string;
  let fscheckDir: string;
  let slnPath: string;

  /** Run `id` in `dir` and require `outcome`, naming the result on failure. */
  async function runExpecting(
    id: string,
    dir: string,
    outcome: CachedTestResult['outcome'],
  ): Promise<CachedTestResult> {
    const result = await api.testController.runSingle(id, dir);
    assert.strictEqual(result.outcome, outcome, `${id} — ${described(result)}`);
    assert.strictEqual(result.passed, outcome === 'passed', `${id}: passed matches the outcome`);
    return result;
  }

  useScratchSuite('sharplsp-fsharp-frameworks-', async (scratch) => {
    ({ api } = scratch);
    expectoDir = path.join(scratch.root, EXPECTO_PROJECT);
    writeExpectoProject(expectoDir);
    fscheckDir = path.join(scratch.root, FSCHECK_PROJECT);
    const fscheckXml = buildProjectXml({
      packages: FSCHECK_PACKAGES,
      compileIncludes: ['Properties.fs'],
    });
    writeProject(
      fscheckDir,
      `${FSCHECK_PROJECT}.fsproj`,
      fscheckXml,
      'Properties.fs',
      FSCHECK_SOURCE,
    );
    slnPath = await createSolution(scratch.root, 'FSharpFrameworks', [expectoDir, fscheckDir]);
    await warmDiscovery(slnPath, scratch.root);
  });

  test('discovery lists every Expecto case and FsCheck property by name, spaces and nesting intact', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ids = await discoverSolution(api, slnPath, ALL);
    await api.testController.whenIdle();
    for (const id of ALL) assert.ok(ids.includes(id), `${id} is discovered verbatim`);
    const leaves = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(
      [...leaves].sort(),
      [...ALL].sort(),
      'exactly the seven tests of the two projects, nothing invented and nothing lost',
    );
    for (const id of EXPECTO_ALL) assertLeafItem(api.testController.items, id, ['fsharp']);
    for (const id of ALL) {
      const item = findItem(api.testController.items, id);
      assert.ok(item, `${id} is in the tree`);
      assert.strictEqual(item.id, id, `${id} is its own id, verbatim`);
      assert.strictEqual(item.children.size, 0, `${id} is a runnable leaf`);
      assert.ok(item.label.length > 0, `${id} has a label to render`);
      // #604: the tag comes from the .fsproj that built the test, never from a
      // guess at its name — an Expecto list path names no framework at all.
      assert.deepStrictEqual(
        item.tags.map((tag) => tag.id),
        ['fsharp'],
        `${id} was built by an .fsproj, so it carries the fsharp tag and nothing else`,
      );
    }
    assert.ok(
      leaves.every((id) => !id.endsWith('.dll') && !id.includes(' -> ')),
      'no assembly path or VSTest chatter survives into the ids',
    );
    assert.ok(
      EXPECTO_ALL.every((id) => !id.startsWith('Fs.')),
      'an Expecto id is its list path alone — no module prefix is invented for it',
    );
  });

  test('Expecto: a passing, a failing, a pending and a nested case each report their own outcome', async function () {
    this.timeout(DOTNET_CLI_MS);
    await discoverSolution(api, slnPath, ALL);
    await api.testController.whenIdle();
    const passing = await runExpecting(EXPECTO_PASSING, expectoDir, 'passed');
    assert.strictEqual(passing.message, undefined, 'a pass carries no message');
    assert.strictEqual(typeof passing.duration, 'number', 'the TRX duration reaches the cache');
    const failing = await runExpecting(EXPECTO_FAILING, expectoDir, 'failed');
    assert.ok(
      failing.message?.includes(EXPECTO_FAILURE_MESSAGE),
      `the expectation's own message reaches the result — ${described(failing)}`,
    );
    await runExpecting(EXPECTO_PENDING, expectoDir, 'skipped');
    await runExpecting(EXPECTO_NESTED, expectoDir, 'passed');
    for (const [id, outcome] of [
      [EXPECTO_PASSING, 'passed'],
      [EXPECTO_FAILING, 'failed'],
      [EXPECTO_PENDING, 'skipped'],
      [EXPECTO_NESTED, 'passed'],
    ] as const) {
      assert.strictEqual(api.testController.getResult(id)?.outcome, outcome, `${id}: own outcome`);
      assert.strictEqual(findItem(api.testController.items, id)?.id, id, `${id} stays in the tree`);
    }
  });

  test('FsCheck: a property that holds passes, a falsified one fails with its counterexample, a skipped one is skipped', async function () {
    this.timeout(DOTNET_CLI_MS);
    await discoverSolution(api, slnPath, ALL);
    await api.testController.whenIdle();
    const holds = await runExpecting(FSCHECK_HOLDS, fscheckDir, 'passed');
    assert.strictEqual(holds.message, undefined, 'a property that holds carries no message');
    const falsified = await runExpecting(FSCHECK_FALSIFIED, fscheckDir, 'failed');
    assert.ok(
      falsified.message?.includes('Falsifiable'),
      `FsCheck's own verdict reaches the result — ${described(falsified)}`,
    );
    await runExpecting(FSCHECK_SKIPPED, fscheckDir, 'skipped');
    assert.strictEqual(
      api.testController.getResult(FSCHECK_HOLDS)?.outcome,
      'passed',
      'running the falsified property never turned the holding one red',
    );
    assert.strictEqual(
      api.testController.getResult(EXPECTO_PASSING)?.outcome ?? 'passed',
      'passed',
      'and FsCheck runs leave the Expecto results alone',
    );
  });
});
