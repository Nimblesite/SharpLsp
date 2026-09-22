// Running Microsoft.Testing.Platform tests across SEVERAL modules, and after an
// EDIT, end to end inside the real extension host.
//
// The MTP path runs a BUILT module with `dotnet exec`, one invocation per
// module, and reads every module's TRX report back out of one shared results
// directory. A single-module fixture that is never edited cannot see the three
// ways that goes wrong:
//
//   • the module on disk is STALE — `dotnet exec` builds nothing, so a test the
//     user has just edited would run as it was before the edit;
//   • two modules share a FILE NAME — both target frameworks of one project
//     build `ModulesMtpCs.dll` — and one report can overwrite the other;
//   • one module FAILS while another succeeds — the failing module's message is
//     the only account its tests get, and a sibling's results must not erase it.
//
// So the fixture is one multi-targeted project beside one that lacks
// `Microsoft.Testing.Extensions.TrxReport`. The multi-targeted project carries
// one test per framework that fails in THAT framework's module only, so no
// order the modules happen to run in can hide a lost report.
//
// Covers [TEST-MTP-RUN] and [TEST-MTP-MODULES].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { listMtpTests } from '../../test-mtp-discovery.js';
import { runMtpTests } from '../../test-mtp-run.js';
import { trxFiles } from '../../test-trx-collect.js';
import {
  buildProjectXml,
  createSolution,
  installedFrameworkPair,
  mtpProjectXml,
  MTP_PROPERTIES,
  MTP_TRX_REPORT,
  MTP_XUNIT_PACKAGES,
  symbolFor,
  writeMtpGlobalJson,
  writeProject,
} from './dotnet-project-kit';
import {
  activateTestExplorer,
  discoverSolution,
  rootsOf,
  runViaProfile,
  teardownFixtureSolution,
} from './test-explorer-kit';
import {
  assertFailed,
  assertPassed,
  cachedFor,
  itemsFor,
  sorted,
} from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The multi-targeted project: TWO modules sharing one file name. */
const PROJECT = 'ModulesMtpCs';
const NAMESPACE = 'Cs.ModulesMtp.Fixtures';

/** The project WITHOUT the TRX extension, so `--report-trx` fails on it. */
const NO_TRX_PROJECT = 'NoTrxModulesMtpCs';
const NO_TRX_NAMESPACE = 'Cs.NoTrxModulesMtp.Fixtures';
const NO_TRX_PACKAGES = MTP_XUNIT_PACKAGES.filter((ref) => ref !== MTP_TRX_REPORT);

/** The source file the edit-then-run test rewrites. */
const CALCULATOR_FILE = 'CalculatorTests.cs';

/** The test the user edits between discovery and ▶. */
const EDITED = `${NAMESPACE}.CalculatorTests.Adds_TwoNumbers`;
/** The only test of the module that cannot report per-test results. */
const NO_TRX_ID = `${NO_TRX_NAMESPACE}.CalculatorTests.Adds_TwoNumbers`;

/** One fact asserting `1 + 2` equals `expected` — green at 3, red otherwise. */
function calculatorSource(namespace: string, expected: number): string {
  return [
    'using Xunit;',
    '',
    `namespace ${namespace}`,
    '{',
    '    public class CalculatorTests',
    '    {',
    `        [Fact] public void Adds_TwoNumbers() => Assert.Equal(${String(expected)}, 1 + 2);`,
    '    }',
    '}',
    '',
  ].join('\n');
}

/** The method that fails when compiled for `framework`, and passes otherwise. */
function failsOnlyOn(framework: string): string {
  return `Fails_Only_On_${symbolFor(framework)}`;
}

/** Its id, which EVERY module of the project reports. */
function frameworkId(framework: string): string {
  return `${NAMESPACE}.FrameworkTests.${failsOnlyOn(framework)}`;
}

