// Output-path and build resolution for run/debug. Spec: [DEBUG-FEATURES-LAUNCH-BUILD].
//
// Every fixture is a REAL project built by the REAL `dotnet` CLI, and every
// expectation is cross-checked against MSBuild itself (`dotnet msbuild <proj>
// -getProperty:TargetPath`). A resolver that hardcodes `bin/Debug/<tfm>/<base>
// .dll` over a fixed TFM list is wrong for net7.0, for a custom AssemblyName,
// for a custom OutputPath, for a multi-targeted project, and — worst — it hands
// back a path that does not exist as if it had succeeded.
//
// Rule 3 allows TWO conforming shapes: resolution may build implicitly and
// return an assembly really on disk, or it may refuse by name.
// `assertResolutionOutcome` is that disjunction, so a fix may implement either.
//
// Nothing here starts a debug session: resolution is a pure question, and the
// negative assertions (no session, no task, no toast) prove it stayed one.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SharpLspLaunchProvider, projectEntryFromFile } from '../../debug.js';
import { binaryNameOf } from '../../platform.js';
import {
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  TaskRecorder,
  assertCommandRegistered,
  fakeFolder,
  focusDocument,
  invokeCommand,
  bareF5Config,
  stopAnyDebugSession,
} from './run-debug-kit';
import {
  buildProject,
  writeCSharpConsole,
  writeFSharpConsole,
  type ConsoleProject,
} from './run-debug-fixtures';
import { dotnet } from './dotnet-project-kit';
import {
  closeAllEditors,
  comparablePath,
  comparableText,
  removeDirRecursive,
} from './test-helpers';
import { DEBUG_SESSION_MS, DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

/** The build command the extension registers today (`src/build.ts`). */
const CMD_BUILD = 'sharplsp.build';

/** The terminal `runDotnetCommand` opens — an unobservable, racing second build. */
const BUILD_TERMINAL = 'SharpLsp Build';

/** SharpLsp's own contributed task type ([DEBUG-FEATURES-LAUNCH-BUILD] rule 1). */
const BUILD_TASK_TYPE = 'sharplsp-build';

/** The task type the PROPRIETARY C# extension contributes. Never referenceable. */
const FOREIGN_TASK = 'dotnet: build';

/** How long to give a task dispatch before declaring that none happened. */
const TASK_OBSERVE_MS = 15_000;

/** The body `writeCSharpConsole` gives the `Unbuilt` fixture, verbatim. */
const UNBUILT_SRC = 'System.Console.WriteLine("hello from Unbuilt");\n';

/** Ask MSBuild itself which assembly a project produces. The only authority. */
async function targetPathOf(project: ConsoleProject, tfm?: string): Promise<string> {
  const args = ['msbuild', project.projectFile, '-getProperty:TargetPath'];
  if (tfm !== undefined) args.push(`-p:TargetFramework=${tfm}`);
  return (await dotnet(args, project.dir)).trim();
}

/** Run the provider the way VS Code does on F5 with no launch.json. */
async function resolveFor(root: string): Promise<vscode.DebugConfiguration | undefined> {
  const provider = new SharpLspLaunchProvider();
  const resolved = await Promise.resolve(
    provider.resolveDebugConfiguration(fakeFolder(root), bareF5Config()),
  );
  return resolved ?? undefined;
}

/** An output path relative to its project, slash-joined so a test can name it. */
function relativeOutput(project: ConsoleProject, program: string): string {
  return path.relative(project.dir, program).split(path.sep).join('/');
}

/** The `.pdb` netcoredbg needs to map an address back to a source line. */
function symbolsFor(assembly: string): string {
  return `${assembly.slice(0, -path.extname(assembly).length)}.pdb`;
}

/** Pin a directory's exact contents, so a fixture premise cannot rot silently. */
function assertDirEntries(dir: string, entries: readonly string[], why: string): void {
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [...entries].sort(), why);
}

/**
 * Resolve `project` through the real provider and assert the parts of the
 * synthesized configuration that never vary. Returns the resolved `program`.
 */
