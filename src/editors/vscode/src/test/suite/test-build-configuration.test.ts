// Implements [TEST-BUILD-CONFIGURATION]: real projects whose own default is Release.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { joinPath } from '../../paths';
import { listTests } from '../../test-discovery';
import { runTests } from '../../test-execution';
import { runMtpTests } from '../../test-mtp-run';
import { runAssemblies } from '../../test-framework-runs';
import * as state from '../../state';
import {
  buildProjectXml,
  writeProject,
  XUNIT_PACKAGES,
  MTP_XUNIT_PACKAGES,
  MTP_PROPERTIES,
  writeMtpGlobalJson,
} from './dotnet-project-kit';
import { activateWithScratch, teardownFixtureSolution } from './test-explorer-kit';
import { removeDirRecursive } from './test-helpers';
import { FIXTURE_BUILD_MS } from './test-timeouts';

const CASES = [
  {
    language: 'F#',
    project: 'Configured.fsproj',
    file: 'Tests.fs',
    id: 'Configured.Tests.BuildMode',
    source:
      'module Configured.Tests\nopen Xunit\n[<Fact>]\nlet BuildMode () =\n#if DEBUG\n  Assert.True(true)\n#else\n  Assert.Fail("User test assembly was compiled in Release")\n#endif\n',
  },
  {
    language: 'C#',
    project: 'Configured.csproj',
    file: 'Tests.cs',
    id: 'Configured.Tests.BuildMode',
    source:
      'namespace Configured; public class Tests { [Xunit.Fact] public void BuildMode() {\n#if DEBUG\nXunit.Assert.True(true);\n#else\nXunit.Assert.Fail("User test assembly was compiled in Release");\n#endif\n} }',
  },
] as const;

/** Framework profiles must resolve the configured output again after each change. */
async function assertFrameworkOutcome(
  project: string,
  root: string,
  id: string,
  expected: 'passed' | 'failed',
): Promise<void> {
  const outcome = await runAssemblies(['net10.0'], [id], root, { target: project }, [project]);
  assert.equal(outcome.results.get(id)?.outcome, expected, outcome.output);
}

suite('Test build configuration', () => {
  for (const runner of ['VSTest', 'MTP', 'MTP opt-in'] as const) {
    for (const fixture of CASES) {
      test(`${runner} ${fixture.language}: discovery and execution override a Release project default with Debug`, async function () {
        this.timeout(FIXTURE_BUILD_MS);
        const { api, root } = await activateWithScratch('slsp-test-config-');
        const previous = state.client.value;
        state.client.value = api.getLspClient();
        assert.ok(state.client.value, 'configuration is resolved by the real LSP');
        try {
          if (runner === 'MTP opt-in') writeMtpGlobalJson(root);
          const xml = buildProjectXml({
            packages: runner === 'VSTest' ? XUNIT_PACKAGES : MTP_XUNIT_PACKAGES,
            compileIncludes: fixture.language === 'F#' ? [fixture.file] : [],
            properties: {
              ...(runner === 'VSTest' ? {} : MTP_PROPERTIES),
              Configuration: 'Release',
            },
          });
          const project = writeProject(root, fixture.project, xml, fixture.file, fixture.source);
          const listing = await listTests(project);
          const execute = async (debug = false) =>
            listing.mtp === undefined
              ? await runTests([fixture.id], root, { target: project, debug })
              : await runMtpTests(listing.mtp, [fixture.id], root, { target: project });
          assert.equal(listing.ok, true, listing.warnings.join('\n'));
          assert.deepEqual(listing.names, [fixture.id], 'the real test is discovered exactly once');
          assert.ok(
            fs.existsSync(joinPath(root, 'bin', 'Debug', 'net10.0', 'Configured.dll')),
            'discovery builds Debug despite project default',
          );
          const outcome = await execute();
          assert.equal(outcome.failure, undefined, outcome.output);
          assert.equal(outcome.results.size, 1, 'the selected test reports exactly one result');
          assert.equal(outcome.results.get(fixture.id)?.outcome, 'passed', outcome.output);
          assert.equal(outcome.retriedUnfiltered, false, 'configuration requires no fallback run');
          const config = joinPath(root, 'sharplsp.toml');
          fs.writeFileSync(config, '[testing]\nconfiguration = "Release"\n');
          const release = await execute();
          assert.equal(
            release.results.get(fixture.id)?.outcome,
            'failed',
            'explicit Release runs the actual Release assembly',
          );
          assert.match(release.output, /User test assembly was compiled in Release/);
          assert.ok(fs.existsSync(joinPath(root, 'bin', 'Release', 'net10.0', 'Configured.dll')));
          if (runner === 'VSTest') {
            await assertFrameworkOutcome(project, root, fixture.id, 'failed');
          }
          fs.writeFileSync(config, '[testing]\nconfiguration = "Debug"\n');
          const debug = await execute(true);
          assert.equal(debug.results.get(fixture.id)?.outcome, 'passed', debug.output);
          assert.equal(
            debug.failure,
            undefined,
            'Debug profile uses the changed configuration immediately',
          );
          assert.equal(debug.results.size, 1, 'changing configuration does not duplicate results');
          if (runner === 'VSTest') {
            await assertFrameworkOutcome(project, root, fixture.id, 'passed');
          }
        } finally {
          state.client.value = previous;
          await teardownFixtureSolution(api, root, removeDirRecursive);
        }
      });
    }
  }
});
