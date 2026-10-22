// Implements [TEST-REACTIVITY-BUILD]: real builds update the tree without revealing it.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { joinPath } from '../../paths';
import {
  createSolution,
  dotnet,
  projectXml,
  writeProject,
  XUNIT_PACKAGES,
  MTP_XUNIT_PACKAGES,
  mtpProjectXml,
  writeMtpGlobalJson,
  writeBuildCounter,
  buildsLogged,
} from './dotnet-project-kit';
import {
  activateWithScratch,
  pollUntilDiscovered,
  teardownFixtureSolution,
  collectLeafIds,
} from './test-explorer-kit';
import { removeDirRecursive, sleep } from './test-helpers';
import { evaluateProject } from '../../msbuild';
import { FIXTURE_BUILD_MS } from './test-timeouts';

const FIXTURES = [
  {
    language: 'F#',
    project: 'RefreshFs.fsproj',
    source: 'Tests.fs',
    xml: projectXml(XUNIT_PACKAGES, 'Tests.fs'),
    before: 'module RefreshFs.Tests\nopen Xunit\n[<Fact>]\nlet First () = Assert.True(true)\n',
    after: 'module RefreshFs.Tests\nopen Xunit\n[<Fact>]\nlet Second () = Assert.True(true)\n',
    first: 'RefreshFs.Tests.First',
    second: 'RefreshFs.Tests.Second',
  },
  {
    language: 'C#',
    project: 'RefreshCs.csproj',
    source: 'Tests.cs',
    xml: projectXml(XUNIT_PACKAGES),
    before:
      'namespace RefreshCs; public class Tests { [Xunit.Fact] public void First() => Xunit.Assert.True(true); }',
    after:
      'namespace RefreshCs; public class Tests { [Xunit.Fact] public void Second() => Xunit.Assert.True(true); }',
    first: 'RefreshCs.Tests.First',
    second: 'RefreshCs.Tests.Second',
  },
] as const;

suite('Test Explorer — build completion refresh', () => {
  for (const runner of ['VSTest', 'MTP', 'MTP opt-in'] as const) {
    for (const fixture of FIXTURES) {
      test(`${runner} ${fixture.language}: extension build populates an unopened tree, external rebuild replaces it`, async function () {
        this.timeout(FIXTURE_BUILD_MS);
        const { api, root } = await activateWithScratch('slsp-build-refresh-');
        try {
          const project = writeProject(
            root,
            fixture.project,
            runner === 'VSTest'
              ? fixture.xml
              : mtpProjectXml(
                  MTP_XUNIT_PACKAGES,
                  ...(fixture.language === 'F#' ? ['Tests.fs'] : []),
                ),
            fixture.source,
            fixture.before,
          );
          if (runner === 'MTP opt-in') writeMtpGlobalJson(root);
          const builds = writeBuildCounter(root);
          const solution = await createSolution(root, 'Refresh', [project]);
          await api.explorerProvider.loadSolution(solution);
          await vscode.commands.executeCommand('sharplsp.build', { projectFilePath: solution });
          const first = await pollUntilDiscovered(api.testController, [fixture.first], 30_000);
          assert.ok(!first.includes(fixture.second), 'only the first compiled test exists');
          assert.ok(
            api.testController.items.size > 0,
            'the tree populated without manual discovery',
          );
          assert.equal(
            buildsLogged(builds).length,
            1,
            'initial discovery does not start another build',
          );
          fs.writeFileSync(joinPath(root, fixture.source), fixture.after);
          await sleep(750);
          assert.ok(
            collectLeafIds(api.testController.items).includes(fixture.first),
            'source edits alone keep the compiled tree',
          );
          assert.ok(
            !collectLeafIds(api.testController.items).includes(fixture.second),
            'unbuilt tests are not published',
          );
          await dotnet(['build', solution, '--no-restore'], root);
          const second = await pollUntilDiscovered(api.testController, [fixture.second], 30_000);
          assert.ok(!second.includes(fixture.first), 'the removed test leaves the tree');
          assert.equal(
            second.filter((id) => id === fixture.second).length,
            1,
            'no duplicate tests',
          );
          const output = await evaluateProject(joinPath(root, fixture.project));
          assert.ok(output.ok, 'MSBuild locates the actual output');
          const modified = fs.statSync(output.value.targetPath).mtimeMs;
          await sleep(1_500);
          await api.testController.whenIdle();
          assert.equal(
            fs.statSync(output.value.targetPath).mtimeMs,
            modified,
            'discovery does not rewrite compiler outputs',
          );
          assert.deepEqual(
            collectLeafIds(api.testController.items),
            second,
            'the settled tree does not feed back into discovery',
          );
          assert.equal(buildsLogged(builds).length, 2, 'only the two requested builds ran');
        } finally {
          await teardownFixtureSolution(api, root, removeDirRecursive);
        }
      });
    }
  }
});
