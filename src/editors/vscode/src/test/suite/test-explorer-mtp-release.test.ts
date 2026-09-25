// Release regressions #298/#299, with real C# and F# MTP projects.
// Implements [TEST-MTP-RUN], [TEST-MTP-MODULES], [TEST-MTP-DISCOVERY].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension';
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
  collectLeafIds,
  discoverSolution,
  findItem,
  runViaProfile,
  teardownFixtureSolution,
  activateWithScratch,
} from './test-explorer-kit';
import { removeDirRecursive, requireAt } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

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

    function write(expected: number | undefined, outputPath: string): string {
      return writeProject(
        path.join(root, 'Tests'),
        project,
        buildProjectXml({
          packages: MTP_XUNIT_PACKAGES,
          compileIncludes: fsharp ? [sourceFile] : [],
          properties: { ...MTP_PROPERTIES, OutputPath: outputPath },
        }),
        sourceFile,
        source(expected),
      );
    }

    suiteSetup(async function () {
      this.timeout(FIXTURE_BUILD_MS);
      ({ api, root } = await activateWithScratch('sharplsp-mtp-release-'));
      writeMtpGlobalJson(root);
      solution = await createSolution(root, 'ReleaseMtp', [write(3, 'bin/Original/')]);
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
      write(4, 'bin/Changed/');
      assert.equal(
        fs.existsSync(obsolete),
        true,
        'the obsolete DLL stays on disk throughout the repro',
      );
      for (const selection of [[id], []]) {
        const result = await runMtpTests(discovery.mtp, selection, root);
        assert.equal(
          result.results.get(id)?.outcome,
          'failed',
          'the OLD discovery plan must run the EDITED assertion after OutputPath changes',
        );
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
        assert.deepEqual(
          fs.readFileSync(obsolete),
          originalBytes,
          'the old DLL was not overwritten or removed to hide the bug',
        );
      }
      const fresh = await listMtpTests(solution, root);
      assert.ok(fresh.mtp);
      assert.notEqual(
        requireAt(fresh.mtp.modules, 0, 'the current module').modulePath,
        obsolete,
        'MSBuild now names a different DLL',
      );
      assert.deepEqual(fresh.names, [id], 'moving the output never changes the test identity');
    });

    test('a valid empty listing clears removed tests and cached results, unlike failed discovery', async function () {
      this.timeout(DOTNET_CLI_MS);
      write(3, 'bin/Original/');
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

      write(undefined, 'bin/Original/');
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
  });
}
