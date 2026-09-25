// [NETFX-DEBUG] for programs, F# first: Run without debugging uses
// `dotnet run --framework <tfm>`, on the ACTIVE framework of the project the
// launch came from ([NETFX-CONTEXT]); Debug (F5) of a multi-targeted project
// debugs its .NET build — the active framework when that is .NET, else the first
// .NET framework it declares — and a project with no .NET framework at all is
// refused with the [NETFX-DEBUG] message, as a warning, starting nothing.
//
// Each console program returns 48 on .NET Framework and 10 on .NET, so a task's
// exit code is the proof of the framework that really ran — not merely of the
// arguments it was handed.
//
// Covers [NETFX-DEBUG] and [NETFX-CONTEXT].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { SharpLspExtensionApi } from '../../extension.js';
import { assertSwitched, switchFramework } from './netfx-context-kit';
import { useLoadedFixture } from './netfx-language-kit';
import {
  EXIT_ON_NET,
  EXIT_ON_NETFX,
  recordStartedTasks,
  type RunnableProject,
  type StartedTask,
  writeRunFixture,
} from './netfx-msbuild-kit';
import { awaitLogged, logMark } from './netfx-test-kit';
import {
  CMD_DEBUG_PROGRAM,
  CMD_RUN_PROGRAM,
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  focusDocument,
  invokeCommand,
  stopAnyDebugSession,
  TaskRecorder,
} from './run-debug-kit';
import { activateTestExplorer } from './test-explorer-kit';
import { comparablePath, pollUntilResult, requireWorkspaceRoot, sleep } from './test-helpers';
import { DEBUG_SESSION_MS, FIXTURE_BUILD_MS, QUIET_MS } from './test-timeouts';
import { installUiStubs } from './ui-stubs';

/** The refusal [NETFX-DEBUG] quotes after the project's name. */
const REFUSAL =
  'runs on .NET Framework, and no .NET Framework debugger is bundled: Debug attaches to .NET only.';

/** The one `sharplsp-run` task a Run started: its name, command line and definition. */
async function assertRunTask(
  tasks: TaskRecorder,
  started: readonly StartedTask[],
  project: RunnableProject,
  tfm: string,
): Promise<void> {
  const [task] = await tasks.waitForDotnetTasks(1, FIXTURE_BUILD_MS);
  assert.ok(task, `a dotnet task started for ${project.name}`);
  assert.strictEqual(
    task.name,
    `Run ${project.name} (${tfm})`,
    'named for its project and framework',
  );
  assert.strictEqual(task.definitionType, 'sharplsp-run', 'a SharpLsp run task');
  const [verb, projectFlag, file, frameworkFlag, framework] = task.args;
  assert.deepStrictEqual(
    [verb, projectFlag, frameworkFlag, framework],
    ['run', '--project', '--framework', tfm],
  );
  assert.strictEqual(
    comparablePath(file ?? ''),
    comparablePath(project.projectFile),
    'the project file',
  );
  const run = started.find((each) => each.definition.type === 'sharplsp-run');
  assert.ok(run?.isProcess, 'a process with its own arguments, never a shell line');
  assert.strictEqual(run.definition.framework, tfm, 'the definition names the framework');
  assert.strictEqual(
    comparablePath(String(run.definition.project)),
    comparablePath(project.projectFile),
  );
}

