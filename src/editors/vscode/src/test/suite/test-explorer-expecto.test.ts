// Expecto through the Test Explorer, end to end: a REAL Expecto project, built
// by the real `dotnet` CLI and run through YoloDev.Expecto.TestSdk, the VSTest
// adapter every Expecto template ships. F# is a first-class citizen, and
// Expecto is how a large share of F# code is tested: its tests are VALUES —
// `testList "name" [ testCase "name" ... ]` — not attributed methods, so a test's
// fully-qualified name is the path of list names joined by dots, spaces kept.
// Nothing about that shape may be specific to xUnit, NUnit or MSTest.
//
// Covers [TEST-DISCOVERY-FQN], [TEST-FILTER-ESCAPE] and [TEST-RUN-TRX] for
// "Expecto/FsCheck test debugging | P1 (F# parity)" of [DEBUG-FEATURES-TESTS].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { SharpLspExtensionApi } from '../../extension.js';
import type { CachedTestResult } from '../../testing.js';
import { createSolution, warmDiscovery } from './dotnet-project-kit';
import {
  EXPECTO_ALL as ALL,
  EXPECTO_FAILING as FAILING,
  EXPECTO_FAILURE_MESSAGE as FAILURE_MESSAGE,
  EXPECTO_NESTED as NESTED,
  EXPECTO_PASSING as PASSING,
  EXPECTO_PENDING as PENDING,
  EXPECTO_PROJECT,
  writeExpectoProject,
} from './expecto-fixture';
import { assertLeafItem, collectLeafIds, discoverSolution, findItem } from './test-explorer-kit';
import { useScratchSuite } from './test-explorer-harness';
import { DOTNET_CLI_MS } from './test-timeouts';

/** A result's outcome and message, for one assertion that names both. */
function described(result: CachedTestResult | undefined): string {
  return `${result?.outcome ?? 'no result'}: ${result?.message ?? 'no message'}`;
}

suite('Test Explorer e2e — Expecto (F#)', () => {
  let api: SharpLspExtensionApi;
  let projectDir: string;
  let slnPath: string;

  useScratchSuite('sharplsp-expecto-', async (scratch) => {
    ({ api } = scratch);
    projectDir = path.join(scratch.root, EXPECTO_PROJECT);
    writeExpectoProject(projectDir);
    slnPath = await createSolution(scratch.root, 'Expecto', [projectDir]);
    await warmDiscovery(slnPath, scratch.root);
  });

  test('discovery lists every Expecto case by its list path, spaces and nesting intact', async function () {
    this.timeout(DOTNET_CLI_MS);
    const ids = await discoverSolution(api, slnPath, ALL);
    await api.testController.whenIdle();
    for (const id of ALL) assert.ok(ids.includes(id), `${id} is discovered verbatim`);
    const leaves = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(
      leaves.filter((id) => id.startsWith('calculator')).sort(),
      [...ALL].sort(),
      'exactly the four cases, nothing invented and nothing lost',
    );
    for (const id of ALL) {
      const item = assertLeafItem(api.testController.items, id);
      assert.strictEqual(item.children.size, 0, `${id} is a runnable leaf`);
      assert.ok(item.label.length > 0, `${id} has a label to render`);
    }
    assert.ok(
      leaves.every((id) => !id.includes('Fs.Expecto.dll')),
      'no assembly path or VSTest chatter survives into the ids',
    );
  });

  test('a passing, a failing, a pending and a nested Expecto case each report their own outcome', async function () {
    this.timeout(DOTNET_CLI_MS);
    await discoverSolution(api, slnPath, ALL);
    await api.testController.whenIdle();

    const passing = await api.testController.runSingle(PASSING, projectDir);
    assert.strictEqual(passing.outcome, 'passed', `${PASSING} runs green — ${described(passing)}`);
    assert.ok(passing.passed, 'a pass sets passed');
    assert.strictEqual(passing.message, undefined, 'a pass carries no message');
    assert.strictEqual(typeof passing.duration, 'number', 'the TRX duration reaches the cache');

    const failing = await api.testController.runSingle(FAILING, projectDir);
    assert.strictEqual(failing.outcome, 'failed', `${FAILING} fails — ${described(failing)}`);
    assert.ok(!failing.passed, 'a failure never sets passed');
    assert.ok(
      failing.message?.includes(FAILURE_MESSAGE),
      `the expectation's own message reaches the result — ${described(failing)}`,
    );

    const pending = await api.testController.runSingle(PENDING, projectDir);
    assert.strictEqual(
      pending.outcome,
      'skipped',
      `a ptestCase is skipped — ${described(pending)}`,
    );
    assert.ok(!pending.passed, 'a skip is not a pass');

    const nested = await api.testController.runSingle(NESTED, projectDir);
    assert.strictEqual(nested.outcome, 'passed', `${NESTED} runs green — ${described(nested)}`);

    for (const [id, outcome] of [
      [PASSING, 'passed'],
      [FAILING, 'failed'],
      [PENDING, 'skipped'],
      [NESTED, 'passed'],
    ] as const) {
      assert.strictEqual(
        api.testController.getResult(id)?.outcome,
        outcome,
        `${id}: each run cached only its own outcome`,
      );
      assert.strictEqual(findItem(api.testController.items, id)?.id, id, `${id} stays in the tree`);
    }
  });
});