/**
 * One test per framework, failing ONLY in that framework's module. Every
 * module carries every id, so every module's report must be read to get every
 * verdict right.
 */
function frameworkSource(frameworks: readonly string[]): string {
  const methods = frameworks.flatMap((framework) => [
    `#if ${symbolFor(framework)}`,
    `        [Fact] public void ${failsOnlyOn(framework)}() => Assert.Equal(4, 1 + 2);`,
    '#else',
    `        [Fact] public void ${failsOnlyOn(framework)}() => Assert.Equal(3, 1 + 2);`,
    '#endif',
  ]);
  return [
    'using Xunit;',
    '',
    `namespace ${NAMESPACE}`,
    '{',
    '    public class FrameworkTests',
    '    {',
    ...methods,
    '    }',
    '}',
    '',
  ].join('\n');
}

/** Write both projects plus the opt-in, and return the solution the CLI made. */
async function createFixture(root: string, frameworks: readonly string[]): Promise<string> {
  writeMtpGlobalJson(root);
  const multi = writeProject(
    path.join(root, PROJECT),
    `${PROJECT}.csproj`,
    buildProjectXml({
      packages: MTP_XUNIT_PACKAGES,
      properties: { ...MTP_PROPERTIES, TargetFrameworks: frameworks.join(';') },
    }),
    CALCULATOR_FILE,
    calculatorSource(NAMESPACE, 3),
  );
  // C# globs its sources, so the second class needs no project edit.
  fs.writeFileSync(path.join(multi, 'FrameworkTests.cs'), frameworkSource(frameworks), 'utf8');
  const bare = writeProject(
    path.join(root, NO_TRX_PROJECT),
    `${NO_TRX_PROJECT}.csproj`,
    mtpProjectXml(NO_TRX_PACKAGES),
    CALCULATOR_FILE,
    calculatorSource(NO_TRX_NAMESPACE, 3),
  );
  return await createSolution(root, 'ModulesMtp', [multi, bare]);
}

