// Implements [TEST-RUN-OUTPUT] and [TEST-BUILD-GRAPH]. Published regression #574.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension';
import { joinPath } from '../../paths';
import { createSolution, projectBuilder, writeMtpGlobalJson } from './dotnet-project-kit';
import { MTP_FIXTURES, writeMtpProject, type MtpFixture } from './test-explorer-mtp-fixtures';
import {
  activateWithScratch,
  discoverSolution,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { cachedFor, runIds } from './test-explorer-outcome-assertions';
import { observeRuns, RUN_OUTPUT } from './test-output-kit';
import { removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS } from './test-timeouts';

const MARKER = 'SHARPLSP_RELEASE_PREFLIGHT_OUTPUT_SENTINEL';

function failBuild(root: string): string {
  const file = joinPath(root, 'Directory.Build.targets');
  const xml = projectBuilder.build({
    Project: {
      Target: {
        '@_Name': 'ReleasePreflightFailure',
        '@_BeforeTargets': 'BeforeBuild',
        Error: { '@_Text': MARKER, '@_Code': 'SLSP9999', '@_File': 'Preflight.txt' },
      },
    },
  });
  fs.writeFileSync(file, xml, 'utf8');
  return file;
}

async function buildErrorOutput(api: SharpLspExtensionApi, id: string): Promise<string[]> {
  const observer = observeRuns(api.testController.testing);
  try {
    for (const kind of [vscode.TestRunProfileKind.Run, vscode.TestRunProfileKind.Coverage]) {
      await runIds(api, kind, [id]);
      await api.testController.whenIdle();
      const record = observer.runs.at(-1);
      assert.ok(record);
      await record.ended;
      assert.equal(record.verdicts.get(id), 'errored');
      assert.equal(cachedFor(api, id).outcome, 'notRun');
      assert.ok(cachedFor(api, id).message?.includes(MARKER));
    }
    assert.equal(observer.runs.length, 2);
    return observer.runs.map((run) => run.output.get(RUN_OUTPUT) ?? '');
  } finally {
    observer.dispose();
  }
}

async function exercise(
  api: SharpLspExtensionApi,
  root: string,
  fixture: MtpFixture,
): Promise<void> {
  await runIds(api, vscode.TestRunProfileKind.Run, [fixture.passing]);
  assert.equal(cachedFor(api, fixture.passing).outcome, 'passed');
  const target = failBuild(root);
  const outputs = await buildErrorOutput(api, fixture.passing);
  fs.unlinkSync(target);
  await runIds(api, vscode.TestRunProfileKind.Run, [fixture.passing]);
  assert.equal(cachedFor(api, fixture.passing).outcome, 'passed', 'repair runs fresh tests');
  for (const output of outputs) {
    assert.ok(output.includes(MARKER), JSON.stringify(outputs));
    assert.ok(output.includes('SLSP9999'));
    assert.ok(output.includes('Preflight.txt'));
  }
}

async function scenario(fixture: MtpFixture, optIn: boolean): Promise<void> {
  const { api, root } = await activateWithScratch('slsp-preflight-output-');
  try {
    if (optIn) writeMtpGlobalJson(root);
    const project = writeMtpProject(root, fixture);
    const solution = await createSolution(root, 'Preflight', [project]);
    await discoverSolution(api, solution, [fixture.passing]);
    await exercise(api, root, fixture);
  } finally {
    await teardownFixtureSolution(api, root, removeDirRecursive);
  }
}

suite('Released MTP build failure output', () => {
  for (const fixture of MTP_FIXTURES.filter((item) => item.framework === 'xunit')) {
    for (const optIn of [false, true]) {
      test(`${fixture.language} SDK opt-in ${String(optIn)} keeps build errors in run output`, async function () {
        this.timeout(FIXTURE_BUILD_MS);
        await scenario(fixture, optIn);
      });
    }
  }
});
