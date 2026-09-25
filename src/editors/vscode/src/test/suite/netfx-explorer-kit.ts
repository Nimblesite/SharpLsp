// What the two fixture-built Test Explorer suites for .NET Framework share —
// VSTest in test-explorer-netfx.test.ts, Microsoft.Testing.Platform in
// test-explorer-mtp-netfx.test.ts — so each states only its own fixture:
// writing one multi-targeted project, picking ids by shape, ONE root per
// project, and the two sides of [NETFX-DEBUG]: a selection with no .NET
// framework refused at once, and one with a .NET framework debugged there.
//
// Observes [NETFX-TEST-DISCOVERY], [NETFX-TEST-MTP] and [NETFX-DEBUG].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { stopDebuggee } from './debug-suite-kit';
import {
  buildProjectXml,
  createSolution,
  type PackageRef,
  writeProject,
} from './dotnet-project-kit';
import { awaitLogged, loggedSince, logMark } from './netfx-test-kit';
import { DEBUG_TYPE_ID, DebugSessionRecorder } from './run-debug-kit';
import type { fixtureNames } from './test-explorer-fixtures';
import { discoverSolution, rootsOf, runViaProfile } from './test-explorer-kit';
import { assertPassed, assertReported } from './test-explorer-outcome-assertions';
import { FIXTURE_BUILD_MS } from './test-timeouts';

/**
 * The refusal [NETFX-DEBUG] quotes, after the name of what cannot be debugged:
 * the project for VSTest, the module's `.exe` for Microsoft.Testing.Platform.
 */
export const NETFX_DEBUG_REFUSAL =
  'runs on .NET Framework, and no .NET Framework debugger is bundled: Debug attaches to .NET only. ' +
  'Use Run, or debug the test under one of its .NET target frameworks.';

/** One buildable fixture project, whichever runner it uses. */
export interface MultiTargetFixture extends ReturnType<typeof fixtureNames> {
  readonly language: 'fsharp' | 'csharp';
  readonly packages: readonly PackageRef[];
  readonly source: string;
}

/** A fixture solution: its projects, the properties they share, and every id they expose. */
export interface MultiTargetSolution {
  readonly name: string;
  readonly fixtures: readonly MultiTargetFixture[];
  readonly properties: Readonly<Record<string, string>>;
  readonly expected: readonly string[];
}

/**
 * Write every project, let the `dotnet` CLI author the solution around them,
 * and discover it until every expected id is a row in the tree.
 */
export async function writeAndDiscover(
  api: SharpLspExtensionApi,
  root: string,
  solution: MultiTargetSolution,
): Promise<void> {
  const dirs = solution.fixtures.map((fixture) =>
    writeMultiTargetProject(root, fixture, solution.properties),
  );
  const file = await createSolution(root, solution.name, dirs);
  await discoverSolution(api, file, solution.expected, FIXTURE_BUILD_MS * 2);
}

/** Write `fixture` for `properties` (its frameworks among them); return its directory. */
function writeMultiTargetProject(
  root: string,
  fixture: MultiTargetFixture,
  properties: Readonly<Record<string, string>>,
): string {
  return writeProject(
    path.join(root, fixture.projectName),
    fixture.projectFileName,
    buildProjectXml({
      packages: fixture.packages,
      properties,
      compileIncludes: fixture.language === 'fsharp' ? [fixture.sourceFileName] : [],
    }),
    fixture.sourceFileName,
    fixture.source,
  );
}

/** One id per fixture, picked by the shape of test it is. */
export function idsOf<K extends string>(
  fixtures: readonly { readonly ids: Readonly<Record<K, string>> }[],
  shape: K,
): string[] {
  return fixtures.map((fixture) => fixture.ids[shape]);
}

/** The Testing view's roots are EXACTLY one per project: never one per framework or module. */
export function assertOneRootPerProject(
  api: SharpLspExtensionApi,
  fixtures: readonly { readonly projectName: string }[],
): void {
  const labels = rootsOf(api.testController.items).map((item) => item.label);
  assert.deepStrictEqual(
    [...labels].sort(),
    fixtures.map((fixture) => fixture.projectName).sort(),
    `a multi-targeted project is ONE root; the Testing view showed ${labels.join(' | ')}`,
  );
  assert.strictEqual(new Set(labels).size, labels.length, 'and no project appears twice');
}

/** ▶ on every root at once, as "Run All" does; every `passing` id then reports a pass. */
export async function runAllAndAssertPassing(
  api: SharpLspExtensionApi,
  passing: readonly string[],
): Promise<void> {
  const roots = rootsOf(api.testController.items);
  await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, roots);
  for (const id of passing) assertPassed(assertReported(api, id), id);
}

/** Record debug sessions and SharpLsp log lines around `body`, always stopping the debuggee. */
async function recordingDebug(
  api: SharpLspExtensionApi,
  body: (sessions: DebugSessionRecorder, mark: number) => Promise<void>,
): Promise<void> {
  const sessions = new DebugSessionRecorder();
  const mark = logMark(api);
  try {
    await body(sessions, mark);
  } finally {
    sessions.dispose();
    await stopDebuggee();
  }
}

/**
 * ▶ Debug on `items`, which exist only on .NET Framework: no debug session ever
 * starts, and every `refusal` is logged as a debug refusal ([NETFX-DEBUG]).
 */
export async function assertDebugRefused(
  api: SharpLspExtensionApi,
  items: readonly vscode.TestItem[],
  refusals: readonly string[],
): Promise<void> {
  await recordingDebug(api, async (sessions, mark) => {
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, items);
    assert.deepStrictEqual(
      sessions.started,
      [],
      'no .NET Framework host is ever started under Debug',
    );
    for (const refusal of refusals) {
      const lines = await awaitLogged(api, mark, refusal);
      assert.ok(
        lines.every((line) => line.includes('Test debug:')),
        `a debug refusal: ${lines.join(' | ')}`,
      );
    }
  });
}

/**
 * ▶ Debug on `items`, which some .NET framework compiles: the SharpLsp
 * debugger attaches there, and nothing is refused ([NETFX-DEBUG]).
 */
export async function assertDebugged(
  api: SharpLspExtensionApi,
  items: readonly vscode.TestItem[],
): Promise<void> {
  await recordingDebug(api, async (sessions, mark) => {
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Debug, items);
    assert.ok(sessions.started.length >= 1, 'the .NET hosts are attached to');
    assert.ok(
      sessions.started.every((session) => session.type === DEBUG_TYPE_ID),
      'by the SharpLsp debugger',
    );
    assert.deepStrictEqual(
      loggedSince(api, mark, NETFX_DEBUG_REFUSAL),
      [],
      'a selection with a .NET framework is never refused',
    );
  });
}