suite('Test Explorer e2e — Microsoft.Testing.Platform across several modules', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;
  let frameworks: string[];
  /** Every id the fixture solution must expose. */
  let expected: string[];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-modules-'));
    frameworks = await installedFrameworkPair(root);
    slnPath = await createFixture(root, frameworks);
    expected = [EDITED, ...frameworks.map(frameworkId), NO_TRX_ID];
    await discoverSolution(api, slnPath, expected);
  });

  teardown(async () => {
    await api.testController.whenIdle();
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('a multi-targeted project reports EVERY framework, and no report overwrites another', async function () {
    this.timeout(FIXTURE_BUILD_MS);

    // 1. The fixture really is two modules sharing ONE file name — the shape
    //    whose reports can collide — and the tree still shows ONE root for it.
    const listing = await listMtpTests(slnPath, root);
    assert.ok(listing.mtp, 'an MTP solution must come back with a run plan');
    const modules = listing.mtp.modules.filter(
      (module) => path.basename(module.modulePath) === `${PROJECT}.dll`,
    );
    const plan = listing.mtp.modules.map((module) => module.modulePath).join(' | ');
    assert.deepStrictEqual(
      sorted(modules.map((module) => path.basename(path.dirname(module.modulePath)))),
      sorted(frameworks),
      `one ${PROJECT}.dll per target framework; plan: ${plan}`,
    );
    assert.equal(
      rootsOf(api.testController.items).filter((item) => item.label === PROJECT).length,
      1,
      'and the two modules are ONE assembly root in the tree',
    );

    // 2. ▶ on the whole tree sends no filter, so no retry can paper over a lost
    //    report. Each framework test fails in ONE module only, and must be red.
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, []);
    await api.testController.whenIdle();
    for (const framework of frameworks) {
      assertFailed(cachedFor(api, frameworkId(framework)), frameworkId(framework));
    }
    assertPassed(cachedFor(api, EDITED), EDITED);

    // 3. Each module leaves its OWN report in the shared directory, and every
    //    one of them is read.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-trx-'));
    try {
      const outcome = await runMtpTests({ modules }, [], root, { resultsDirectory: dir });
      const reports = trxFiles(dir);
      assert.equal(
        new Set(reports).size,
        modules.length,
        `one TRX report per module; got: ${reports.join(' | ') || '(none)'}`,
      );
      for (const framework of frameworks) {
        assert.equal(
          outcome.results.get(frameworkId(framework))?.outcome,
          'failed',
          `${framework}'s module failed ${failsOnlyOn(framework)}, so the run must say so`,
        );
      }
      assert.equal(outcome.results.get(EDITED)?.outcome, 'passed');
    } finally {
      removeDirRecursive(dir);
    }
  });

  test('a module without the TRX extension keeps its message beside modules that have it', async function () {
    this.timeout(FIXTURE_BUILD_MS);

    // 1. ▶ on the whole tree: the other modules' results come back, AND the
    //    bare module's test says why it has none — never "No result reported".
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, []);
    await api.testController.whenIdle();
    assertPassed(cachedFor(api, EDITED), EDITED);
    const bare = cachedFor(api, NO_TRX_ID);
    const message = bare.message ?? '';
    assert.equal(bare.outcome, 'notRun', `no TRX means no per-test result; got: ${message}`);
    assert.match(message, /Microsoft\.Testing\.Extensions\.TrxReport/, `got: ${message}`);
    assert.ok(message.includes(`${NO_TRX_PROJECT}.dll`), `and it names the module: ${message}`);

    // 2. The run itself carries that failure AND every result the other
    //    modules wrote.
    const listing = await listMtpTests(slnPath, root);
    assert.ok(listing.mtp);
    const outcome = await runMtpTests(listing.mtp, [], root);
    assert.match(
      outcome.failure ?? '',
      /Microsoft\.Testing\.Extensions\.TrxReport/,
      `the run's failure must name the package; got: ${outcome.failure ?? '(none)'}`,
    );
    assert.deepStrictEqual(
      sorted([...outcome.results.keys()]),
      sorted(expected.filter((id) => id !== NO_TRX_ID)),
      'every module that wrote a report is still read',
    );

    // 3. The status CodeLens's own run of that one test says the same thing.
    const lens = await api.testController.runSingle(NO_TRX_ID);
    assert.equal(lens.outcome, 'notRun');
    assert.match(lens.message ?? '', /Microsoft\.Testing\.Extensions\.TrxReport/);
  });

  test('an edited test is REBUILT before it runs, never run from its stale module', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const source = path.join(root, PROJECT, CALCULATOR_FILE);
    const [item] = itemsFor(api, [EDITED]);
    assert.ok(item);
    try {
      // 1. ▶ as discovered: green.
      await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
      await api.testController.whenIdle();
      assertPassed(cachedFor(api, EDITED), EDITED);

      // 2. Break the assertion and save. Nothing re-discovers — the user only
      //    pressed ▶ — so only the RUN can pick the edit up.
      fs.writeFileSync(source, calculatorSource(NAMESPACE, 4), 'utf8');
      await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
      await api.testController.whenIdle();
      assertFailed(cachedFor(api, EDITED), EDITED);
      const lens = await api.testController.runSingle(EDITED);
      assert.equal(
        lens.outcome,
        'failed',
        `the CodeLens run must see the edit too: ${lens.message ?? '(none)'}`,
      );

      // 3. Put it back: the next ▶ is green again, so the rebuild tracks the
      //    source in BOTH directions rather than latching the first change.
      fs.writeFileSync(source, calculatorSource(NAMESPACE, 3), 'utf8');
      await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
      await api.testController.whenIdle();
      assertPassed(cachedFor(api, EDITED), EDITED);
    } finally {
      fs.writeFileSync(source, calculatorSource(NAMESPACE, 3), 'utf8');
    }
  });
});
