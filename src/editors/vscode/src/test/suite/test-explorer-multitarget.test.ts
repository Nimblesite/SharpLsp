// A MULTI-TARGETED test project is ONE project, and the Testing view must show
// it as ONE assembly root.
//
// `dotnet test --list-tests` prints one `Test run for <dll> (<framework>)`
// banner per TARGET FRAMEWORK, so a project declaring two of them announces two
// assembly paths that differ only in their `bin/Debug/<tfm>/` segment, carry the
// same file name, and contribute the same fully-qualified test names. Discovery
// grouped the tree by that PATH, so the same project — same namespaces, same
// classes, same tests — appeared TWICE at the root of the Testing view under two
// indistinguishable labels. FluentValidation's `net8.0;net9.0` test project is
// the shape that surfaced it.
//
// The fixture reads its `<TargetFrameworks>` off the agent's INSTALLED runtimes
// instead of pinning them: a second framework with no runtime never gets a test
// host, so its assembly is never announced and the fixture would quietly degrade
// to a single target — passing vacuously against the very bug this suite exists
// to catch. The first test asserts the announcement really happened twice, so
// that degradation fails as itself.
//
// Covers [TEST-DISCOVERY-FQN] and [TEST-EXPLORER].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { parseTestAssemblies } from '../../test-discovery.js';
import {
  buildProjectXml,
  createSolution,
  installedFrameworkPair,
  warmDiscovery,
  writeProject,
} from './dotnet-project-kit';
import { fixtureFor } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  collectLeafIds,
  discoverSolution,
  drainDiscovery,
} from './test-explorer-kit';
import { removeDirRecursive } from './test-helpers.js';
import { DOTNET_CLI_MS, FAST_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The C# xUnit fixture, rebuilt here for TWO target frameworks. */
const CS = fixtureFor('xunit-csharp');

/** Every fully-qualified name the fixture's single test class exposes. */
const EXPECTED: readonly string[] = [
  CS.passing,
  CS.failing,
  CS.skipped,
  CS.parameterized,
  ...(CS.mixedParameterized === undefined ? [] : [CS.mixedParameterized]),
];

/** The roots of the Testing view, in tree order. */
function rootsOf(items: vscode.TestItemCollection): vscode.TestItem[] {
  const roots: vscode.TestItem[] = [];
  items.forEach((item) => roots.push(item));
  return roots;
}

/** The values appearing more than once in `values`, each named once. */
function duplicatesIn(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

suite('Test Explorer — a multi-targeted project is ONE assembly root', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let frameworks: string[];
  let listing: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-multitfm-'));
    frameworks = await installedFrameworkPair(root);
    const projectDir = writeProject(
      path.join(root, CS.projectName),
      CS.projectFileName,
      buildProjectXml({
        packages: CS.packages,
        properties: { TargetFrameworks: frameworks.join(';') },
      }),
      CS.sourceFileName,
      CS.source,
    );
    const slnPath = await createSolution(root, 'MultiTfm', [projectDir]);

    // Warm the FULL discovery path once (both builds + the adapter JIT). The
    // output is KEPT: the announcement assertion below reads a REAL listing.
    listing = await warmDiscovery(slnPath, root);
    await discoverSolution(api, slnPath, EXPECTED);
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

  test('the fixture really is multi-targeted: one built assembly announced PER framework', function () {
    this.timeout(FAST_MS);
    const assemblies = parseTestAssemblies(listing);
    assert.deepStrictEqual(
      assemblies.map((assembly) => path.basename(path.dirname(assembly))).sort(),
      [...frameworks].sort(),
      `VSTest must announce ${CS.projectFileName} once per target framework, ` +
        `got: ${assemblies.join(' | ') || '(nothing)'}`,
    );
    assert.deepStrictEqual(
      [...new Set(assemblies.map((assembly) => path.basename(assembly)))],
      [`${CS.projectName}.dll`],
      'the announced assemblies differ ONLY in their target-framework directory',
    );
  });

  test('the tree carries ONE root for the project, never one per target framework', function () {
    this.timeout(FAST_MS);
    const labels = rootsOf(api.testController.items).map((item) => item.label);
    assert.deepStrictEqual(
      labels,
      [CS.projectName],
      `a multi-targeted project is ONE assembly root; the Testing view showed: ${
        labels.join(' | ') || '(nothing)'
      }`,
    );
  });

  test('no test is listed twice — one leaf per fully-qualified name', function () {
    this.timeout(FAST_MS);
    const leaves = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(
      duplicatesIn(leaves),
      [],
      `each test appears once whatever it is compiled for; duplicated leaves in: ${leaves.join(', ')}`,
    );
    assert.deepStrictEqual(
      [...leaves].sort(),
      [...EXPECTED].sort(),
      'the merged root still carries every test the project exposes',
    );
  });
});