async function resolveProgram(project: ConsoleProject): Promise<string | undefined> {
  const resolved = await resolveFor(project.dir);
  assert.strictEqual(resolved?.type, DEBUG_TYPE_ID, 'F5 must synthesize the SharpLsp debug type');
  assert.strictEqual(resolved?.request, 'launch', 'a synthesized configuration launches');
  assert.strictEqual(resolved?.name, 'Launch .NET Project', 'the synthesized name is fixed');
  assert.strictEqual(resolved?.justMyCode, true, 'Just My Code defaults on');
  const cwd = comparablePath(String(resolved?.cwd));
  assert.strictEqual(cwd, comparablePath(project.dir), 'cwd must be the project directory');
  const program: unknown = resolved?.program;
  return typeof program === 'string' ? program : undefined;
}

/**
 * Demand a program from a project that IS built, and check the shape every
 * launch target must have: absolute, a managed assembly, present on disk.
 */
function definedProgram(label: string, program: string | undefined): string {
  assert.notStrictEqual(program, undefined, `${label}: a built project must resolve a program`);
  const resolved = String(program);
  assert.strictEqual(path.isAbsolute(resolved), true, `${label}: program must be absolute`);
  assert.strictEqual(path.extname(resolved), '.dll', `${label}: launch the assembly, not apphost`);
  assert.strictEqual(fs.existsSync(resolved), true, `${label}: ${resolved} must be on disk`);
  return resolved;
}

/** The resolver's answer and MSBuild's answer must be the same existing file. */
async function assertMatchesMsbuild(project: ConsoleProject, program: string, tfm?: string) {
  const target = await targetPathOf(project, tfm);
  assert.notStrictEqual(target, '', `msbuild must report a TargetPath for ${project.projectFile}`);
  assert.strictEqual(fs.existsSync(target), true, `msbuild's TargetPath must exist: ${target}`);
  const same = comparablePath(program) === comparablePath(target);
  assert.strictEqual(same, true, `program must be MSBuild's TargetPath, not a guess: ${program}`);
  assert.strictEqual(fs.existsSync(program), true, `the resolved program must exist: ${program}`);
  return target;
}

/** Assert the resolver produced no path at all, or one that really exists. */
function assertNeverFabricated(label: string, program: string | undefined): void {
  const honest = program === undefined || fs.existsSync(program);
  assert.strictEqual(honest, true, `${label}: never return a missing path (${String(program)})`);
}

/**
 * Rule 3 as the disjunction the spec allows: a resolution either hands back an
 * assembly really on disk (an implicit build ran), or refuses ONCE and names the
 * project. A fabricated path, or a path AND a complaint, are both wrong.
 */
function assertResolutionOutcome(
  project: ConsoleProject,
  program: string | undefined,
  complaints: readonly string[],
): void {
  const shown = JSON.stringify(complaints);
  if (program !== undefined) {
    assert.strictEqual(fs.existsSync(program), true, `never return a missing path: ${program}`);
    assert.deepStrictEqual(
      complaints,
      [],
      `a program was produced, so nothing to report: ${shown}`,
    );
    return;
  }
  assert.strictEqual(complaints.length, 1, `a refusal must be reported exactly once: ${shown}`);
  const named = complaints[0]?.includes(path.basename(project.projectFile));
  assert.strictEqual(named, true, `the refusal must name the project it refused: ${shown}`);
}

/**
 * Rule 1: the pre-launch build must go through SharpLsp's own contributed task
 * type. `dotnet: build` belongs to the proprietary C# extension, so on a
 * SharpLsp-only install VS Code fails pre-launch with
 * `Could not find the task 'dotnet: build'.`
 */
async function assertPreLaunchTask(project: ConsoleProject): Promise<void> {
  const task: unknown = (await resolveFor(project.dir))?.preLaunchTask;
  assert.notStrictEqual(task, FOREIGN_TASK, `'${FOREIGN_TASK}' is the C# extension's task type`);
  const own = task === undefined || !String(task).startsWith('dotnet: ');
  assert.strictEqual(own, true, `preLaunchTask must be a SharpLsp task; got ${String(task)}`);
}

