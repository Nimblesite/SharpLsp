// Single-file and script run/debug targets.
//
// Spec: [DEBUG-FEATURES-LAUNCH-SCRIPT] (docs/specs/DEBUGGING-SPEC.md), leaning on
// [DEBUG-FEATURES-LAUNCH-TARGET]'s cone search. F# FIRST: the `.fsx` cases lead.
//
// Every fixture sits one level BELOW a `.git`-fenced `mkdtemp` root, so the cone
// walk is real and provably ends without a project — `assertNoOwningProject`
// fails as itself if a regression reclassifies these as project-owned. Refusals
// are asserted four ways, per rule 6: exactly one message, it names the real
// reason, it is NOT today's generic project-not-found sentence, zero sessions
// and zero tasks.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findEntryProject, findProjectFile } from '../../debug.js';
import {
  BUILD_TIMEOUT_MS,
  CMD_DEBUG_PROGRAM,
  CMD_RUN_PROGRAM,
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  OBSERVE_TIMEOUT_MS,
  TaskRecorder,
  adapterAvailable,
  assertCommandRegistered,
  focusDocument,
  invokeCommand,
  stopAnyDebugSession,
  type ObservedTask,
} from './run-debug-kit';
import * as fixtures from './run-debug-fixtures';
import {
  closeAllEditors,
  comparablePath,
  pollUntilResult,
  removeDirRecursive,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';

// The sentence `debugCurrentProject` emits today for EVERY unresolved target.
const LEGACY_REFUSAL = 'No .csproj or .fsproj found';

// A task recorder plus a session recorder, armed together before one action.
interface Probe {
  readonly tasks: TaskRecorder;
  readonly sessions: DebugSessionRecorder;
}
const armed: Probe[] = [];

/** Arm BOTH recorders and register them for teardown. Never after the action. */
function armProbe(): Probe {
  const probe = { tasks: new TaskRecorder(), sessions: new DebugSessionRecorder() };
  armed.push(probe);
  return probe;
}
function disposeArmed(): void {
  for (const probe of armed) {
    probe.tasks.dispose();
    probe.sessions.dispose();
  }
  armed.length = 0;
}

/** Paths compare case/separator-normalised, never raw. */
function assertSamePath(actual: string, expected: string, why: string): void {
  assert.strictEqual(comparablePath(actual), comparablePath(expected), why);
}
function assertOtherPath(actual: string, expected: string, why: string): void {
  assert.notStrictEqual(comparablePath(actual), comparablePath(expected), why);
}
function activePath(): string {
  return vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
}
interface MessageCounts {
  readonly warnings: number;
  readonly errors: number;
  readonly infos: number;
}
const NO_MESSAGES: MessageCounts = { warnings: 0, errors: 0, infos: 0 };
function messageCounts(stubs: UiStubs): MessageCounts {
  const { warningMessages: w, errorMessages: e, infoMessages: i } = stubs.log;
  return { warnings: w.length, errors: e.length, infos: i.length };
}

// Sliced PER CHANNEL: slicing a flattened warning+error+info list by an earlier
// flattened length mis-reports which message is new once two channels are used.
function messagesSince(stubs: UiStubs, since: MessageCounts): string[] {
  const { warningMessages: w, errorMessages: e, infoMessages: i } = stubs.log;
  return [...w.slice(since.warnings), ...e.slice(since.errors), ...i.slice(since.infos)];
}
function messagesOf(stubs: UiStubs): string[] {
  return messagesSince(stubs, NO_MESSAGES);
}

/** A refusal must name its own reason, not borrow an unrelated one. */
function assertOmits(message: string, forbidden: string, why: string): void {
  const mentions = message.includes(forbidden);
  assert.strictEqual(mentions, false, `${why}: must not mention '${forbidden}': '${message}'`);
}

function assertNamedRefusal(message: string, needles: readonly string[], why: string): void {
  assert.strictEqual(typeof message, 'string', `${why}: a refusal is a string message`);
  assert.notStrictEqual(message.trim().length, 0, `${why}: an empty message is a silent no-op`);
  assertOmits(message, LEGACY_REFUSAL, `${why}: the generic project-not-found sentence`);
  const lowered = message.toLowerCase();
  for (const needle of needles) {
    const named = lowered.includes(needle);
    assert.strictEqual(named, true, `${why}: must name '${needle}': '${message}'`);
  }
}

function assertNoPrompts(stubs: UiStubs, why: string): void {
  assert.deepStrictEqual(stubs.log.quickPickItems, [], `${why}: must not open a quick pick`);
  assert.deepStrictEqual(stubs.log.inputBoxOptions, [], `${why}: must not open an input box`);
  assert.deepStrictEqual(stubs.log.openDialogOptions, [], `${why}: must not open a file dialog`);
}
function assertNoRecordedTasks(probe: Probe, why: string): void {
  const ran = probe.tasks.dotnetTasks.map((task) => task.args.join(' '));
  assert.deepStrictEqual(ran, [], why);
}

/** Drive one refusal and assert every obligation of rule 6. */
async function expectRefusal(
  commandId: string,
  probe: Probe,
  stubs: UiStubs,
  needles: readonly string[],
  why: string,
): Promise<string> {
  const before = messageCounts(stubs);
  const outcome = await invokeCommand(commandId);
  const clean = { rejected: false, message: '' };
  assert.deepStrictEqual({ ...outcome }, clean, `${why}: must refuse with a message, not reject`);
  const shown = messagesSince(stubs, before);
  assert.strictEqual(shown.length, 1, `${why}: exactly one message, saw ${JSON.stringify(shown)}`);
  const message = shown[0] ?? '';
  assertNamedRefusal(message, needles, why);
  assertNoPrompts(stubs, `${why}: a refusal`);
  await probe.sessions.assertNoSession(`${why}: a refusal starts no debug session`);
  await probe.tasks.assertNoTask(`${why}: a refusal runs no task`);
  return message;
}

/** The run MUST be a `vscode.Task` on SharpLsp's own task type (rule 1). */
function assertTaskIdentity(task: ObservedTask, why: string): void {
  assert.strictEqual(typeof task.name, 'string', `${why}: a task carries a name`);
  assert.notStrictEqual(task.name.trim().length, 0, `${why}: the task name must not be empty`);
  assert.strictEqual(typeof task.source, 'string', `${why}: a task carries a source`);
  assert.notStrictEqual(task.definitionType, 'dotnet', `${why}: 'dotnet' is the proprietary type`);
  const type = task.definitionType;
  assert.strictEqual(type.startsWith('sharplsp'), true, `${why}: SharpLsp must own type '${type}'`);
}

/** Assert the exact `dotnet` argument vector a script run must produce. */
function assertRunArgs(task: ObservedTask, expected: readonly string[], why: string): void {
  const cli = path.basename(task.command ?? '', '.exe');
  assert.strictEqual(cli, 'dotnet', `${why}: a script run invokes the dotnet CLI`);
  const actual = task.args.map(comparablePath);
  assert.deepStrictEqual(actual, expected.map(comparablePath), `${why}: exact argument vector`);
  assert.strictEqual(task.args.length, expected.length, `${why}: no extra arguments`);
  const last = task.args[task.args.length - 1] ?? '';
  assert.strictEqual(path.isAbsolute(last), true, `${why}: the target must be an absolute path`);
  assertTaskIdentity(task, why);
}
function projectFilesIn(dir: string): string[] {
  const proj = (n: string): boolean => n.endsWith('.csproj') || n.endsWith('.fsproj');
  return fs.readdirSync(dir).filter(proj).sort();
}

/** Prove a fixture really has no owning project anywhere up to its fenced root. */
function assertNoOwningProject(dir: string, why: string): void {
  const root = path.dirname(dir);
  assert.strictEqual(findEntryProject(dir), undefined, `${why}: no project in the entry dir`);
  assert.strictEqual(findProjectFile(dir, root), undefined, `${why}: the cone walk finds none`);
  assert.deepStrictEqual(projectFilesIn(dir), [], `${why}: the entry dir holds no project file`);
  assert.deepStrictEqual(projectFilesIn(root), [], `${why}: the fenced root holds no project file`);
  assert.strictEqual(fs.existsSync(path.join(root, '.git')), true, `${why}: the root is fenced`);
}

function assertOwningProject(dir: string, name: string, why: string): void {
  const entry = findProjectFile(dir, path.dirname(dir));
  assert.ok(entry, `${why}: the fixture must really contain ${name}.csproj`);
  assertSamePath(entry.cwd, dir, `${why}: the neighbouring project's cwd is its own directory`);
  assert.strictEqual(path.basename(entry.dll), `${name}.dll`, `${why}: it is ${name}, not another`);
  assert.deepStrictEqual(projectFilesIn(dir), [`${name}.csproj`], `${why}: exactly one project`);
}
function writeFixtureFile(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

/** `bin/<config-lowercased>/<name>.dll`, with NO TFM segment (rule 4). */
function assertFileBasedProgram(program: string, name: string, why: string): void {
  assert.strictEqual(typeof program, 'string', `${why}: the launch config needs a program`);
  assert.strictEqual(path.isAbsolute(program), true, `${why}: the program must be absolute`);
  assert.strictEqual(path.extname(program), '.dll', `${why}: netcoredbg launches a managed dll`);
  assert.strictEqual(path.basename(program), `${name}.dll`, `${why}: named after the entry file`);
  const tail = comparablePath(path.join('bin', 'debug', `${name}.dll`));
  const laidOut = comparablePath(program).endsWith(tail);
  assert.strictEqual(laidOut, true, `${why}: bin/debug/<name>.dll, got '${program}'`);
  const tfms = program.split(/[\\/]/).filter((segment) => /^net\d/i.test(segment));
  assert.deepStrictEqual(tfms, [], `${why}: file-based output carries NO TFM segment`);
  assert.strictEqual(fs.existsSync(program), true, `${why}: the built program must exist on disk`);
}

async function focusScript(file: string, ext: string, dir: string, why: string): Promise<void> {
  const editor = await focusDocument(file);
  assertSamePath(editor.document.uri.fsPath, file, `${why}: it is the active document`);
  assertSamePath(activePath(), file, `${why}: the workbench agrees on the active editor`);
  assert.strictEqual(path.extname(file), ext, `${why}: the fixture extension is ${ext}`);
  assert.strictEqual(editor.document.isUntitled, false, `${why}: it is a real file on disk`);
  assertNoOwningProject(dir, why);
}

/** Invoke the run command and assert the exact task it must dispatch. */
async function expectScriptRun(
  probe: Probe,
  stubs: UiStubs,
  expected: readonly string[],
  index: number,
  why: string,
): Promise<ObservedTask> {
  const outcome = await invokeCommand(CMD_RUN_PROGRAM);
  const clean = { rejected: false, message: '' };
  assert.deepStrictEqual({ ...outcome }, clean, `${why}: the run must succeed, not reject`);
  const nth = index + 1;
  const tasks = await probe.tasks.waitForDotnetTasks(nth);
  assert.strictEqual(tasks.length, nth, `${why}: run ${nth} is dotnet task ${nth}`);
  const task = tasks[index]!;
  assertRunArgs(task, expected, why);
  assertSamePath(task.args[task.args.length - 1] ?? '', activePath(), `${why}: target is focused`);
  await probe.sessions.assertNoSession(`${why}: a script run is a task, never a debug session`);
  assert.deepStrictEqual(messagesOf(stubs), [], `${why}: a successful run shows the user nothing`);
  assertNoPrompts(stubs, `${why}: an unambiguous run`);
  return task;
}

suite('Run and debug: script targets [DEBUG-FEATURES-LAUNCH-SCRIPT]', () => {
  let scriptDir = '';
  let appDir = '';
  let neighbourDir = '';
  let fsxFile = '';
  let csxFile = '';
  let orphanFs = '';
  let fileBasedApp = '';
  let neighbourScript = '';
  let plainTextFile = '';
  const roots: string[] = [];
  let stubs: UiStubs;
  let probe: Probe;

  function newRoot(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fixtures.markGitRoot(root);
    roots.push(root);
    return root;
  }

  suiteSetup(() => {
    scriptDir = path.join(newRoot('sharplsp-scripts-'), 'src');
    fsxFile = fixtures.writeFsxScript(scriptDir, 'Greet', 'hello from Greet.fsx');
    csxFile = fixtures.writeCsxScript(scriptDir, 'Calc', 'hello from Calc.csx');
    orphanFs = writeFixtureFile(scriptDir, 'Orphan.fs', 'module Orphan\n\nlet answer = 42\n');

    appDir = path.join(newRoot('sharplsp-filebased-'), 'app');
    fileBasedApp = fixtures.writeFileBasedApp(appDir, 'FileApp', 'hello from FileApp.cs');

    // A .cs AND a .txt sharing a directory with an unrelated project: the
    // positional `dotnet run <path>` form would run the project and pass the
    // path as an application argument (rule 2), and a refusal that walks the
    // cone instead of reading the document kind would launch `Neighbour`.
    neighbourDir = path.join(newRoot('sharplsp-mixed-'), 'Neighbour');
    fixtures.writeCSharpConsole(neighbourDir, 'Neighbour', { marker: 'the WRONG program' });
    neighbourScript = fixtures.writeFileBasedApp(neighbourDir, 'Script', 'hello from Script.cs');
    plainTextFile = writeFixtureFile(neighbourDir, 'notes.txt', 'not a .NET source file\n');
  });

  suiteTeardown(() => {
    for (const root of roots) removeDirRecursive(root);
  });

  setup(() => {
    stubs = installUiStubs();
    probe = armProbe();
  });

  teardown(async () => {
    stubs.restore();
    await stopAnyDebugSession();
    disposeArmed();
    await closeAllEditors();
  });

  // Implements [DEBUG-FEATURES-LAUNCH-SCRIPT] — B45, B46, and the spec table's
  // "`.fs` with no owning project" row. F# leads.
  test('an .fsx runs under dotnet fsi, refuses to debug, and a bare .fs refuses both', async function () {
    this.timeout(BUILD_TIMEOUT_MS);

    // 1 — focus the script and prove it really is project-less.
    await focusScript(fsxFile, '.fsx', scriptDir, 'the .fsx fixture');
    assert.strictEqual(probe.tasks.started.length, 0, 'no task ran before the first interaction');
    assert.strictEqual(probe.sessions.started.length, 0, 'no session existed before interaction 1');

    // 2 — run it. B45: a task, not a terminal, not a debug session.
    await assertCommandRegistered(CMD_RUN_PROGRAM);
    const fsi = ['fsi', '--exec', fsxFile];
    await expectScriptRun(probe, stubs, fsi, 0, 'dotnet fsi --exec <abs path>'); // B45
    const exits = await probe.tasks.waitForExits(1);
    assert.deepStrictEqual([...exits], [0], 'the F# script must run and exit 0'); // B45

    // 3 — debug the same .fsx. B46: refused by name, not attempted.
    const fsxProbe = armProbe();
    const fsxWhy = 'debugging an .fsx';
    const kinds = ['f#', 'script'];
    const refusal = await expectRefusal(CMD_DEBUG_PROGRAM, fsxProbe, stubs, kinds, fsxWhy); // B46
    assertOmits(refusal, '.csproj', fsxWhy); // B46
    assertOmits(refusal, '.fsproj', fsxWhy); // B46
    assert.strictEqual(probe.tasks.dotnetTasks.length, 1, 'no second dotnet task ran');
    assert.deepStrictEqual([...probe.tasks.exits], [0], 'the earlier run stays the only exit');

    // 4 — focus a project-less .fs; the resolved target must CHANGE.
    await focusScript(orphanFs, '.fs', scriptDir, 'the bare .fs fixture');
    assertOtherPath(activePath(), fsxFile, 'focus moved off the .fsx onto the .fs');

    // 5 and 6 — run and debug both refuse: F# has no file-based-app model, so a
    // bare .fs with no project cannot be launched either way.
    const fsProbe = armProbe();
    const debugWhy = 'debugging a project-less .fs';
    const refused = await expectRefusal(CMD_DEBUG_PROGRAM, fsProbe, stubs, ['f#'], debugWhy);
    assertOmits(refused, 'Greet.fsx', debugWhy);
    assertOmits(refused, 'Neighbour', debugWhy);
    const runWhy = 'running a project-less .fs';
    const ran = await expectRefusal(CMD_RUN_PROGRAM, fsProbe, stubs, ['f#'], runWhy);
    assertOmits(ran, 'fsi', runWhy);
    assert.strictEqual(probe.sessions.ours.length, 0, 'the F# sequence started zero sessions');
    assert.strictEqual(probe.tasks.dotnetTasks.length, 1, 'only the .fsx run ever dispatched');
    assert.strictEqual(messagesOf(stubs).length, 3, 'three refusals, three messages, no more');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-SCRIPT] — B42, B43.
  test('a file-based .cs runs via dotnet run --file, never the positional form', async function () {
    this.timeout(BUILD_TIMEOUT_MS);

    // 1 — focus the project-less .cs file-based app.
    await focusScript(fileBasedApp, '.cs', appDir, 'the file-based app fixture');
    const opened = vscode.window.activeTextEditor?.document;
    assert.strictEqual(opened?.languageId, 'csharp', 'the .cs opens as a C# document');

    // 2 — run it. B42: `--file` plus the absolute path, exit 0.
    await assertCommandRegistered(CMD_RUN_PROGRAM);
    const vector = ['run', '--file', fileBasedApp];
    const firstRun = await expectScriptRun(probe, stubs, vector, 0, 'dotnet run --file <abs>'); // B42
    const exits = await probe.tasks.waitForExits(1);
    assert.deepStrictEqual([...exits], [0], 'the file-based app must run and exit 0'); // B42

    // 3 — a .cs sharing its directory with an unrelated project, chosen
    // explicitly from the context menu. B43: still the `--file` form.
    await focusDocument(neighbourScript);
    assertSamePath(activePath(), neighbourScript, 'the neighbouring script is now active');
    assertOwningProject(neighbourDir, 'Neighbour', 'the mixed fixture'); // B43
    const explicit = await invokeCommand(CMD_RUN_PROGRAM, vscode.Uri.file(neighbourScript));
    assert.strictEqual(explicit.rejected, false, `an explicit target runs: ${explicit.message}`);
    const mixedTasks = await probe.tasks.waitForDotnetTasks(2);
    assert.strictEqual(mixedTasks.length, 2, 'the second run is a second observable task');
    const mixed = mixedTasks[1]!;
    const flag = mixed.args.indexOf('--file');
    assert.notStrictEqual(flag, -1, "the run must pass '--file'; positional runs the project"); // B43
    assertSamePath(mixed.args[flag + 1] ?? '', neighbourScript, "'--file' takes the abs path"); // B43
    assertSamePath(mixed.args[flag + 1] ?? '', path.join(neighbourDir, 'Script.cs'), 'the .cs'); // B43
    assert.deepStrictEqual(mixed.args.slice(0, flag), ['run'], "only 'run' precedes '--file'"); // B43
    const projectArgs = mixed.args.filter((arg) => arg.endsWith('.csproj'));
    assert.deepStrictEqual(projectArgs, [], 'the neighbouring project never enters the args'); // B43
    assertTaskIdentity(mixed, 'the explicitly targeted run'); // B43
    assert.strictEqual(mixed.definitionType, firstRun.definitionType, 'one stable run task type');
    await probe.sessions.assertNoSession('an explicit script run starts no debug session');
    assert.deepStrictEqual(messagesOf(stubs), [], 'an explicit run shows the user nothing');

    // 4 — refocus the first app and re-run: the resolved target must follow the
    // active document rather than replaying the previous one.
    await focusDocument(fileBasedApp);
    const third = await expectScriptRun(probe, stubs, vector, 2, 'the target follows the editor');
    assertOtherPath(third.args.join(' '), mixed.args.join(' '), 'refocusing changed the target');
    assertSamePath(third.args.join(' '), firstRun.args.join(' '), 'same doc, same run');
    const dispatched = probe.tasks.dotnetTasks.length;
    assert.strictEqual(dispatched, 3, 'three runs produced three dotnet tasks, and no more');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-SCRIPT] — B44.
  test('debugging a file-based .cs launches the artifacts-path assembly', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    if (!adapterAvailable()) this.skip();

    // 1 — focus the project-less file-based app.
    await focusScript(fileBasedApp, '.cs', appDir, 'the file-based app fixture');
    assert.strictEqual(probe.sessions.started.length, 0, 'no session exists before the action');
    assert.strictEqual(probe.sessions.terminated.length, 0, 'nothing has terminated yet either');

    // 2 — debug it. B44: a real session on the built assembly.
    const outcome = await invokeCommand(CMD_DEBUG_PROGRAM);
    assert.strictEqual(outcome.rejected, false, `debugging must succeed: ${outcome.message}`);
    const sessions = await probe.sessions.waitForSessions(1);
    assert.strictEqual(sessions.length, 1, 'exactly one SharpLsp debug session starts'); // B44
    const session = sessions[0]!;
    assert.strictEqual(session.type, DEBUG_TYPE_ID, 'the session uses the SharpLsp debug type');
    assert.strictEqual(session.configuration.type, DEBUG_TYPE_ID, 'the config type matches it');
    assert.strictEqual(session.configuration.request, 'launch', 'launched, never attached');
    assert.notStrictEqual(session.configuration.noDebug, true, 'debugProgram must not set noDebug');
    assert.notStrictEqual(session.name.trim().length, 0, 'the session must be named for the UI');
    assertFileBasedProgram(String(session.configuration.program), 'FileApp', 'the program'); // B44
    const cwd = String(session.configuration.cwd);
    assert.strictEqual(typeof session.configuration.cwd, 'string', 'the launch cwd is a path');
    assert.strictEqual(path.isAbsolute(cwd), true, `the launch cwd is absolute: '${cwd}'`);
    assert.strictEqual(fs.existsSync(cwd), true, `the launch cwd exists: '${cwd}'`);
    assert.strictEqual(fs.statSync(cwd).isDirectory(), true, 'the launch cwd is a directory');
    assertOtherPath(cwd, String(session.configuration.program), 'cwd is a directory, not the dll');
    assert.deepStrictEqual(messagesOf(stubs), [], 'a successful launch warns about nothing');
    assertNoPrompts(stubs, 'an unambiguous debug launch');
    // It may dispatch [DEBUG-FEATURES-LAUNCH-BUILD] rule 1's `sharplsp-build`
    // task, but it must never RUN the program.
    const runVerbs = probe.tasks.dotnetTasks.filter((task) => task.args[0] === 'run');
    assert.deepStrictEqual(runVerbs, [], 'a debug launch never runs the program via `dotnet run`');
    const fileFlags = probe.tasks.dotnetTasks.filter((task) => task.args.includes('--file'));
    assert.deepStrictEqual(
      fileFlags,
      [],
      'a debug launch never routes through `dotnet run --file`',
    );

    // 3 — stop it; the workbench must report the termination.
    await stopAnyDebugSession();
    const terminated = await pollUntilResult(
      async () => probe.sessions.terminated,
      (ids) => ids.includes(session.id),
      OBSERVE_TIMEOUT_MS,
      100,
    );
    assert.strictEqual(terminated.includes(session.id), true, 'stopping terminates our session');
    assert.strictEqual(probe.sessions.ours.length, 1, 'stopping must not start a second session');
    assert.deepStrictEqual(messagesOf(stubs), [], 'a clean stop shows the user nothing');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-SCRIPT] — B47, B48.
  test('a .csx without dotnet-script and a non-.NET document are refused by name', async function () {
    this.timeout(BUILD_TIMEOUT_MS);

    // 1 — focus the .csx and prove it is project-less.
    await focusScript(csxFile, '.csx', scriptDir, 'the .csx fixture');
    assert.strictEqual(probe.tasks.started.length, 0, 'no task ran before the first interaction');

    // 2 — run it. B47: the missing third-party tool is named, and it MUST NOT
    // fall back to `dotnet run --file`, which compiles a .csx as ordinary C#
    // and fails on `#load`/`#r`.
    await assertCommandRegistered(CMD_RUN_PROGRAM);
    const runProbe = armProbe();
    const runWhy = 'running a .csx with no dotnet-script tool';
    const tool = ['dotnet-script'];
    const noTool = await expectRefusal(CMD_RUN_PROGRAM, runProbe, stubs, tool, runWhy); // B47
    assertOmits(noTool, '--file', runWhy); // B47
    assertOmits(noTool, 'fsi', runWhy); // B47
    assertNoRecordedTasks(runProbe, 'refusing a .csx must never run `dotnet run --file`'); // B47
    assertNoRecordedTasks(probe, 'nothing at all was dispatched during the .csx run');

    // 3 — debug the same .csx: also unsupported, also named.
    const debugProbe = armProbe();
    const csxWhy = 'debugging a .csx';
    const csx = ['c#', 'script'];
    const noDebug = await expectRefusal(CMD_DEBUG_PROGRAM, debugProbe, stubs, csx, csxWhy);
    assertOmits(noDebug, '.fsproj', csxWhy);
    assertOmits(noDebug, '.csproj', csxWhy);
    assert.strictEqual(messagesOf(stubs).length, 2, 'two refusals so far, one message each');

    // 4 — focus a .txt sitting beside an unrelated .csproj. The target must NOT
    // silently become that project.
    const text = await focusDocument(plainTextFile);
    assertOtherPath(text.document.uri.fsPath, csxFile, 'focus moved off the .csx');
    assertSamePath(activePath(), plainTextFile, 'the .txt is now the active document');
    assert.strictEqual(path.extname(plainTextFile), '.txt', 'the fixture is a plain text file');
    assert.notStrictEqual(text.document.languageId, 'csharp', 'a .txt is not a C# document');
    assertOwningProject(neighbourDir, 'Neighbour', 'the .txt fixture directory'); // B48

    // 5 and 6 — debug and run both refuse. B48: exactly one message, zero
    // sessions, zero tasks — not a silent launch of the neighbour.
    const textProbe = armProbe();
    const named = ['runnable', '.net'];
    const textWhy = 'debugging a non-.NET document';
    const refusal = await expectRefusal(CMD_DEBUG_PROGRAM, textProbe, stubs, named, textWhy); // B48
    assertOmits(refusal, 'Neighbour', textWhy); // B48
    const ranWhy = 'running a non-.NET document';
    const ran = await expectRefusal(CMD_RUN_PROGRAM, textProbe, stubs, named, ranWhy);
    assertOmits(ran, 'Neighbour', ranWhy);
    assert.strictEqual(probe.sessions.ours.length, 0, 'the refusal sequence started no session');
    assertNoRecordedTasks(probe, 'the refusal sequence dispatched no dotnet task');
    assert.strictEqual(messagesOf(stubs).length, 4, 'four refusals, four messages, no more');
  });
});
