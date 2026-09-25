// [NETFX-DEBUG] for programs, F# first: Run without debugging runs the task
// `Run <Project> (<tfm>)` — `dotnet run --project <proj> --framework <tfm>
// [-- <profile args>]` — on the ACTIVE framework of the project the launch came
// from ([NETFX-CONTEXT]); Debug (F5) of a multi-targeted project debugs its
// active framework when that is .NET, else the FIRST .NET framework it declares;
// and a project declaring no .NET framework is refused with the [NETFX-DEBUG]
// message, as a warning, starting nothing.
//
// Each console program returns 48 on .NET Framework and 10 on .NET, PLUS its
// argument count, so a task's exit code proves the framework that really ran
// and the profile arguments that really reached it. RunProbe declares two .NET
// versions, so F5's "active .NET" and "first .NET" cases are told apart.
//
// Covers [NETFX-DEBUG] and [NETFX-CONTEXT].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { SharpLspExtensionApi } from '../../extension.js';
import { assertContext, frameworkContextOf, underFramework } from './netfx-context-kit';
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
  const [verb, projectFlag, file, frameworkFlag, framework, ...rest] = task.args;
  assert.deepStrictEqual(
    [verb, projectFlag, frameworkFlag, framework],
    ['run', '--project', '--framework', tfm],
  );
  assert.strictEqual(
    comparablePath(file ?? ''),
    comparablePath(project.projectFile),
    'the project file',
  );
  const profile = project.profileArgs.length > 0 ? ['--', ...project.profileArgs] : [];
  assert.deepStrictEqual(
    rest,
    profile,
    'profile arguments follow `--`, and only when the profile has any',
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
      assert.deepStrictEqual(exits, [exit], `it really ran on ${tfm}: it returned ${String(exit)}`);
      await awaitLogged(api, mark, `Run: ${project.name} under ${tfm}`);
    } finally {
      tasks.dispose();
      started.dispose();
    }
  }

  /** F5 from `project`'s program: ONE SharpLsp session, on `tfm`'s build of it. */
  async function debugFrom(project: RunnableProject, tfm: string): Promise<void> {
    const sessions = new DebugSessionRecorder();
    try {
      await focusDocument(path.join(fixture().root, project.program));
      const debug = await invokeCommand(CMD_DEBUG_PROGRAM);
      assert.ok(!debug.rejected, `${CMD_DEBUG_PROGRAM} starts: ${debug.message}`);
      const started = await pollUntilResult(
        async () => sessions.started,
        (s) => s.length > 0,
        FIXTURE_BUILD_MS,
      );
      const [session] = started;
      assert.ok(session, 'a debug session started');
      assert.strictEqual(session.type, DEBUG_TYPE_ID, 'with the SharpLsp debugger');
      const program = comparablePath(String(session.configuration.program));
      const dll = path.join(
        fixture().root,
        project.name,
        'bin',
        'Debug',
        tfm,
        `${project.name}.dll`,
      );
      assert.strictEqual(program, comparablePath(dll), `the ${tfm} build, never the net48 .exe`);
    } finally {
      sessions.dispose();
      await stopAnyDebugSession();
    }
  }

  /** RunProbe switched to its newest .NET for the duration of `body`, then restored. */
  async function onNewestNet(body: (newest: string) => Promise<void>): Promise<void> {
    const { probe, root } = fixture();
    const newest = probe.frameworks.available.at(-1) ?? '';
    const uri = (await focusDocument(path.join(root, probe.program))).document.uri;
    await underFramework(uri, newest, probe.frameworks, async () => {
      await body(newest);
    });
  }

  test('Run from a document runs the ACTIVE framework: net48 by default, and the .exe really ran', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const { probe } = fixture();
    await runFrom(probe, probe.frameworks.first, EXIT_ON_NETFX);
  });

  test('switch the project to .NET and Run follows it: the task names .NET, and the program returns 10', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    await onNewestNet(async (newest) => {
      await runFrom(fixture().probe, newest, EXIT_ON_NET);
    });
  });

  test('a project built for .NET Framework ALONE still RUNS, with its launch profile arguments after --', async function () {
    this.timeout(FIXTURE_BUILD_MS * 2);
    const { netfxOnly } = fixture();
    const exit = EXIT_ON_NETFX + netfxOnly.profileArgs.length;
    await runFrom(netfxOnly, netfxOnly.frameworks.first, exit);
  });

  test('Debug (F5) with net48 active debugs the FIRST .NET framework declared — never the .exe', async function () {
    this.timeout(FIXTURE_BUILD_MS + DEBUG_SESSION_MS);
    const { probe, root } = fixture();
    const [, firstNet = ''] = probe.frameworks.available;
    const uri = (await focusDocument(path.join(root, probe.program))).document.uri;
    const context = await frameworkContextOf(uri);
    assertContext(context, 'net48', probe.frameworks.available, 'RunProbe answers from net48');
    await debugFrom(probe, firstNet);
  });

  test('Debug (F5) with a .NET framework ACTIVE debugs that one — not merely the first .NET declared', async function () {
    this.timeout(FIXTURE_BUILD_MS + DEBUG_SESSION_MS);
    await onNewestNet(async (newest) => {
      await debugFrom(fixture().probe, newest);
    });
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
