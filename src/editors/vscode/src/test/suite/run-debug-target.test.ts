// Launch-target resolution and the [SCRIPT-CONE] boundary.
//
// Spec: [DEBUG-FEATURES-LAUNCH-TARGET] (docs/specs/DEBUGGING-SPEC.md), whose cone
// search reuses [SCRIPT-CONE] (docs/specs/SCRIPTING-FILEBASED-SPEC.md) verbatim.
//
// "One resolver decides what F5, Ctrl/Cmd+F5, the editor context menu and the
// Solution Explorer all launch. There MUST NOT be a second, divergent walk." So
// every case drives BOTH the exported walkers (`findProjectFile`,
// `findEntryProject`, `projectEntryFromFile`) AND the provider's
// `resolveDebugConfiguration`, and asserts the two name the same program.
//
// The headline is document sensitivity: focus Worker/Program.cs and the target is
// Worker; focus App/Program.cs and it flips back. Around it sit the .sln/.slnx and
// .git stops, the workspace-root containment boundary, the ambiguity prompt, the
// library rejection and the out-of-workspace refusal — each exercised for an
// .fsproj as well as a .csproj, because F# is a first-class citizen.
//
// Provider-level refusals are asserted with NO editor focused. A projectless `.cs`
// is a `CSharpFileBasedApp` under [SCRIPT-DETECT] and IS a legal launch target, so
// asserting "nothing resolves" while such a document is focused would be a test
// that can never pass. The cone walk itself is asserted directly instead.
//
// `registerDebugAdapter` is NEVER called: the extension registered it at
// activation and a second registration corrupts the host.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LANGS,
  Quiet,
  assertAmbiguityPrompts,
  assertBareF5Agrees,
  assertConeStops,
  assertFocusFlips,
  assertLibraryRefused,
  assertNestedTarget,
  assertOrphanRefused,
  assertSilent,
  buildConeLayout,
  clearFocus,
} from './run-debug-target-kit';
import { createSolution } from './dotnet-project-kit';
import {
  CMD_DEBUG_PROGRAM,
  DebugSessionRecorder,
  TaskRecorder,
  assertCommandRegistered,
  invokeCommand,
  stopAnyDebugSession,
} from './run-debug-kit';
import {
  closeAllEditors,
  comparablePath,
  openCSharpFile,
  openFSharpFile,
  removeDirRecursive,
} from './test-helpers';
import { DOTNET_CLI_MS, QUIET_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

suite('Run/Debug launch target — [DEBUG-FEATURES-LAUNCH-TARGET] + [SCRIPT-CONE]', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  let sessions: DebugSessionRecorder;
  let tasks: TaskRecorder;
  let q: Quiet;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-run-target-'));
    stubs = installUiStubs();
    sessions = new DebugSessionRecorder();
    tasks = new TaskRecorder();
    q = { stubs, sessions, tasks };
  });

  teardown(async () => {
    stubs.restore();
    await stopAnyDebugSession();
    sessions.dispose();
    tasks.dispose();
    await closeAllEditors();
    removeDirRecursive(tmpDir);
  });

  // B18, B19 — descend to the only runnable project, then follow the focus.
  test('the target descends into a nested project and follows the focused document', async function () {
    this.timeout(DOTNET_CLI_MS);
    for (const lang of LANGS) {
      await clearFocus();
      const root = path.join(tmpDir, lang.tag);
      const app = lang.console(path.join(root, 'src', 'App'), `${lang.tag}App`);
      assert.strictEqual(path.extname(app.projectFile), lang.projectExt, 'a real project file');
      const appDll = await assertNestedTarget(root, app, q);
      await assertBareF5Agrees(root, appDll, `B18 ${lang.projectExt} bare F5`);
      const worker = lang.console(path.join(root, 'src', 'Worker'), `${lang.tag}Worker`);
      const workerDll = await assertFocusFlips(root, app, worker, appDll);
      const backDll = await assertFocusFlips(root, worker, app, workerDll);
      assert.strictEqual(comparablePath(backDll), comparablePath(appDll), 'B19: App comes back');
      assert.notStrictEqual(comparablePath(backDll), comparablePath(workerDll), 'B19: not sticky');
      assert.deepStrictEqual(
        [path.basename(appDll), path.basename(workerDll), path.basename(backDll)],
        [`${lang.tag}App.dll`, `${lang.tag}Worker.dll`, `${lang.tag}App.dll`],
        `B19: each ${lang.projectExt} target names its own assembly, in focus order`,
      );
      await assertSilent(q, `B18/B19 ${lang.projectExt} after four resolves`, QUIET_MS);
    }
  });

  // B21, B22, B23 — the walk stops, and never escapes to a project above the cone.
  test('the cone walk stops at the workspace root, a solution and a .git', async function () {
    this.timeout(DOTNET_CLI_MS);
    for (const lang of LANGS) {
      const layout = await buildConeLayout(tmpDir, lang);
      const solution = await createSolution(layout.solutionRoot, `${lang.tag}Cone`, []);
      const kind = path.extname(solution);
      assert.strictEqual(fs.existsSync(solution), true, `${lang.tag}: the solution must exist`);
      assert.strictEqual(
        ['.sln', '.slnx'].includes(kind),
        true,
        `${lang.tag}: sln/slnx; got ${kind}`,
      );
      assert.strictEqual(fs.existsSync(layout.gitDir), true, `${lang.tag}: the .git marker exists`);
      const decoyExt = path.extname(layout.decoy.projectFile);
      assert.strictEqual(
        decoyExt,
        lang.projectExt,
        `${lang.tag}: the decoy is a ${lang.projectExt}`,
      );
      const decoyThere = fs.existsSync(layout.decoy.projectFile);
      assert.strictEqual(decoyThere, true, `${lang.tag}: without the decoy nothing is proved`);
      assert.strictEqual(
        fs.existsSync(layout.note),
        true,
        `${lang.tag}: the projectless doc exists`,
      );
      await assertConeStops(layout, q, `B21/B22/B23 ${lang.projectExt}`);
    }
  });

  // B24 — an ambiguity, never a silent pick of whatever `readdirSync` saw first.
  test('two projects in one directory prompt, and the choice decides the target', async function () {
    this.timeout(DOTNET_CLI_MS);
    for (const lang of LANGS) {
      const dir = path.join(tmpDir, `${lang.tag}amb`);
      const alpha = lang.console(dir, `${lang.tag}Alpha`);
      const zeta = lang.console(dir, `${lang.tag}Zeta`);
      const names = [path.basename(alpha.projectFile), path.basename(zeta.projectFile)];
      const onDisk = [fs.existsSync(alpha.projectFile), fs.existsSync(zeta.projectFile)];
      assert.deepStrictEqual(
        onDisk,
        [true, true],
        `${lang.tag}: both projects share one directory`,
      );
      assert.strictEqual(comparablePath(alpha.dir), comparablePath(zeta.dir), 'one directory');
      await assertAmbiguityPrompts(dir, names, zeta, q);
    }
  });

  // B27 — runnable means `<name>.runtimeconfig.json` beside `<name>.dll`.
  test('a class library is refused while a console project resolves, in C# and F#', async function () {
    this.timeout(DOTNET_CLI_MS);
    for (const lang of LANGS) {
      await assertLibraryRefused(path.join(tmpDir, lang.tag), lang, q);
    }
  });

  // B25, B26 — refuse, never fall back to `workspaceFolders[0]`.
  test('the debug command refuses an out-of-workspace document and a blind invocation', async function () {
    this.timeout(DOTNET_CLI_MS);
    await assertCommandRegistered(CMD_DEBUG_PROGRAM);
    const cs = await openCSharpFile(tmpDir, 'Orphan.cs', 'System.Console.WriteLine("o");\n');
    await assertOrphanRefused(cs.uri.fsPath, q, 1);
    const fsharp = await openFSharpFile(tmpDir, 'Orphan.fs', 'module Orphan\n\nlet value = 1\n');
    await assertOrphanRefused(fsharp.uri.fsPath, q, 2);

    // B26 — no editor at all: prompt or warn, but never launch something.
    await clearFocus();
    const picksBefore = stubs.log.quickPickItems.length;
    const warnsBefore = stubs.log.warningMessages.length;
    const blind = await invokeCommand(CMD_DEBUG_PROGRAM);
    assert.strictEqual(blind.rejected, false, `B26: the command must not reject: ${blind.message}`);
    await sessions.assertNoSession('B26: with no editor, no arbitrary project may be launched');
    await tasks.assertNoTask('B26: with no editor, no build task may run', 0);
    const picks = stubs.log.quickPickItems.length - picksBefore;
    const warns = stubs.log.warningMessages.length - warnsBefore;
    assert.strictEqual(picks + warns, 1, `B26: one prompt or one warning; ${picks} and ${warns}`);
    assert.strictEqual(picks <= 1, true, `B26: never more than one prompt; got ${picks}`);
    assert.strictEqual(warns <= 1, true, `B26: never more than one warning; got ${warns}`);
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'B26: no error dialog may be shown');
    const anySession = sessions.started.map((session) => `${session.type}:${session.name}`);
    assert.deepStrictEqual(anySession, [], 'B26: no session of ANY type started in this test');
    assert.deepStrictEqual([...sessions.terminated], [], 'B26: none started, so none terminated');
    assert.deepStrictEqual([...tasks.exits], [], 'B26: no task process ran to completion');
  });
});
