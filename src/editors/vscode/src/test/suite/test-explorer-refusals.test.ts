// A target `dotnet` REFUSES without failing.
//
// Discovery reads a non-zero exit as "the enumeration went wrong" and anything
// else as an answer. `dotnet` does not always honour that split. A solution
// file that names its projects but declares no solution configuration — the
// shape a hand-written or half-migrated `.sln` has — restores nothing, builds
// nothing and lists nothing, then exits ZERO, saying only:
//
//   NuGet.targets(198,5): warning : Unable to find a project to restore! [<sln>]
//
// Read as a successful empty enumeration, that replaces the tree with nothing
// and leaves the user in front of VS Code's own empty state — "No tests have
// been found in this workspace yet", offering to install a test extension,
// which is the one remedy that cannot help. The extension log said
// `Test discovery: 0 item(s) from 1 target(s)` and nothing else.
//
// [TEST-MTP-MODULES] states the rule this suite holds every runner to: "A scan
// that went wrong and found nothing is NOT an empty answer." The distinction
// that matters is between a target `dotnet` refused and one it accepted, so the
// refusal and the recovery are asserted over the SAME project — a refusal read
// off a diagnostic must never turn an ordinary solution into an error row. The
// other side, a solution that truly holds no test staying a truthful empty
// tree, is owned by `test-explorer-mtp-sweeps.test.ts`.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SharpLspExtensionApi } from '../../extension.js';
import { listTests } from '../../test-discovery.js';
import { parseListingDiagnostics } from '../../test-listing.js';
import {
  buildProjectXml,
  createSolution,
  dotnet,
  projectXml,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';
import {
  collectLeafIds,
  discoverSolution,
  drainDiscovery,
  errorTextOf,
  rootsOf,
  activateWithScratch,
} from './test-explorer-kit';
import { removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS } from './test-timeouts';

/** One real xUnit test — the test the refusal loses. */
const TEST_SOURCE = [
  'using Xunit;',
  '',
  'namespace Cs.Refused.Fixtures',
  '{',
  '    public class CalculatorTests',
  '    {',
  '        [Fact] public void Adds_TwoNumbers() => Assert.Equal(3, 1 + 2);',
  '    }',
  '}',
  '',
].join('\n');

/** The id the tree must carry once the solution is one `dotnet` accepts. */
const EXPECTED_ID = 'Cs.Refused.Fixtures.CalculatorTests.Adds_TwoNumbers';

/** The words NuGet uses when a solution resolved no project at all. */
const REFUSAL = 'Unable to find a project to restore';

/**
 * A real `.sln` naming `projectPath` and declaring NO solution configuration.
 *
 * Written rather than produced by `dotnet new sln`, because the CLI cannot
 * produce this shape and it is the shape that causes the bug: the `Global`
 * section carries neither `SolutionConfigurationPlatforms` nor
 * `ProjectConfigurationPlatforms`, so the solution resolves zero buildable
 * projects. Format Version 12.00 and the C# project type GUID are the real
 * ones — this is a solution file Visual Studio and `dotnet sln list` both read.
 */
function writeUnconfiguredSolution(root: string, name: string, projectPath: string): string {
  const solutionPath = path.join(root, `${name}.sln`);
  fs.writeFileSync(
    solutionPath,
    [
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${name}", "${projectPath}", ` +
        '"{00000000-0000-0000-0000-000000000001}"',
      'EndProject',
      'Global',
      'EndGlobal',
      '',
    ].join('\n'),
    'utf8',
  );
  return solutionPath;
}

suite('Test Explorer e2e — a target dotnet refuses without failing', () => {
  let api: SharpLspExtensionApi;
  let parent: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    ({ api, root: parent } = await activateWithScratch('sharplsp-refusals-'));
  });

  teardown(async () => {
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
  });

  suiteTeardown(() => {
    removeDirRecursive(parent);
  });

  test('a solution dotnet restores nothing from explains itself instead of going blank', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);

    const root = path.join(parent, 'refused');
    const project = writeProject(
      path.join(root, 'RefusedTests'),
      'RefusedTests.csproj',
      projectXml(XUNIT_PACKAGES),
      'CalculatorTests.cs',
      TEST_SOURCE,
    );
    const unconfigured = writeUnconfiguredSolution(
      root,
      'Refused',
      path.join('RefusedTests', 'RefusedTests.csproj'),
    );

    // 1. The listing itself. `dotnet` exits ZERO here, so the exit code cannot
    //    be what tells discovery the target was refused — the diagnostic is.
    const refused = await listTests(unconfigured);
    assert.deepStrictEqual([...refused.names], [], 'a refused solution lists nothing');
    assert.equal(
      refused.ok,
      false,
      'and is NOT a truthful empty answer, whatever the exit code said',
    );
    assert.equal(refused.byAssembly.length, 0, 'and attributes no assembly');
    const warnings = refused.warnings.join('\n');
    assert.ok(warnings.includes(REFUSAL), `dotnet's own words reach the caller: ${warnings}`);

    // 2. The same solution through the Testing view: one error row carrying the
    //    diagnostic AND the remedy, never a blank tree ([TEST-MTP-MODULES]).
    await api.explorerProvider.loadSolution(unconfigured);
    await drainDiscovery(() => {
      api.testController.items.replace([]);
    }, api.testController);
    await api.testController.activateAndDiscover();
    await api.testController.whenIdle();
    const rows = rootsOf(api.testController.items);
    assert.equal(
      rows.length,
      1,
      `one row — the error — got: ${rows.map((row) => row.label).join(' | ')}`,
    );
    const message = errorTextOf(rows[0]);
    assert.ok(message.includes(REFUSAL), `the row carries the REAL diagnostic: ${message}`);
    assert.ok(/select solution/i.test(message), `and offers the remedy: ${message}`);
    assert.equal(rows[0]?.children.size, 0, 'the error row is a leaf');
    assert.deepStrictEqual(
      collectLeafIds(api.testController.items).filter((id) => id === EXPECTED_ID),
      [],
      'and no test is invented for a solution that enumerated none',
    );

    // 3. Recovery, over the SAME project: a solution `dotnet` accepts still
    //    enumerates. The refusal must be read off the diagnostic alone, so an
    //    ordinary solution can never be mistaken for one.
    const recovered = await createSolution(root, 'Recovered', [project]);
    const ids = await discoverSolution(api, recovered, [EXPECTED_ID]);
    assert.ok(ids.includes(EXPECTED_ID), `the test the refusal lost is back: ${ids.join(' | ')}`);
    assert.deepStrictEqual(
      rootsOf(api.testController.items)
        .filter((row) => row.error !== undefined)
        .map((row) => row.label),
      [],
      'and the error row is gone',
    );
  });
});