/**
 * Focus a project's own source file, resolve it through the provider, and hold
 * the answer to MSBuild's — and to the `<dir>/<rel>` layout MSBuild reports.
 */
async function resolveFocused(label: string, project: ConsoleProject, rel: string, tfm?: string) {
  const editor = await focusDocument(project.sourceFile);
  const active = comparablePath(editor.document.uri.fsPath);
  assert.strictEqual(active, comparablePath(project.sourceFile), `${label}: wrong editor focused`);
  const program = definedProgram(label, await resolveProgram(project));
  await assertMatchesMsbuild(project, program, tfm);
  assert.strictEqual(relativeOutput(project, program), rel, `${label}: MSBuild's own layout`);
  return program;
}

/** Count the build terminals currently open, so a delta can be asserted. */
function buildTerminalCount(): number {
  return vscode.window.terminals.filter((terminal) => terminal.name === BUILD_TERMINAL).length;
}

/** How many user-facing complaints had been recorded at one point in time. */
interface ComplaintMark {
  readonly errors: number;
  readonly warnings: number;
}

// Implements [DEBUG-FEATURES-LAUNCH-BUILD]
suite('Run/Debug — output path and build resolution [DEBUG-FEATURES-LAUNCH-BUILD]', () => {
  let tmpRoot: string;
  let caseDir: string;
  let stubs: UiStubs;
  let sessions: DebugSessionRecorder;
  let tasks: TaskRecorder;

  let net7Console: ConsoleProject;
  let renamedCs: ConsoleProject;
  let renamedFs: ConsoleProject;
  let customOut: ConsoleProject;
  let multiBuilt: ConsoleProject;
  let multiUnbuilt: ConsoleProject;

  /** Snapshot the complaint counters so ONE interaction can be judged alone. */
  const complaintMark = (): ComplaintMark => ({
    errors: stubs.log.errorMessages.length,
    warnings: stubs.log.warningMessages.length,
  });

  /** Everything shown to the user since `mark`, errors and warnings alike. */
  const complaintsSince = (mark: ComplaintMark): string[] => [
    ...stubs.log.errorMessages.slice(mark.errors),
    ...stubs.log.warningMessages.slice(mark.warnings),
  ];

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-run-debug-build-'));
    const at = (name: string): string => path.join(tmpRoot, 'shared', name);
    const multi = { TargetFrameworks: 'net8.0;net10.0' };
    const cs = writeCSharpConsole;
    net7Console = cs(at('Net7Console'), 'Net7Console', {
      properties: { TargetFramework: 'net7.0' },
    });
    renamedFs = writeFSharpConsole(at('OriginalFs'), 'OriginalFs', {
      properties: { AssemblyName: 'RenamedFs' },
    });
    renamedCs = cs(at('OriginalCs'), 'OriginalCs', { properties: { AssemblyName: 'RenamedCs' } });
    customOut = cs(at('CustomOut'), 'CustomOut', { properties: { OutputPath: 'out/' } });
    multiBuilt = cs(at('MultiBuilt'), 'MultiBuilt', { properties: multi });
    multiUnbuilt = cs(at('MultiUnbuilt'), 'MultiUnbuilt', { properties: multi });
    for (const project of [net7Console, renamedFs, renamedCs, customOut])
      await buildProject(project);
    // Only ONE of the two target frameworks is built, on purpose.
    await dotnet(['build', multiBuilt.projectFile, '-c', 'Debug', '-f', 'net8.0'], multiBuilt.dir);
  });

  suiteTeardown(() => {
    removeDirRecursive(tmpRoot);
  });

  setup(() => {
    caseDir = fs.mkdtempSync(path.join(tmpRoot, 'case-'));
    stubs = installUiStubs();
    sessions = new DebugSessionRecorder();
    tasks = new TaskRecorder();
  });

  teardown(async function () {
    // Awaits stopAnyDebugSession's DEBUG_SESSION_MS poll; the ceiling must sit
    // above it so the poll's own message wins ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    this.timeout(DEBUG_SESSION_MS + 5_000);
    stubs.restore();
    await stopAnyDebugSession();
    sessions.dispose();
    tasks.dispose();
    for (const terminal of vscode.window.terminals) {
      if (terminal.name === BUILD_TERMINAL) terminal.dispose();
    }
    await closeAllEditors();
    removeDirRecursive(caseDir);
  });

  // B28 — an unbuilt project must never resolve to a path that does not exist.
  // Implements [DEBUG-FEATURES-LAUNCH-BUILD]
  test('an unbuilt project resolves to nothing or to a real file, and to MSBuild once built', async function () {
    this.timeout(DOTNET_CLI_MS);
    const project = writeCSharpConsole(path.join(caseDir, 'Unbuilt'), 'Unbuilt');
    const rel = 'bin/Debug/net10.0/Unbuilt.dll';

    // 1 — open the source. Nothing has been compiled yet.
    const editor = await focusDocument(project.sourceFile);
    assert.strictEqual(editor.document.languageId, 'csharp', 'a .cs fixture must open as C#');
    const source = comparableText(editor.document.getText());
    assert.strictEqual(source, UNBUILT_SRC, 'the fixture is exactly what the build compiles');
    assert.strictEqual(project.assemblyName, 'Unbuilt', 'no <AssemblyName>, so the file name wins');
    assertDirEntries(project.dir, ['Program.cs', 'Unbuilt.csproj'], 'fixture must start unbuilt');

    // 2 — the entry helper every caller of `findProjectFile` funnels through.
    const entry = projectEntryFromFile(project.projectFile);
    assertNeverFabricated('unbuilt projectEntryFromFile', entry.dll); // B28
    const entryCwd = comparablePath(entry.cwd);
    assert.strictEqual(entryCwd, comparablePath(project.dir), 'cwd is the project dir regardless');
    assert.strictEqual(
      entry.dll === undefined || path.isAbsolute(entry.dll),
      true,
      `an unbuilt project resolves to nothing, or to an absolute path (${String(entry.dll)})`,
    );
    assert.strictEqual(entry.dll, undefined, 'and nothing is built yet, so it resolves to nothing');

    // 3 — F5 with no launch.json, against a project with no output.
    const unbuiltMark = complaintMark();
    const unbuilt = await resolveProgram(project);
    assertResolutionOutcome(project, unbuilt, complaintsSince(unbuiltMark)); // B28
    await sessions.assertNoSession('resolving a configuration must not start a debug session');
    await tasks.assertNoTask('resolving a configuration must not run the dotnet CLI');
    const types = sessions.started.map((session) => session.type);
    assert.deepStrictEqual(types, [], 'resolution must start no session of ANY debug type');

    // 4 — build for real; the directory step 1 proved empty now has output.
    await buildProject(project);
    const target = await targetPathOf(project);
    assert.strictEqual(path.basename(target), 'Unbuilt.dll', 'MSBuild names the assembly');
    assert.strictEqual(relativeOutput(project, target), rel, 'the default single-TFM SDK layout');
    assert.strictEqual(fs.existsSync(symbolsFor(target)), true, 'Debug emits the .pdb beside it');
    const madeBin = fs.readdirSync(project.dir).includes('bin');
    assert.strictEqual(madeBin, true, 'the build changed the directory step 1 proved was empty');

    // 5 — resolve again. The answer must now be MSBuild's, and only MSBuild's.
    // An implicit build in step 3 is allowed, but only if it produced THIS file.
    const builtMark = complaintMark();
    const built = await resolveFocused('built console project', project, rel); // B28
    assert.deepStrictEqual(complaintsSince(builtMark), [], 'success must show the user nothing');
    assert.strictEqual(comparablePath(built), comparablePath(target), 'and it is MSBuild’s answer');
    const implicit = comparablePath(String(unbuilt)) === comparablePath(target);
    assert.strictEqual(
      unbuilt === undefined || implicit,
      true,
      `step 3 must refuse or build ${rel}`,
    );
    await sessions.assertNoSession('a second resolution still starts nothing');
    await tasks.assertNoTask('a second resolution still runs nothing');
    assert.deepStrictEqual(stubs.log.infoMessages, [], 'a successful resolution informs nobody');
  });

  // B29 / B30 / B32 — MSBuild is the authority for TFM, assembly name and output
  // directory alike. Implements [DEBUG-FEATURES-LAUNCH-BUILD]
  test('MSBuild decides the output: net7.0, custom AssemblyName (F# then C#), custom OutputPath', async function () {
    this.timeout(DOTNET_CLI_MS);

    // 1 — a project whose ONLY target framework is outside the hardcoded list.
    // B29: a resolver restricted to net10.0/net9.0/net8.0 can never see it.
    assertDirEntries(
      path.join(net7Console.dir, 'bin', 'Debug'),
      ['net7.0'],
      'B29: net7.0 was built',
    );
    const net7Program = await resolveFocused(
      'net7.0',
      net7Console,
      'bin/Debug/net7.0/Net7Console.dll',
    ); // B29
    const substituted = net7Program.includes('net10.0');
    assert.strictEqual(substituted, false, 'B29: never substitute an untargeted framework');

    // 2 — F# FIRST: <AssemblyName> renames the output, the .fsproj name does not.
    const fsFile = path.basename(renamedFs.projectFile);
    assert.strictEqual(fsFile, 'OriginalFs.fsproj', 'B30 premise: file name ≠ assembly name');
    assert.strictEqual(renamedFs.assemblyName, 'RenamedFs', '<AssemblyName> is what MSBuild emits');
    const fsRel = 'bin/Debug/net10.0/RenamedFs.dll';
    const fsProgram = await resolveFocused('renamed F#', renamedFs, fsRel); // B30
    const lang = vscode.window.activeTextEditor?.document.languageId;
    assert.strictEqual(lang, 'fsharp', 'F# is a first-class launch target, resolved before C#');
    const ghost = path.join(renamedFs.dir, 'bin', 'Debug', 'net10.0', 'OriginalFs.dll');
    assert.strictEqual(fs.existsSync(ghost), false, 'B30: the project-file name names no file');
    const moved = comparablePath(fsProgram) !== comparablePath(net7Program);
    assert.strictEqual(moved, true, 'focusing another project must change the resolved target');

    // 3 — the same rule in C#, so neither language is special-cased.
    const csRel = 'bin/Debug/net10.0/RenamedCs.dll';
    const csProgram = await resolveFocused('renamed C#', renamedCs, csRel); // B30
    assert.strictEqual(path.basename(csProgram), 'RenamedCs.dll', 'B30: <AssemblyName> wins in C#');

    // 4 — <OutputPath> moves the whole tree out from under bin/.
    const outProgram = await resolveFocused('OutputPath', customOut, 'out/net10.0/CustomOut.dll');
    const underBin = fs.existsSync(path.join(customOut.dir, 'bin'));
    assert.strictEqual(underBin, false, 'B32: probing bin/ finds nothing once OutputPath moves it');

    // 5 — four projects, four distinct real assemblies, nothing else happened.
    const programs = [net7Program, fsProgram, csProgram, outProgram];
    const onDisk = programs.map((program) => fs.existsSync(program));
    assert.deepStrictEqual(onDisk, [true, true, true, true], 'all four programs are real files');
    const names = programs.map((program) => path.basename(program));
    const expected = ['Net7Console.dll', 'RenamedFs.dll', 'RenamedCs.dll', 'CustomOut.dll'];
    assert.deepStrictEqual(names, expected, 'each focus resolved its OWN project, in order');
    assert.strictEqual(
      new Set(programs.map(comparablePath)).size,
      4,
      'four projects, four targets',
    );
    const active = comparablePath(vscode.window.activeTextEditor?.document.uri.fsPath ?? '');
    assert.strictEqual(active, comparablePath(customOut.sourceFile), 'last focus is still active');
    await sessions.assertNoSession('four resolutions must not start a single debug session');
    await tasks.assertNoTask('four resolutions must not run the dotnet CLI');
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'resolvable projects warn nobody');
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'resolvable projects error nobody');
  });

  // B31 — multi-targeted projects. Implements [DEBUG-FEATURES-LAUNCH-BUILD]
  test('a multi-targeted project resolves the TFM that exists, and fabricates none when nothing does', async function () {
    this.timeout(DOTNET_CLI_MS);
    const terminalsBefore = buildTerminalCount();

    // 1 — the premise the whole case rests on, taken from MSBuild itself: this
    // is exactly why the resolver has to re-query with -p:TargetFramework.
    const bare = await targetPathOf(multiBuilt);
    assert.strictEqual(bare, '', 'B31: a bare TargetPath query on a multi-TFM project is EMPTY');
    const outputs = path.join(multiBuilt.dir, 'bin', 'Debug');
    assertDirEntries(outputs, ['net8.0'], 'B31: exactly one of the two frameworks was built');

    // 2 — with one TFM on disk, that is the TFM to launch.
    const rel = 'bin/Debug/net8.0/MultiBuilt.dll';
    const builtProgram = await resolveFocused('multi-TFM', multiBuilt, rel, 'net8.0'); // B31
    const net10 = fs.existsSync(path.join(outputs, 'net10.0'));
    assert.strictEqual(net10, false, 'the net10.0 output must be absent for this case to mean it');
    assert.strictEqual(fs.existsSync(symbolsFor(builtProgram)), true, 'the TFM chosen has symbols');

    // 3 — the same shape with NOTHING built: no TFM output exists at all.
    await focusDocument(multiUnbuilt.sourceFile);
    const files = ['MultiUnbuilt.csproj', 'Program.cs'];
    assertDirEntries(multiUnbuilt.dir, files, 'the second multi-TFM fixture was never built');
    const unbuiltEntry = projectEntryFromFile(multiUnbuilt.projectFile);
    assertNeverFabricated('unbuilt multi-TFM projectEntryFromFile', unbuiltEntry.dll); // B31
    const unbuiltMark = complaintMark();
    const unbuilt = await resolveProgram(multiUnbuilt);
    assertResolutionOutcome(multiUnbuilt, unbuilt, complaintsSince(unbuiltMark)); // B31
    const guessed = String(unbuilt).includes('net10.0');
    assert.strictEqual(guessed, false, 'B31: fall back to the FIRST TFM (net8.0), never net10.0');
    const distinct = comparablePath(String(unbuilt)) !== comparablePath(builtProgram);
    assert.strictEqual(distinct, true, 'two projects must not resolve to the same program');

    // 4 — neither resolution ran, started or opened anything.
    await sessions.assertNoSession('multi-TFM resolution must not start a debug session');
    await tasks.assertNoTask('multi-TFM resolution must not run the dotnet CLI');
    assert.strictEqual(buildTerminalCount(), terminalsBefore, 'and opened no build terminal');
  });

  // B33 — one request, one build, dispatched as a task.
  // Implements [DEBUG-FEATURES-LAUNCH-BUILD]
  test('a build request runs exactly one build, as a sharplsp-build task and not in a terminal', async function () {
    this.timeout(DOTNET_CLI_MS);
    const project = writeCSharpConsole(path.join(caseDir, 'BuildOnce'), 'BuildOnce');

    // 1 — an unbuilt project, focused, with the command registered.
    await focusDocument(project.sourceFile);
    await assertCommandRegistered(CMD_BUILD);
    // Probe preLaunchTask on a SEPARATE project. Resolving performs the
    // pre-launch build ([DEBUG-FEATURES-LAUNCH-BUILD] rule 1), so probing it on
    // BuildOnce would leave BuildOnce already built and this test — whose whole
    // subject is that ONE build runs — with nothing left to observe.
    await assertPreLaunchTask(writeCSharpConsole(path.join(caseDir, 'ProbeTask'), 'ProbeTask')); // B33
    const terminalsBefore = buildTerminalCount();
    const files = ['BuildOnce.csproj', 'Program.cs'];
    assertDirEntries(project.dir, files, 'the fixture must start unbuilt so a build has work');

    // 2 — invoke the real command against the fixture project node.
    const outcome = await invokeCommand(CMD_BUILD, { projectFilePath: project.projectFile });
    assert.strictEqual(outcome.rejected, false, `'${CMD_BUILD}' must resolve: ${outcome.message}`);
    assert.strictEqual(outcome.message, '', 'a successful build reports no failure message');

    // 3 — exactly one build, and it is a SharpLsp task with observable args.
    const dotnetTasks = await tasks.waitForDotnetTasks(1, TASK_OBSERVE_MS);
    const once = 'B33: one observable vscode.Task, not a terminal racing a headless build';
    assert.strictEqual(dotnetTasks.length, 1, once);
    const types = tasks.started.map((task) => task.definitionType);
    assert.deepStrictEqual(types, [BUILD_TASK_TYPE], `B33: never the foreign '${FOREIGN_TASK}'`);
    const commands = dotnetTasks.map((task) => task.command);
    // The CLI the extension actually resolves — `sharplsp.dotnetPath` when set,
    // else the SDK found on PATH. A hardcoded 'dotnet' asserts the wrong thing on
    // any machine whose SDK is not reachable by that bare name.
    // Assert on the executable's NAME, not its full path. The extension resolves
    // the SDK at runtime (bare `dotnet` on PATH, an absolute path once the
    // runtime probe finishes, or `sharplsp.dotnetPath` when set), so pinning the
    // literal string asserts the machine's layout rather than the behaviour.
    // What must hold is that ONE task ran the dotnet CLI directly.
    assert.strictEqual(commands.length, 1, 'exactly one command was run');
    const cli = binaryNameOf(String(commands[0]));
    assert.strictEqual(
      cli,
      'dotnet',
      `the one task runs the dotnet CLI; got ${String(commands[0])}`,
    );
    const args = dotnetTasks[0]?.args;
    assert.deepStrictEqual(args, ['build', project.projectFile], 'B33: builds only what was asked');
    assert.strictEqual(dotnetTasks[0]?.source, 'SharpLsp', 'the task is attributed to SharpLsp');

    // 4 — and NOT a second, unobservable build typed into a terminal, which
    // reports no exit code and races the headless build on the same obj/.
    const opened = buildTerminalCount() - terminalsBefore;
    assert.strictEqual(opened, 0, `B33: no '${BUILD_TERMINAL}' terminal may be opened`);
    const started = tasks.started.length;
    assert.strictEqual(started, tasks.dotnetTasks.length, 'no task but the dotnet build ran'); // B33

    // 5 — one process, exit 0, and the output MSBuild promised.
    const exits = await tasks.waitForExits(1, TASK_OBSERVE_MS);
    assert.deepStrictEqual(exits, [0], 'B33: exactly one build process ran, and it succeeded');
    assert.strictEqual(tasks.dotnetTasks.length, 1, 'B33: still one build once it finished');
    const target = await targetPathOf(project);
    assert.strictEqual(fs.existsSync(target), true, `the build must produce ${target}`);
    assert.strictEqual(fs.existsSync(symbolsFor(target)), true, 'and the symbols beside it');
    const madeBin = fs.readdirSync(project.dir).includes('bin');
    assert.strictEqual(madeBin, true, 'the task built the project it was handed, in its own dir');

    // 6 — the freshly built project now resolves to that same assembly.
    const rel = 'bin/Debug/net10.0/BuildOnce.dll';
    const program = await resolveFocused('freshly built', project, rel);
    assert.strictEqual(comparablePath(program), comparablePath(target), 'MSBuild had the answer');
    await sessions.assertNoSession('a build command must not start a debug session');
    assert.deepStrictEqual(stubs.log.errorMessages, [], 'a successful build shows no error toast');
    assert.deepStrictEqual(stubs.log.warningMessages, [], 'a successful build shows no warning');
  });
});
