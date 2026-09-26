// Release regressions #298/#299, with real C# and F# MTP projects.
// Implements [TEST-MTP-RUN], [TEST-MTP-MODULES], [TEST-MTP-DISCOVERY].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension';
import type { MtpRunPlan } from '../../test-listing-model';
import { listMtpTests } from '../../test-mtp-discovery';
import { runMtpTests } from '../../test-mtp-run';
import {
  buildProjectXml,
  createSolution,
  MTP_PROPERTIES,
  MTP_XUNIT_PACKAGES,
  writeMtpGlobalJson,
  writeProject,
} from './dotnet-project-kit';
import {
  clearTestTree,
  collectLeafIds,
  discoverSolution,
  findItem,
  runViaProfile,
  teardownFixtureSolution,
  activateWithScratch,
} from './test-explorer-kit';
import { removeDirRecursive, requireAt } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** The output identity every test starts from. */
const ORIGINAL: Readonly<Record<string, string>> = { OutputPath: 'bin/Original/' };

for (const language of ['fsharp', 'csharp'] as const) {
  suite(`MTP release regressions — ${language}`, () => {
    let api: SharpLspExtensionApi;
    let root: string;
    let solution: string;
    const fsharp = language === 'fsharp';
    const project = fsharp ? 'ReleaseMtpFs.fsproj' : 'ReleaseMtpCs.csproj';
    const sourceFile = fsharp ? 'Tests.fs' : 'Tests.cs';
    const id = fsharp
      ? 'Mtp.Release.Fixtures.passes with spaces'
      : 'Mtp.Release.Fixtures.Checks.Passes';

    /** Whole source variants; no textual surgery on C# or F# code. */
    function source(expected: number | undefined): string {
      if (fsharp)
        return expected === undefined
          ? 'module Mtp.Release.Fixtures\nlet placeholder = 1\n'
          : `module Mtp.Release.Fixtures\nopen Xunit\n[<Fact>]\nlet \`\`passes with spaces\`\` () = Assert.Equal(${String(expected)}, 1 + 2)\n`;
      return expected === undefined
        ? 'namespace Mtp.Release.Fixtures; public class Checks {}\n'
        : `using Xunit; namespace Mtp.Release.Fixtures; public class Checks { [Fact] public void Passes() => Assert.Equal(${String(expected)}, 1 + 2); }\n`;
    }

    /** The whole project, rewritten: output identity in `properties`. */
    function write(
      expected: number | undefined,
      properties: Readonly<Record<string, string>>,
      dir: string = path.join(root, 'Tests'),
    ): string {
      return writeProject(
        dir,
        project,
        buildProjectXml({
          packages: MTP_XUNIT_PACKAGES,
          compileIncludes: fsharp ? [sourceFile] : [],
          properties: { ...MTP_PROPERTIES, ...properties },
        }),
        sourceFile,
        source(expected),
      );
    }

    /**
     * Run `selection` through a plan discovered BEFORE the edit; the edited assertion must
     * fail, and `obsoleteModule` checks what became of the module that plan names.
     */
    async function assertEditedAssertionRuns(
      plan: MtpRunPlan,
      why: string,
      obsoleteModule: () => void,
    ): Promise<void> {
      for (const selection of [[id], []]) {
        const result = await runMtpTests(plan, selection, root);
        assert.equal(result.results.get(id)?.outcome, 'failed', why);
        assert.match(
          result.results.get(id)?.message ?? '',
          /Expected: 4/,
          'the new assertion, not a build failure, must explain the red result',
        );
        assert.equal(
          result.retriedUnfiltered,
          false,
          'no retry is needed to select the current module',
        );
        obsoleteModule();
      }
    }

    suiteSetup(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      ({ api, root } = await activateWithScratch('sharplsp-mtp-release-'));
      writeMtpGlobalJson(root);
      solution = await createSolution(root, 'ReleaseMtp', [write(3, ORIGINAL)]);
      assert.equal(
        (await listMtpTests(solution, root)).ok,
        true,
        'the initial project builds and lists',
      );
    });

    suiteTeardown(async function () {
      this.timeout(DOTNET_CLI_MS);
      await teardownFixtureSolution(api, root, removeDirRecursive);
    });

    test('an output-path edit never runs the obsolete passing DLL, filtered or unfiltered', async function () {
      this.timeout(DOTNET_CLI_MS);
      const discovery = await listMtpTests(solution, root);
      assert.ok(discovery.mtp, 'discovery returns an actual MTP run plan');
      assert.deepEqual(discovery.names, [id], 'the language-specific test id is discovered');
      const obsolete = requireAt(discovery.mtp.modules, 0, 'the original module').modulePath;
      const first = await runMtpTests(discovery.mtp, [id], root);
      assert.equal(first.results.get(id)?.outcome, 'passed', 'the original DLL really passes');
      const originalBytes = fs.readFileSync(obsolete);
      write(4, { OutputPath: 'bin/Changed/' });
      assert.equal(
        fs.existsSync(obsolete),
        true,
        'the obsolete DLL stays on disk throughout the repro',
      );
      await assertEditedAssertionRuns(
        discovery.mtp,
        'the OLD discovery plan must run the EDITED assertion after OutputPath changes',
        () => {
          assert.deepEqual(
            fs.readFileSync(obsolete),
            originalBytes,
            'the old DLL was not overwritten or removed to hide the bug',
          );
        },
      );
      const fresh = await listMtpTests(solution, root);
      assert.ok(fresh.mtp);
      assert.notEqual(
        requireAt(fresh.mtp.modules, 0, 'the current module').modulePath,
        obsolete,
        'MSBuild now names a different DLL',
      );
      assert.deepEqual(fresh.names, [id], 'moving the output never changes the test identity');
    });

    test('an AssemblyName edit runs the renamed module, never the one the old plan names', async function () {
      this.timeout(DOTNET_CLI_MS);
      write(3, ORIGINAL);
      const discovery = await listMtpTests(solution, root);
      assert.ok(discovery.mtp, 'discovery returns an actual MTP run plan');
      const obsolete = requireAt(discovery.mtp.modules, 0, 'the original module').modulePath;
      const first = await runMtpTests(discovery.mtp, [id], root);
      assert.equal(first.results.get(id)?.outcome, 'passed', 'the original DLL really passes');
      write(4, { ...ORIGINAL, AssemblyName: 'RenamedReleaseMtp' });
      await assertEditedAssertionRuns(
        discovery.mtp,
        'the OLD discovery plan must run the EDITED assertion after AssemblyName changes',
        () => {
          // Unlike a moved output, a renamed assembly shares its output folder with the old
          // name, and MSBuild's incremental clean deletes that old name when it builds. The
          // module the old plan names is gone, so only the renamed one can have run.
          assert.equal(fs.existsSync(obsolete), false, 'the build removed the obsolete module');
        },
      );
      const fresh = await listMtpTests(solution, root);
      assert.ok(fresh.mtp);
      const current = requireAt(fresh.mtp.modules, 0, 'the current module').modulePath;
      assert.equal(
        path.basename(current, path.extname(current)),
        'RenamedReleaseMtp',
        'MSBuild names the renamed DLL, in the SAME output directory as the obsolete one',
      );
      assert.equal(path.dirname(current), path.dirname(obsolete), 'only the file name moved');
      assert.deepEqual(fresh.names, [id], 'renaming the assembly never changes the test identity');
    });

    test('a valid empty listing clears removed tests and cached results, unlike failed discovery', async function () {
      this.timeout(DOTNET_CLI_MS);
      write(3, ORIGINAL);
      await discoverSolution(api, solution, [id]);
      const item = findItem(api.testController.items, id);
      assert.ok(item, 'the tree is populated before deleting tests');
      await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [item]);
      const cached = api.testController.getResult(id);
      assert.equal(cached?.outcome, 'passed', 'there is a real cached result to prune');
      fs.writeFileSync(path.join(root, 'Tests', sourceFile), 'not valid source code !', 'utf8');
      await api.testController.activateAndDiscover();
      assert.deepEqual(
        collectLeafIds(api.testController.items),
        [id],
        'a failed build preserves the previous tree',
      );
      assert.equal(
        api.testController.getResult(id),
        cached,
        'a failed build preserves the previous result',
      );

      write(undefined, ORIGINAL);
      const empty = await listMtpTests(solution, root);
      assert.equal(
        empty.ok,
        true,
        'valid schemaVersion 1 tests:[] is successful empty discovery, including MTP exit 8',
      );
      assert.deepEqual(empty.names, [], 'the rebuilt project really contains no tests');
      assert.deepEqual(empty.warnings, [], 'zero tests is not a discovery error');
      await api.testController.activateAndDiscover();
      assert.deepEqual(
        collectLeafIds(api.testController.items),
        [],
        'refresh removes the deleted test from the tree',
      );
      assert.equal(
        api.testController.getResult(id),
        undefined,
        'refresh prunes the deleted test result',
      );
      assert.equal(api.testController.items.size, 0, 'no stale assembly or error row remains');
    });

    test('a valid project that NEVER had a test opens to an empty tree, not an error row', async function () {
      this.timeout(DOTNET_CLI_MS);
      const emptyRoot = path.join(root, 'NeverTested');
      fs.mkdirSync(emptyRoot, { recursive: true });
      const emptySolution = await createSolution(emptyRoot, 'NeverTested', [
        write(undefined, ORIGINAL, path.join(emptyRoot, 'Tests')),
      ]);
      const listing = await listMtpTests(emptySolution, emptyRoot);
      assert.equal(listing.ok, true, 'the first discovery of an empty project succeeds');
      assert.deepEqual(listing.names, [], 'the project really contains no tests');
      assert.deepEqual(listing.warnings, [], 'zero tests on first open is not a discovery error');
      assert.equal(listing.mtp?.modules.length, 1, 'its one module is still planned');

      await clearTestTree(api);
      await api.explorerProvider.loadSolution(emptySolution);
      await api.testController.activateAndDiscover();
      assert.deepEqual(collectLeafIds(api.testController.items), [], 'no test leaf appears');
      assert.equal(
        api.testController.items.size,
        0,
        'no error row explains a failure that never happened',
      );
      assert.equal(api.testController.getResult(id), undefined, 'no result exists to show');
    });
  });
}
