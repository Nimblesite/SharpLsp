// Implements [TEST-BUILD-GRAPH]: selected tests build only their real dependency graph.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension';
import { joinPath, samePath } from '../../paths';
import { findCoberturaFiles, parseCoberturaXml } from '../../test-coverage';
import { FrameworkIndex } from '../../test-frameworks';
import { projectsOfTests, runAssemblies } from '../../test-framework-runs';
import * as state from '../../state';
import { listLocatedTests } from '../../test-source-locations';
import { runnersFor, runRouted } from '../../test-run-routes';
import type { CachedTestResult } from '../../testing';
import {
  buildProjectXml,
  createSolution,
  writeProject,
  XUNIT_PACKAGES,
  MTP_XUNIT_PACKAGES,
  MTP_PROPERTIES,
  writeMtpGlobalJson,
  writeBuildCounter,
  buildsLogged,
} from './dotnet-project-kit';
import {
  activateWithScratch,
  DISCOVERY_SETTLE_MS,
  discoverSolution,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { assertFailed, assertPassed, cachedFor, runIds } from './test-explorer-outcome-assertions';
import { COVERAGE_DIR_NAME, COVERLET_PACKAGE, MTP_CODE_COVERAGE } from './test-coverage-fixtures';
import { removeDirRecursive, sleep } from './test-helpers';
import { FIXTURE_BUILD_MS } from './test-timeouts';

const LIBRARY =
  'namespace GraphLib; public static class Value { public static int Current() => 1; }';
const CASES = [
  {
    language: 'F#',
    project: 'Selected.fsproj',
    file: 'Tests.fs',
    id: 'Selected.Tests.Fresh',
    source:
      'module Selected.Tests\nopen Xunit\n[<Fact>]\nlet Fresh () = Assert.Equal(1, GraphLib.Value.Current())\n',
  },
  {
    language: 'C#',
    project: 'Selected.csproj',
    file: 'Tests.cs',
    id: 'Selected.Tests.Fresh',
    source:
      'namespace Selected; public class Tests { [Xunit.Fact] public void Fresh() => Xunit.Assert.Equal(1, GraphLib.Value.Current()); }',
  },
] as const;

/** Compilation errors must replace previous verdicts without claiming a test executed. */
function assertGraphBuildError(result: CachedTestResult): void {
  assert.equal(result.outcome, 'notRun', 'build failure never reports a stale verdict');
  assert.equal(result.passed, false);
  assert.match(result.message ?? '', /error|build/iu, 'the user sees the compilation failure');
  assert.match(result.message ?? '', /Value\.cs/u, 'the build error names the referenced source');
  assert.match(result.message ?? '', /error CS\d+/u, 'the compiler diagnostic survives reporting');
}

/** Exercise the Testing view's actual handler, and assert its full cached verdict. */
async function runGraphProfile(
  api: SharpLspExtensionApi,
  id: string,
  kind: vscode.TestRunProfileKind,
  expected: 'passed' | 'failed' | 'notRun',
): Promise<void> {
  const unrelated = api.testController.getResult('Other.Unselected');
  await runIds(api, kind, [id]);
  await api.testController.whenIdle();
  const result = cachedFor(api, id);
  if (expected === 'passed') assertPassed(result, id);
  else if (expected === 'failed') assertFailed(result, id);
  else assertGraphBuildError(result);
  assert.deepEqual(api.testController.getResult('Other.Unselected'), unrelated);
}

/** A coverage gesture must report the actual referenced library that was executed. */
function assertGraphCoverage(root: string, libraryFile: string): void {
  const reports = findCoberturaFiles(joinPath(root, COVERAGE_DIR_NAME));
  assert.equal(reports.length, 1, 'only the selected project collects coverage');
  const files = reports.flatMap(parseCoberturaXml);
  assert.ok(
    files.some(
      (file) => samePath(file.uri.fsPath, libraryFile) && file.statementCoverage.covered > 0,
    ),
    'the freshly built project reference was actually covered',
  );
}

suite('Incremental test build graph', () => {
  for (const runner of ['VSTest', 'MTP', 'MTP opt-in'] as const) {
    for (const fixture of CASES) {
      test(`${runner} ${fixture.language}: selected graph stays fresh without compiling an unrelated broken project`, async function () {
        this.timeout(FIXTURE_BUILD_MS);
        const { api, root } = await activateWithScratch('slsp-test-graph-');
        const previous = state.client.value;
        state.client.value = api.getLspClient();
        try {
          if (runner === 'MTP opt-in') writeMtpGlobalJson(root);
          const packages =
            runner === 'VSTest'
              ? [...XUNIT_PACKAGES, COVERLET_PACKAGE]
              : [...MTP_XUNIT_PACKAGES, MTP_CODE_COVERAGE];
          const properties = runner === 'VSTest' ? {} : MTP_PROPERTIES;
          const libraryRoot = joinPath(root, 'Library');
          const selectedRoot = joinPath(root, 'Selected');
          const otherRoot = joinPath(root, 'Unrelated');
          for (const dir of [libraryRoot, selectedRoot, otherRoot]) fs.mkdirSync(dir);
          const library = writeProject(
            libraryRoot,
            'Library.csproj',
            buildProjectXml({}),
            'Value.cs',
            LIBRARY,
          );
          const other = writeProject(
            otherRoot,
            'Unrelated.csproj',
            buildProjectXml({ packages, properties }),
            'Other.cs',
            'public class Other { [Xunit.Fact] public void Unselected() => Xunit.Assert.True(true); }',
          );
          writeProject(
            selectedRoot,
            fixture.project,
            buildProjectXml({
              packages,
              properties,
              projectReferences: ['../Library/Library.csproj'],
              compileIncludes: fixture.language === 'F#' ? [fixture.file] : [],
            }),
            fixture.file,
            fixture.source,
          );
          const selected = joinPath(selectedRoot, fixture.project);
          const solution = await createSolution(root, 'Graph', [library, selected, other]);
          const counter = writeBuildCounter(root);
          const listing = await listLocatedTests(solution);
          assert.equal(listing.ok, true, listing.warnings.join('\n'));
          assert.ok(listing.names.includes(fixture.id), 'selection came from real discovery');
          const runners = runnersFor([listing]);
          const projects = projectsOfTests(new FrameworkIndex(listing.byAssembly), [fixture.id]);
          assert.equal(projects.length, 1, 'discovery records one owning project');
          assert.ok(
            samePath(projects[0] ?? '', selected),
            `ownership comes from workspace metadata: ${JSON.stringify({ projects, selected })}`,
          );
          await discoverSolution(api, solution, [fixture.id, 'Other.Unselected']);
          await sleep(DISCOVERY_SETTLE_MS);
          await api.testController.whenIdle();
          const run = async () =>
            await runRouted(runners, [fixture.id], root, { target: solution });
          const assembly = joinPath(selectedRoot, 'bin', 'Debug', 'net10.0', 'Selected.dll');
          const stamp = fs.statSync(assembly).mtimeMs;
          fs.writeFileSync(
            joinPath(otherRoot, 'Other.cs'),
            'this is deliberately not compilable C#',
          );
          fs.writeFileSync(counter, '');
          const unchanged = await run();
          assert.equal(unchanged.results.get(fixture.id)?.outcome, 'passed', unchanged.output);
          assert.equal(
            unchanged.failure,
            undefined,
            'unrelated errors cannot block selected tests',
          );
          assert.equal(
            fs.statSync(assembly).mtimeMs,
            stamp,
            'incremental build preserves unchanged output',
          );
          assert.ok(
            !buildsLogged(counter).includes('Unrelated'),
            'unrelated project is never built',
          );
          await runGraphProfile(api, fixture.id, vscode.TestRunProfileKind.Run, 'passed');
          assert.equal(fs.statSync(assembly).mtimeMs, stamp, 'the Run gesture stays incremental');
          if (runner === 'VSTest') {
            const framework = await runAssemblies(
              ['net10.0'],
              [fixture.id],
              root,
              { target: solution },
              projects,
            );
            assert.equal(framework.results.get(fixture.id)?.outcome, 'passed', framework.output);
            assert.equal(
              fs.statSync(assembly).mtimeMs,
              stamp,
              'framework runs preserve unchanged output',
            );
            assert.ok(
              !buildsLogged(counter).includes('Unrelated'),
              'framework runs exclude unrelated graphs',
            );
          }
          fs.writeFileSync(
            joinPath(libraryRoot, 'Value.cs'),
            'namespace GraphLib; public static class Value { public static int Current() => 2; }',
          );
          const changed = await run();
          assert.equal(
            changed.results.get(fixture.id)?.outcome,
            'failed',
            'changed dependency is rebuilt before execution',
          );
          assert.equal(changed.results.size, 1, 'only the selected test runs');
          assert.ok(
            buildsLogged(counter).includes('Library'),
            'project references participate in the incremental build',
          );
          await runGraphProfile(api, fixture.id, vscode.TestRunProfileKind.Coverage, 'failed');
          assertGraphCoverage(root, joinPath(libraryRoot, 'Value.cs'));
          fs.writeFileSync(joinPath(libraryRoot, 'Value.cs'), 'deliberately broken dependency');
          const broken = await run();
          assert.equal(
            broken.results.size,
            0,
            'never execute stale assemblies after build failure',
          );
          assert.ok(broken.failure, 'build failure is reported');
          await runGraphProfile(api, fixture.id, vscode.TestRunProfileKind.Run, 'notRun');
          await runGraphProfile(api, fixture.id, vscode.TestRunProfileKind.Coverage, 'notRun');
          assert.deepEqual(
            findCoberturaFiles(joinPath(root, COVERAGE_DIR_NAME)),
            [],
            'a failed build cannot publish an earlier coverage report',
          );
          fs.writeFileSync(joinPath(libraryRoot, 'Value.cs'), LIBRARY);
          const repaired = await run();
          assert.equal(repaired.results.get(fixture.id)?.outcome, 'passed', repaired.output);
          assert.equal(repaired.failure, undefined, 'a repaired dependency can run again');
          await runGraphProfile(api, fixture.id, vscode.TestRunProfileKind.Coverage, 'passed');
          assertGraphCoverage(root, joinPath(libraryRoot, 'Value.cs'));
          assert.ok(
            !buildsLogged(counter).includes('Unrelated'),
            'unrelated graph stays excluded across every run',
          );
        } finally {
          state.client.value = previous;
          await teardownFixtureSolution(api, root, removeDirRecursive);
        }
      });
    }
  }
});