/** A library with no test of any kind — something to enumerate and find nothing in. */
const LIBRARY_SOURCE =
  'namespace Core;\n\npublic static class Calculator\n{\n    public static int Add(int a, int b) => a + b;\n}\n';

/**
 * Two packages with published advisories, audited at the lowest level so the
 * warning is certain to fire. Real versions and real advisories: a synthetic
 * warning would not prove the listing path forwards the shape NuGet emits.
 */
const VULNERABLE_PACKAGES = [
  { id: 'System.Net.Http', version: '4.3.0' },
  { id: 'System.Text.RegularExpressions', version: '4.3.0' },
];

/** The listing command discovery runs, verbatim — for asserting a test's premise. */
const LISTING_ARGS = [
  'test',
  '--list-tests',
  '--nologo',
  '--verbosity',
  'quiet',
  '-p:VsTestUseMSBuildOutput=false',
];

suite('Test Explorer e2e — a refusal is told apart from an ordinary diagnostic', () => {
  let api: SharpLspExtensionApi;
  let parent: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    ({ api, root: parent } = await activateWithScratch('sharplsp-refusal-kinds-'));
  });

  teardown(async () => {
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
  });

  suiteTeardown(() => {
    removeDirRecursive(parent);
  });

  test('a healthy solution carrying a package advisory keeps its truthful empty tree', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);

    // A library solution with a REAL NU1903 advisory. It has no test, which is
    // the truth, and it restored and built perfectly well — so the empty tree
    // is the right answer and an error row would be a lie about a healthy
    // solution. The first cut of the refusal classifier treated every warning
    // as a refusal and turned exactly this into "Test discovery failed".
    const root = path.join(parent, 'advisory');
    writeProject(
      path.join(root, 'Core'),
      'Core.csproj',
      buildProjectXml({
        packages: VULNERABLE_PACKAGES,
        properties: { NuGetAudit: 'true', NuGetAuditLevel: 'low' },
      }),
      'Calculator.cs',
      LIBRARY_SOURCE,
    );
    const solution = await createSolution(root, 'Advisory', [path.join(root, 'Core')]);

    // The premise, asserted rather than assumed: this listing really does carry
    // a coded NuGet warning. Without this the test would still pass on a
    // machine where the advisory never fired, and would prove nothing at all.
    const output = await dotnet([...LISTING_ARGS, solution], root);
    assert.ok(
      output.includes(': warning NU'),
      `the fixture must actually emit a coded NuGet warning, got: ${output.slice(0, 400)}`,
    );

    const listing = await listTests(solution);
    assert.equal(
      listing.ok,
      true,
      `a solution that restored and built is a truthful empty answer: ${listing.warnings.join('\n')}`,
    );
    assert.deepStrictEqual([...listing.names], [], 'and it lists nothing, because it has nothing');
    assert.deepStrictEqual([...listing.warnings], [], 'and an advisory is not a discovery failure');

    // And in the view: no row at all, not an error row.
    await api.explorerProvider.loadSolution(solution);
    await drainDiscovery(() => {
      api.testController.items.replace([]);
    }, api.testController);
    await api.testController.activateAndDiscover();
    await api.testController.whenIdle();
    const rows = rootsOf(api.testController.items);
    assert.deepStrictEqual(
      rows.map((row) => `${row.label}: ${errorTextOf(row)}`),
      [],
      'the Testing view shows no row for a healthy solution with no test',
    );
  });

  test('the classifier separates a refusal from a report about a project that built', function () {
    // Verbatim lines from real `dotnet test --list-tests` runs on SDK 10.0.303.
    const refusal =
      '/Users/x/.dotnet/sdk/10.0.303/NuGet.targets(198,5): warning : ' +
      'Unable to find a project to restore! [/tmp/Refused.sln]';
    const advisory =
      "/tmp/Core/Core.csproj : warning NU1903: Package 'System.Net.Http' 4.3.0 has a " +
      'known high severity vulnerability, https://github.com/advisories/GHSA-7jgj-8wvc-jh57 ' +
      '[/tmp/Vuln.slnx]';
    const pruning =
      '/tmp/Core/Core.csproj : warning NU1510: PackageReference System.Net.Http will not ' +
      'be pruned. Consider removing this package from your dependencies, as it is likely ' +
      'unnecessary. [/tmp/Vuln.slnx]';
    const compileError =
      '/tmp/Core/Calculator.cs(4,17): error CS1002: ; expected [/tmp/Core.csproj]';
    const ambiguous =
      'MSBUILD : error MSB1011: Specify which project or solution file to use because ' +
      'this folder contains more than one project or solution file.';

    // A BARE warning is the build system saying it did nothing.
    assert.deepStrictEqual(parseListingDiagnostics(refusal), [refusal], 'a bare warning refuses');
    // A CODED warning is a report about a project that WAS processed.
    assert.deepStrictEqual(parseListingDiagnostics(advisory), [], 'an advisory does not refuse');
    assert.deepStrictEqual(parseListingDiagnostics(pruning), [], 'nor does a pruning hint');
    // Errors always refuse, coded or not.
    assert.deepStrictEqual(
      parseListingDiagnostics(compileError),
      [compileError],
      'CS error refuses',
    );
    assert.deepStrictEqual(parseListingDiagnostics(ambiguous), [ambiguous], 'MSB error refuses');

    // Mixed output: the refusal is found among reports that must be ignored,
    // and a repeated line is reported once.
    const mixed = [advisory, pruning, refusal, advisory, 'Test run for /tmp/x.dll (net10.0)'].join(
      '\n',
    );
    assert.deepStrictEqual(parseListingDiagnostics(mixed), [refusal], 'only the refusal survives');
    assert.deepStrictEqual(parseListingDiagnostics(''), [], 'empty output has no diagnostic');
    assert.deepStrictEqual(
      parseListingDiagnostics('Cs.Fixtures.Tests.Adds_TwoNumbers'),
      [],
      'a test name is never a diagnostic',
    );
  });
});
