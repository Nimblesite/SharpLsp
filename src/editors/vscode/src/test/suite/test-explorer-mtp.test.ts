// Microsoft.Testing.Platform discovery, end to end, inside the real extension
// host against six REAL projects the `dotnet` CLI built.
//
// Regression suite for issue #249. The Test Explorer was VSTest end to end, and
// every one of its commands fails against an MTP project: `--nologo` is not a
// valid MTP option, `dotnet vstest` cannot load the module, and neither
// `--filter` nor `--logger trx` exists. On the .NET 10 SDK, MTP v2 removed the
// VSTest shim and `xunit.v3` 4.0.0 uses MTP v2 by default, so an ordinary xUnit
// user saw an empty Testing view.
//
// F# comes FIRST throughout (project rule). The shapes that must survive are the
// same three the VSTest matrix protects, in their MTP form:
//
//   • an F# backtick binding whose id carries SPACES,
//   • an F# `[<TestClass>]` nested in a module, whose id carries the CLR `+`,
//   • MSTest's DISPLAY name, which is the BARE method name and must NEVER
//     become an id.
//
// Covers [TEST-MTP-DETECT], [TEST-MTP-MODULES] and [TEST-MTP-DISCOVERY].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SharpLspExtensionApi } from '../../extension.js';
import { listMtpTests } from '../../test-mtp-discovery.js';
import { scanMtpProjects } from '../../test-mtp-modules.js';
import { usesMtpRunner } from '../../test-mtp.js';
import {
  ALL_MTP_IDS,
  createMtpSolution,
  idsOf,
  MTP_FIXTURES,
  mtpFixtureFor,
  type MtpFixture,
} from './test-explorer-mtp-fixtures';
import {
  activateTestExplorer,
  collectLeafIds,
  discoverSolution,
  findItem,
  rootsOf,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { sorted } from './test-explorer-outcome-assertions';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The awkward id shapes, the label each renders as, and why it is hard. */
const AWKWARD_SHAPES: readonly (readonly [string, string, string])[] = [
  [
    'Fs.XunitMtp.Fixtures.adds two numbers with spaces',
    'adds two numbers with spaces',
    'an F# backtick binding carries SPACES',
  ],
  [
    'Fs.MstestMtp.Fixtures+CalculatorTests.AddsTwoNumbers',
    'AddsTwoNumbers',
    'an F# [<TestClass>] is a CLR nested type, hence the +',
  ],
  [
    'Cs.NunitMtp.Fixtures.CalculatorTests.Adds_Case',
    'Adds_Case',
    'an NUnit [TestCase] id carries NO row data, though its uid does',
  ],
];

/**
 * MSTest and NUnit DISPLAY names. Not one of them may reach the tree as an id:
 * a bare method name cannot be attributed to a class, and it is the issue-#180
 * defect in its MTP shape.
 */
const BARE_DISPLAY_NAMES: readonly string[] = [
  'Adds_TwoNumbers',
  'Fails_OnPurpose',
  'Skipped_OnPurpose',
  'Adds_Row (2,2,4)',
  'Adds_Case(2,2,4)',
];

/** The dotted prefix every id of one fixture shares. */
function prefixOf(fixture: MtpFixture): string {
  return fixture.passing.split('.').slice(0, 3).join('.');
}

suite('Test Explorer e2e — Microsoft.Testing.Platform discovery', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let slnPath: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-'));
    slnPath = await createMtpSolution(root);
  });

  teardown(async () => {
    // Never leave a `dotnet` invocation in flight across tests: discovery builds
    // the same `bin/`/`obj/` a run rebuilds, and the overlap breaks both.
    await api.testController.whenIdle();
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('the global.json opt-in selects MTP, and the modules come from MSBuild', async function () {
    this.timeout(FIXTURE_BUILD_MS);

    // 1. The switch a real user throws is read from the fixture on disk.
    assert.equal(usesMtpRunner(root), true, 'the fixture opts into the MTP runner');
    assert.equal(
      usesMtpRunner(path.join(root, 'XunitMtpFs')),
      true,
      'the opt-in is found from a project directory, exactly as the SDK finds it',
    );

    // 2. MSBuild — not a banner and not a guess — names every test module.
    const scan = await scanMtpProjects(slnPath, root);
    assert.equal(
      scan.projects.length,
      MTP_FIXTURES.length,
      `every MTP project must be found; warnings: ${scan.warnings.join(' | ') || '(none)'}`,
    );
    for (const project of scan.projects) {
      assert.ok(project.modules.length > 0, `${project.projectFile} must report a module`);
      for (const module of project.modules) {
        assert.equal(fs.existsSync(module), true, `the module must exist on disk: ${module}`);
        assert.equal(path.extname(module), '.dll', 'a test module is a built assembly');
      }
    }
    const names = scan.projects.map((project) => path.basename(project.projectFile));
    assert.deepStrictEqual(
      sorted(names),
      sorted(MTP_FIXTURES.map((fixture) => fixture.projectFileName)),
      'exactly the fixture projects, no more and no fewer',
    );
  });

  test('every test of all six framework × language fixtures is discovered by id', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const ids = await discoverSolution(api, slnPath, ALL_MTP_IDS);

    // 1. Each fixture contributes exactly its own tests — a failing one and a
    //    skipped one included, because discovery is not a run.
    for (const fixture of MTP_FIXTURES) {
      const mine = ids.filter((id) => id.startsWith(prefixOf(fixture)));
      assert.deepStrictEqual(
        sorted(mine),
        sorted(idsOf(fixture)),
        `${fixture.key} must expose exactly its own tests`,
      );
      assert.ok(
        ids.includes(fixture.failing),
        `${fixture.key}: a failing test is still discovered`,
      );
      assert.ok(
        ids.includes(fixture.skipped),
        `${fixture.key}: a skipped test is still discovered`,
      );
    }

    // 2. A data-driven test appears ONCE, under an id carrying no row data.
    for (const fixture of MTP_FIXTURES) {
      const rows = ids.filter((id) => id === fixture.parameterized);
      assert.equal(rows.length, 1, `${fixture.key}: the rows collapse onto one id`);
      assert.equal(
        fixture.parameterized.includes('('),
        false,
        `${fixture.key}: the id carries no row data — ${fixture.parameterized}`,
      );
    }

    // 3. No display name, and no listing chatter, ever becomes an id.
    for (const bare of BARE_DISPLAY_NAMES) {
      assert.equal(
        ids.includes(bare),
        false,
        `a bare display name must never be an id: '${bare}' (issue #180 in its MTP shape)`,
      );
    }
    for (const id of ids) {
      assert.equal(id.trim(), id, `a tree id never keeps the listing's spacing: '${id}'`);
      assert.ok(id.includes('.'), `every MTP id is namespace-qualified: '${id}'`);
    }
  });

  test('the awkward F# and NUnit shapes reach the tree verbatim, with their labels', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const ids = await discoverSolution(api, slnPath, ALL_MTP_IDS);

    for (const [id, label, why] of AWKWARD_SHAPES) {
      assert.ok(ids.includes(id), `${why}: '${id}' must be discovered`);
      const item = findItem(api.testController.items, id);
      assert.ok(item, `${why}: '${id}' must be a row in the tree`);
      assert.equal(item.label, label, `${why}: the row is labelled by its last segment`);
      assert.equal(item.description, id, `${why}: the full id stays visible as the description`);
    }
  });

  test('the tree is Assembly → Namespace → Class → Test, one root per project', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await discoverSolution(api, slnPath, ALL_MTP_IDS);

    // 1. One root per test module, labelled by the assembly, and never a leaf.
    const roots = rootsOf(api.testController.items);
    const rootLabels = roots.map((item) => item.label);
    for (const fixture of MTP_FIXTURES) {
      assert.ok(
        rootLabels.includes(fixture.projectName),
        `${fixture.key}: the assembly is a root — saw ${rootLabels.join(', ')}`,
      );
    }
    for (const root_ of roots) {
      assert.ok(root_.children.size > 0, `an assembly root is a group, not a test: ${root_.label}`);
      assert.ok(root_.id.startsWith('assembly:'), `a root id names its module: ${root_.id}`);
    }

    // 2. A test sits under its class, which sits under its namespace.
    const csharp = mtpFixtureFor('xunit-csharp');
    const leaf = findItem(api.testController.items, csharp.passing);
    assert.ok(leaf, 'the C# xUnit passing test must be a row');
    assert.equal(leaf.children.size, 0, 'a test is a LEAF');
    assert.ok(leaf.parent, 'a leaf hangs under its class');
    assert.equal(leaf.parent.label, 'CalculatorTests', 'the class level is labelled by the type');
    assert.ok(leaf.parent.parent, 'a class hangs under its namespace');
    assert.equal(
      leaf.parent.parent.label,
      'Cs.XunitMtp.Fixtures',
      'the namespace level is labelled by the namespace',
    );
    assert.equal(
      leaf.parent.parent.parent?.label,
      csharp.projectName,
      'and the namespace hangs under the assembly',
    );

    // 3. Every leaf id is a test id, and no group node is one.
    const leaves = collectLeafIds(api.testController.items);
    assert.deepStrictEqual(
      sorted(leaves),
      sorted(ALL_MTP_IDS),
      'exactly the fixture tests are leaves',
    );
  });

  test('a source location is used when the framework reports one, and never invented', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    await discoverSolution(api, slnPath, ALL_MTP_IDS);

    for (const fixture of MTP_FIXTURES) {
      const item = findItem(api.testController.items, fixture.passing);
      assert.ok(item, `${fixture.key}: the passing test must be a row`);
      if (!fixture.reportsLocation) {
        // NUnit reports none. The row still exists, pointed at the target folder.
        assert.equal(item.range, undefined, `${fixture.key}: no location means no range`);
        continue;
      }
      assert.ok(item.uri, `${fixture.key}: a reported location gives the row a file`);
      assert.equal(
        path.basename(item.uri.fsPath),
        fixture.sourceFileName,
        `${fixture.key}: the row points at the file the test is written in`,
      );
      assert.ok(item.range, `${fixture.key}: a reported location gives the row a range`);
      assert.ok(
        item.range.start.line >= 0,
        `${fixture.key}: the 1-based listing line becomes a 0-based range`,
      );
    }
  });

  test('an MTP project with NO global.json is still found, through MSBuild', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const globalJson = path.join(root, 'global.json');
    const saved = fs.readFileSync(globalJson, 'utf8');
    fs.rmSync(globalJson);
    try {
      assert.equal(usesMtpRunner(root), false, 'the opt-in is gone, so detection falls through');

      // The VSTest passes cannot enumerate an `xunit.v3` module at all, so the
      // MSBuild probe is the only thing standing between the user and an empty
      // Testing view. It must find every project on its own.
      const listing = await listMtpTests(slnPath, root);
      assert.equal(listing.ok, true, `the MTP sweep must succeed: ${listing.warnings.join(' | ')}`);
      assert.deepStrictEqual(
        sorted([...listing.names]),
        sorted(ALL_MTP_IDS),
        'exactly the fixture tests, found without any opt-in',
      );
      assert.ok(listing.mtp, 'the sweep must also report HOW to run what it found');
      assert.equal(
        listing.mtp.modules.length,
        MTP_FIXTURES.length,
        'one run entry per test module',
      );
      for (const module of listing.mtp.modules) {
        assert.ok(module.uidsById.size > 0, `${module.modulePath} must map ids to uids`);
      }
    } finally {
      fs.writeFileSync(globalJson, saved, 'utf8');
    }
  });
});