suite('.NET Framework F# — Run on the active framework, Debug on .NET only', () => {
  // Inside the workspace folder: launching refuses a document outside every
  // folder instead of silently borrowing the first one.
  const fixture = useLoadedFixture('sharplsp-netfx-run-', writeRunFixture, requireWorkspaceRoot);
  let api: SharpLspExtensionApi;

  suiteSetup(async () => {
    api = await activateTestExplorer();
  });

  /** Ctrl+F5 from `project`'s program: its task, its exit code and its log line. */
  async function runFrom(project: RunnableProject, tfm: string, exit: number): Promise<void> {
    const tasks = new TaskRecorder();
    const started = recordStartedTasks();
    const mark = logMark(api);
    try {
      await focusDocument(path.join(fixture().root, project.program));
      const run = await invokeCommand(CMD_RUN_PROGRAM);
      assert.ok(!run.rejected, `${CMD_RUN_PROGRAM} runs: ${run.message}`);
      await assertRunTask(tasks, started.started, project, tfm);
      const exits = await tasks.waitForExits(1, FIXTURE_BUILD_MS);
      assert.deepStrictEqual(
        exits,
        [exit],
        `the program really ran on ${tfm}: it returned ${String(exit)}`,
      );
      await awaitLogged(api, mark, `Run: ${project.name} under ${tfm}`);
    } finally {
      tasks.dispose();
      started.dispose();
    }
  }

  test('Run from a document runs the ACTIVE framework: net48 by default, and the .exe really ran', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const { probe } = fixture();
    await runFrom(probe, probe.frameworks.first, EXIT_ON_NETFX);
  });

  test('switch the project to .NET and Run follows it: the task names .NET, and the program returns 10', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const { probe, root } = fixture();
    const net = probe.frameworks.available.at(-1) ?? '';
    const uri = (await focusDocument(path.join(root, probe.program))).document.uri;
    await assertSwitched(uri, net, probe.frameworks.available);
    try {
      await runFrom(probe, net, EXIT_ON_NET);
    } finally {
      await switchFramework(uri, probe.frameworks.first);
    }
  });

  test('a project built for .NET Framework ALONE still RUNS, on its first framework', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const { netfxOnly } = fixture();
    await runFrom(netfxOnly, netfxOnly.frameworks.first, EXIT_ON_NETFX);
  });

  test('Debug (F5) debugs the .NET build — never the .exe, even with net48 first AND active', async function () {
    this.timeout(FIXTURE_BUILD_MS + DEBUG_SESSION_MS);
    const { probe, root } = fixture();
    const net = probe.frameworks.available.at(-1) ?? '';
    const sessions = new DebugSessionRecorder();
    try {
      await focusDocument(path.join(root, probe.program));
      const debug = await invokeCommand(CMD_DEBUG_PROGRAM);
      assert.ok(!debug.rejected, `${CMD_DEBUG_PROGRAM} starts: ${debug.message}`);
      const [session] = await pollUntilResult(
        async () => sessions.started,
        (s) => s.length > 0,
        FIXTURE_BUILD_MS,
      );
      assert.ok(session, 'a debug session started');
      assert.strictEqual(session.type, DEBUG_TYPE_ID, 'with the SharpLsp debugger');
      const program = comparablePath(String(session.configuration.program));
      const expected = comparablePath(
        path.join(root, probe.name, 'bin', 'Debug', net, `${probe.name}.dll`),
      );
      assert.strictEqual(program, expected, 'the .NET build of the project, not its net48 .exe');
    } finally {
      sessions.dispose();
      await stopAnyDebugSession();
    }
  });

  test('Debug (F5) of a project with NO .NET framework is refused as a warning, and starts nothing', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const { netfxOnly, root } = fixture();
    const sessions = new DebugSessionRecorder();
    const stubs = installUiStubs();
    try {
      await focusDocument(path.join(root, netfxOnly.program));
      await invokeCommand(CMD_DEBUG_PROGRAM);
      const warnings = await pollUntilResult(
        async () => stubs.log.warningMessages,
        (w) => w.length > 0,
        DEBUG_SESSION_MS,
      );
      const refusal = warnings.find((message) => message.includes(REFUSAL)) ?? '';
      assert.ok(
        refusal.startsWith(`${netfxOnly.name} ${REFUSAL}`),
        `the quoted refusal: ${warnings.join(' | ')}`,
      );
      assert.deepStrictEqual(stubs.log.errorMessages, [], 'a warning, never an error');
      await sleep(QUIET_MS);
      assert.deepStrictEqual(sessions.started, [], 'and no debug session ever starts');
    } finally {
      stubs.restore();
      sessions.dispose();
    }
  });
});
