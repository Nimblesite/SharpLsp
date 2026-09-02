// A test's id is the BARE fully-qualified name, whatever the VSTest adapter
// decorated it with.
//
// `dotnet vstest … --ListFullyQualifiedTests` does not always write a bare
// `TestCase.FullyQualifiedName`. On `xunit.runner.visualstudio` 2.2.0 — still
// pinned by real-world projects, FluentValidation among them — it appends the
// test case's 40-hex unique ID:
//
//   Cs.XunitLegacy.Fixtures.CalculatorTests.Adds_TwoNumbers (d87517d9ff1844…)
//
// Taken verbatim as the test id, that suffix breaks the whole run path at once:
// the tree renders `Adds_TwoNumbers (d87517d9…)`, `--filter
// FullyQualifiedName=…\(d87517d9…\)` matches NO test, and the TRX report keys on
// `className.name` — the bare name — so nothing can be attributed back. Every
// test in the project then errors with `No result reported for …` and Run,
// Debug and Coverage are all unusable (issue #232).
//
// Every other Test Explorer fixture pins a modern adapter that emits bare names,
// which is exactly why the suite was blind to this. Names that legitimately end
// in parentheses MUST survive untouched — [TEST-DISCOVERY-FQN] requires the
// NUnit `Adds_Case(2,2,4)` shape to round-trip — so this suite asserts the real
// end-to-end contract: bare ids, and a ▶ that reports genuine per-test outcomes.
//
// Covers [TEST-DISCOVERY-FQN], [TEST-FILTER-ESCAPE] and [TEST-RUN-TRX].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { parseTestAssemblies, withoutAdapterUniqueId } from '../../test-discovery.js';
import {
  createSolution,
  dotnet,
  projectXml,
  warmDiscovery,
  writeProject,
} from './dotnet-project-kit';
import { LEGACY_ADAPTER_FIXTURE as LEGACY } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectLeafIds,
  drainDiscovery,
  pollForIds,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import {
  assertFailed,
  assertPassed,
  assertSkipped,
  cachedFor,
  itemsFor,
  sorted,
} from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers.js';
import { DOTNET_CLI_MS, FAST_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** Every fully-qualified name the legacy-adapter fixture exposes. */
const EXPECTED: readonly string[] = [
  LEGACY.passing,
  LEGACY.failing,
  LEGACY.skipped,
  LEGACY.parameterized,
  ...(LEGACY.mixedParameterized === undefined ? [] : [LEGACY.mixedParameterized]),
];

/** The three outcomes a run must attribute, one per kind. */
const RUNNABLE = [LEGACY.passing, LEGACY.failing, LEGACY.skipped] as const;

/**
 * True when `name` still carries the adapter's unique-ID decoration.
 *
 * Asked of the production classifier rather than re-implementing its rule here:
 * a second copy of "what a decorated name looks like" is exactly the duplication
 * that lets the two drift apart. A stripper broken to strip nothing makes the
 * vacuity guard below FAIL — it would report the raw listing as undecorated —
 * and one broken to strip everything is caught by the bare-id assertion, so
 * neither failure mode can hide behind this.
 */
function carriesUniqueId(name: string): boolean {
  return withoutAdapterUniqueId(name) !== name;
}

suite('Test Explorer — adapter-decorated names become BARE test ids', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let announced: string;
  let discovered: string[];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-adapterids-'));
    const projectDir = writeProject(
      path.join(root, LEGACY.projectName),
      LEGACY.projectFileName,
      projectXml(LEGACY.packages),
      LEGACY.sourceFileName,
      LEGACY.source,
    );
    const slnPath = await createSolution(root, 'LegacyAdapter', [projectDir]);

    // Warm the FULL discovery path once, and keep the assembly it announced:
    // the vacuity guard below re-runs the listing pass against it directly.
    const listing = await warmDiscovery(slnPath, root);
    announced = parseTestAssemblies(listing)[0] ?? '';

    // Settle the tree by COUNT, never by the names this suite is asserting.
    // Waiting here for the bare names would make the defect present as a hook
    // that ran out its own ceiling — the failure every assertion below exists to
    // describe, reported as an opaque timeout instead
    // ([DIST-CI-VSIX-SHARDS-TIMEOUTS]). The poll budget sits strictly under the
    // hook's for the same reason.
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    discovered = await pollForIds(
      api.testController,
      (ids) => ids.length >= EXPECTED.length,
      DOTNET_CLI_MS,
    );
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    // Drain reactive re-discovery BEFORE deleting the fixture: a `dotnet test`
    // pointed at a removed directory hangs forever and poisons later runs.
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
  });

  test('the adapter really does decorate its names, so this suite cannot pass vacuously', async function () {
    this.timeout(DOTNET_CLI_MS);
    assert.notStrictEqual(announced, '', 'the fixture must have announced a built test assembly');
    const listPath = path.join(root, 'raw-fqns.txt');
    await dotnet(
      ['vstest', announced, '--ListFullyQualifiedTests', `--ListTestsTargetPath:${listPath}`],
      root,
    );
    const raw = fs
      .readFileSync(listPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.ok(raw.length > 0, 'the listing pass must have written some names');
    assert.deepStrictEqual(
      raw.filter((name) => !carriesUniqueId(name)),
      [],
      'xunit.runner.visualstudio 2.2.0 appends a unique ID to EVERY name it reports; ' +
        'without that, this suite proves nothing',
    );
  });

  test('discovered ids are the BARE fully-qualified names, with no adapter suffix', function () {
    this.timeout(FAST_MS);
    const leaves = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(
      leaves,
      discovered,
      'the tree must not have moved between the settled read and this assertion',
    );
    assert.deepStrictEqual(
      leaves.filter((id) => carriesUniqueId(id)),
      [],
      "a test id is the name `--filter` and the TRX report use — never the adapter's decoration",
    );
    assert.deepStrictEqual(
      sorted(leaves),
      sorted(EXPECTED),
      'every test in the project is discovered, exactly once, under its bare name',
    );
  });

  test('the tree shows the METHOD name, not a hex blob', function () {
    this.timeout(FAST_MS);
    const labels: string[] = [];
    const walk = (item: vscode.TestItem): void => {
      if (item.children.size === 0) {
        labels.push(item.label);
        return;
      }
      item.children.forEach(walk);
    };
    rootsOf(api.testController.items).forEach(walk);
    assert.deepStrictEqual(
      sorted(labels),
      sorted(EXPECTED.map((fqn) => fqn.split('.').at(-1) ?? fqn)),
      'each leaf is labelled with its method name alone',
    );
  });

  test('▶ reports a REAL outcome per test — never "No result reported"', async function () {
    this.timeout(DOTNET_CLI_MS);
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, itemsFor(api, RUNNABLE));
    assertPassed(cachedFor(api, LEGACY.passing), LEGACY.passing);
    assertFailed(cachedFor(api, LEGACY.failing), LEGACY.failing);
    assertSkipped(cachedFor(api, LEGACY.skipped), LEGACY.skipped);
  });
});
