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
import * as vscode from 'vscode';
import {
  SharpLspLaunchProvider,
  findEntryProject,
  findProjectFile,
  projectEntryFromFile,
} from '../../debug.js';
import { buildProjectXml, createSolution, writeProject } from './dotnet-project-kit';
import {
  TFM,
  buildProject,
  markGitRoot,
  writeCSharpConsole,
  writeCSharpLibrary,
  writeFSharpConsole,
  type ConsoleProject,
} from './run-debug-fixtures';
import {
  BUILD_TIMEOUT_MS,
  CMD_DEBUG_PROGRAM,
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  QUIET_MS,
  TaskRecorder,
  assertCommandRegistered,
  emptyF5Config,
  fakeFolder,
  focusDocument,
  invokeCommand,
  legacyF5Config,
  stopAnyDebugSession,
  undefinedF5Config,
} from './run-debug-kit';
import {
  closeAllEditors,
  comparablePath,
  openCSharpFile,
  openFSharpFile,
  pollUntilResult,
  removeDirRecursive,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';

/** What one `resolveDebugConfiguration` call produced — a throw included. */
interface Resolved {
  readonly config: vscode.DebugConfiguration | undefined;
  readonly threw: string;
  readonly program: string | undefined;
  readonly cwd: string | undefined;
}

/** The observers armed before every interaction, so negatives are assertable. */
interface Quiet {
  readonly stubs: UiStubs;
  readonly sessions: DebugSessionRecorder;
  readonly tasks: TaskRecorder;
}

/** An F# class library — the fixtures kit ships only the C# one. */
function writeFSharpLibrary(dir: string, name: string): ConsoleProject {
  const xml = buildProjectXml({ compileIncludes: ['Library.fs'] });
  writeProject(
    dir,
    `${name}.fsproj`,
    xml,
    'Library.fs',
    `module ${name}.Calc\n\nlet add a b = a + b\n`,
  );
  return {
    projectFile: path.join(dir, `${name}.fsproj`),
    sourceFile: path.join(dir, 'Library.fs'),
    dir,
    assemblyName: name,
  };
}

/** One language's fixture writers. Every case runs for both, F# included. */
interface LangKit {
  readonly tag: string;
  readonly projectExt: string;
  readonly docName: string;
  readonly console: (dir: string, name: string) => ConsoleProject;
  readonly library: (dir: string, name: string) => ConsoleProject;
}

const LANGS: readonly LangKit[] = [
  {
    tag: 'Fs',
    projectExt: '.fsproj',
    docName: 'Note.fs',
    console: writeFSharpConsole,
    library: writeFSharpLibrary,
  },
  {
    tag: 'Cs',
    projectExt: '.csproj',
    docName: 'Note.cs',
    console: writeCSharpConsole,
    library: writeCSharpLibrary,
  },
];

/** Resolve a configuration against `root`, reporting a throw as data. */
async function resolveTarget(root: string, cfg: vscode.DebugConfiguration): Promise<Resolved> {
  const provider = new SharpLspLaunchProvider();
  try {
    const raw = await Promise.resolve(provider.resolveDebugConfiguration(fakeFolder(root), cfg));
    const config = raw ?? undefined;
    return { config, threw: '', program: config?.program, cwd: config?.cwd };
  } catch (error) {
    const threw = error instanceof Error ? error.message : String(error);
    return { config: undefined, threw, program: undefined, cwd: undefined };
  }
}

/** The `<name>.runtimeconfig.json` that evidences an executable assembly. */
function runtimeConfigFor(program: string): string {
  return `${program.slice(0, -path.extname(program).length)}.runtimeconfig.json`;
}

/** Assert the launch shape every resolved target must carry. */
function assertLaunchShape(outcome: Resolved, at: string): void {
  assert.strictEqual(outcome.threw, '', `${at}: the provider must never throw`);
  const config = outcome.config;
  assert.strictEqual(typeof config, 'object', `${at}: a serviceable request returns a config`);
  assert.deepStrictEqual(
    { type: config?.type, request: config?.request, justMyCode: config?.justMyCode },
    { type: DEBUG_TYPE_ID, request: 'launch', justMyCode: true },
    `${at}: F5 synthesizes a ${DEBUG_TYPE_ID} launch with Just My Code on`,
  );
}

/** Assert `program`/`cwd` name `project`'s own build output and directory. */
function assertProjectOutput(program: string, cwd: string, of: ConsoleProject, at: string): void {
  const dll = `${of.assemblyName}.dll`;
  assert.strictEqual(path.basename(program), dll, `${at}: must be ${dll}, not a neighbour's`);
  const under = comparablePath(program).startsWith(comparablePath(of.dir + path.sep));
  assert.strictEqual(under, true, `${at}: the program must sit under ${of.dir}; got ${program}`);
  assert.strictEqual(comparablePath(cwd), comparablePath(of.dir), `${at}: cwd is the project dir`);
  assert.strictEqual(path.isAbsolute(cwd), true, `${at}: cwd must be an absolute path`);
}

/** Assert `outcome` targets `project`'s assembly; returns the resolved program. */
function assertTargets(outcome: Resolved, project: ConsoleProject, at: string): string {
  assertLaunchShape(outcome, at);
  assert.strictEqual(typeof outcome.program, 'string', `${at}: program must resolve to a path`);
  const program = String(outcome.program);
  assert.strictEqual(path.isAbsolute(program), true, `${at}: the program must be absolute`);
  assert.strictEqual(path.extname(program), '.dll', `${at}: a managed launch target is a .dll`);
  assertProjectOutput(program, String(outcome.cwd), project, at);
  return program;
}

/** Assert the exported walkers pick exactly what the provider picked. */
function assertWalkersAgree(start: string, stop: string, of: ConsoleProject, dll: string): void {
  const at = `walkers for ${path.basename(of.projectFile)}`;
  const walked = findProjectFile(start, stop);
  assert.notStrictEqual(walked, undefined, `${at}: the cone walk must find the project`);
  const want = comparablePath(dll);
  assert.strictEqual(comparablePath(walked?.dll ?? ''), want, `${at}: one resolver, one answer`);
  const dir = comparablePath(of.dir);
  assert.strictEqual(comparablePath(walked?.cwd ?? ''), dir, `${at}: the walk's cwd is the dir`);
  const direct = projectEntryFromFile(of.projectFile);
  assert.strictEqual(comparablePath(direct.dll), want, `${at}: projectEntryFromFile agrees too`);
  assert.strictEqual(comparablePath(direct.cwd), dir, `${at}: and on the cwd`);
  const entry = findEntryProject(of.dir);
  assert.strictEqual(comparablePath(entry?.dll ?? ''), want, `${at}: findEntryProject agrees too`);
}

/** Assert the cone walk from `start` refuses to leave the cone and take `decoy`. */
function assertNoEscape(start: string, stop: string, decoy: ConsoleProject, at: string): void {
  const entry = findProjectFile(start, stop);
  const selected = comparablePath(entry?.cwd ?? '');
  const outside = comparablePath(decoy.dir);
  assert.notStrictEqual(selected, outside, `${at}: a project above the cone is never the target`);
  const strayDll = comparablePath(projectEntryFromFile(decoy.projectFile).dll);
  assert.notStrictEqual(comparablePath(entry?.dll ?? ''), strayDll, `${at}: nor is its assembly`);
  assert.strictEqual(entry, undefined, `${at}: the walk must stop; it returned ${selected}`);
}

/** Assert a class library was refused as a launch target. */
function assertNotRunnable(outcome: Resolved, built: string, at: string): void {
  assert.strictEqual(outcome.threw, '', `${at}: refusing a library must not throw`);
  assert.strictEqual(fs.existsSync(built), true, `${at}: the fixture library must really be built`);
  const evidence = fs.existsSync(runtimeConfigFor(built));
  assert.strictEqual(
    evidence,
    false,
    `${at}: a library emits no runtimeconfig — the discriminator`,
  );
  const program = outcome.program;
  const runnable = program === undefined || fs.existsSync(runtimeConfigFor(program));
  assert.strictEqual(runnable, true, `${at}: ${String(program)} has no runtimeconfig.json`);
  const chosen = comparablePath(String(program));
  assert.notStrictEqual(chosen, comparablePath(built), `${at}: the library dll is unlaunchable`);
}

/** Everything one QuickPick item shows the user, as one searchable string. */
function pickText(item: unknown): string {
  if (typeof item === 'string') return item;
  const shown = item as { label?: string; description?: string; detail?: string };
  return [shown.label, shown.description, shown.detail].filter((p) => p !== undefined).join(' ');
}

/** Assert one QuickPick offered exactly `expected`, by project file name. */
function assertOffered(items: readonly unknown[], expected: readonly string[], at: string): void {
  const texts = items.map(pickText);
  const seen = JSON.stringify(texts);
  assert.strictEqual(texts.length, expected.length, `${at}: one item per project; got ${seen}`);
  const named = expected.filter((name) => texts.some((text) => text.includes(name)));
  assert.deepStrictEqual(
    named,
    [...expected],
    `${at}: every file name must be offered; got ${seen}`,
  );
  const known = texts.filter((text) => expected.some((name) => text.includes(name)));
  assert.strictEqual(known.length, texts.length, `${at}: no item may name an absent project`);
  assert.strictEqual(new Set(texts).size, texts.length, `${at}: the items must be distinguishable`);
}

/** A picker that chooses whichever offered item names `projectFile`. */
function chooses(projectFile: string): (items: readonly unknown[]) => unknown {
  return (items) => items.find((item) => pickText(item).includes(projectFile));
}

/** Assert an interaction produced no UI and no side effect whatsoever. */
async function assertSilent(q: Quiet, at: string, quietMs = 0): Promise<void> {
  assert.deepStrictEqual(q.stubs.log.warningMessages, [], `${at}: an exact target warns nothing`);
  assert.deepStrictEqual(q.stubs.log.errorMessages, [], `${at}: an exact target errors nothing`);
  assert.strictEqual(
    q.stubs.log.quickPickItems.length,
    0,
    `${at}: an exact target prompts nothing`,
  );
  await q.sessions.assertNoSession(`${at}: resolving never starts a session`, quietMs);
  await q.tasks.assertNoTask(`${at}: resolving never runs a task`, quietMs);
  assert.deepStrictEqual([...q.sessions.terminated], [], `${at}: nothing started, nothing ended`);
  assert.deepStrictEqual([...q.tasks.exits], [], `${at}: no task process reported an exit code`);
}

/** Close every editor and prove nothing is focused. */
async function clearFocus(): Promise<void> {
  await closeAllEditors();
  const idle = (editor: vscode.TextEditor | undefined): boolean => editor === undefined;
  const active = await pollUntilResult(
    async () => vscode.window.activeTextEditor,
    idle,
    5_000,
    100,
  );
  assert.strictEqual(active, undefined, 'no editor may be focused for a workspace-level resolve');
}

/** The nested tree every [SCRIPT-CONE] stop rule is asserted against. */
interface ConeLayout {
  /** The decoy above the cone that a leaking walk would select. */
  readonly decoy: ConsoleProject;
  readonly workspace: string;
  readonly deep: string;
  readonly note: string;
  /** A sibling of `workspace` — a start path OUTSIDE the stop path. */
  readonly outside: string;
  readonly solutionRoot: string;
  readonly repoSub: string;
  readonly gitDir: string;
  /** The directory ABOVE the decoy — a stop that only a rule can beat us to. */
  readonly above: string;
}

function buildConeLayout(root: string, lang: LangKit): ConeLayout {
  const outer = path.join(root, lang.tag);
  const decoy = lang.console(outer, `${lang.tag}Stray`);
  const workspace = path.join(outer, 'ws');
  const deep = path.join(workspace, 'deep');
  const outside = path.join(outer, 'outside');
  const solutionRoot = path.join(outer, 'sln');
  const repoSub = path.join(outer, 'repo', 'sub');
  for (const dir of [deep, outside, path.join(solutionRoot, 'deep'), repoSub]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const note = path.join(deep, lang.docName);
  fs.writeFileSync(note, '// no project owns this document\n', 'utf-8');
  const gitDir = markGitRoot(path.join(outer, 'repo'));
  return { decoy, workspace, deep, note, outside, solutionRoot, repoSub, gitDir, above: root };
}

// ── Interaction helpers ──────────────────────────────────────────

/** B18 — with no editor open, the single nested project is the target. */
async function assertNestedTarget(root: string, app: ConsoleProject, q: Quiet): Promise<string> {
  const at = 'B18 nested single project';
  const outcome = await resolveTarget(root, legacyF5Config());
  const dll = assertTargets(outcome, app, at);
  const nested = comparablePath(dll).includes(comparablePath(path.join('src', 'App')));
  assert.strictEqual(nested, true, `${at}: the program sits under src/App, the universal layout`);
  const entry = comparablePath(findEntryProject(root)?.dll ?? '');
  assert.strictEqual(entry, comparablePath(dll), `${at}: findEntryProject must descend`);
  assertWalkersAgree(app.dir, root, app, dll);
  await assertSilent(q, at);
  return dll;
}

/** B18 — every "no launch.json" shape VS Code sends must resolve one target. */
async function assertBareF5Agrees(root: string, expected: string, at: string): Promise<void> {
  const want = comparablePath(expected);
  const bare = await resolveTarget(root, emptyF5Config());
  assert.strictEqual(bare.threw, '', `${at}: the \`{}\` F5 configuration must not throw`);
  assert.strictEqual(typeof bare.program, 'string', `${at}: \`{}\` must resolve a program`);
  assert.strictEqual(comparablePath(String(bare.program)), want, `${at}: \`{}\` resolves the same`);
  assert.strictEqual(bare.config?.type, DEBUG_TYPE_ID, `${at}: \`{}\` is stamped with the type`);
  assert.strictEqual(bare.config?.request, 'launch', `${at}: \`{}\` becomes a launch request`);
  const undef = await resolveTarget(root, undefinedF5Config());
  assert.strictEqual(undef.threw, '', `${at}: the post-JSON undefined shape must not throw`);
  assert.strictEqual(comparablePath(String(undef.program)), want, `${at}: one target, any shape`);
  assert.strictEqual(undef.config?.request, 'launch', `${at}: and the same launch request`);
}

/** B19 — focus `to`, resolve, and prove the target moved off `from`. */
async function assertFocusFlips(
  root: string,
  from: ConsoleProject,
  to: ConsoleProject,
  fromDll: string,
): Promise<string> {
  const at = `B19 focus ${path.basename(to.dir)}`;
  await focusDocument(to.sourceFile);
  const active = comparablePath(vscode.window.activeTextEditor?.document.uri.fsPath ?? '');
  assert.strictEqual(active, comparablePath(to.sourceFile), `${at}: the document must be focused`);
  const dll = assertTargets(await resolveTarget(root, legacyF5Config()), to, at);
  assert.notStrictEqual(
    comparablePath(dll),
    comparablePath(fromDll),
    `${at}: a new focus, a new target`,
  );
  const stale = `${path.sep}${path.basename(from.dir)}${path.sep}`;
  const leaked = comparablePath(dll).includes(comparablePath(stale));
  assert.strictEqual(leaked, false, `${at}: ${path.basename(from.dir)} must not be selected`);
  assertWalkersAgree(path.dirname(to.sourceFile), root, to, dll);
  return dll;
}

/** B21/B22/B23 — every [SCRIPT-CONE] stop rule, against one language's decoy. */
async function assertConeStops(layout: ConeLayout, q: Quiet, at: string): Promise<void> {
  await focusDocument(layout.note);
  const { deep, workspace: ws, decoy, above } = layout;
  assertNoEscape(deep, ws, decoy, `${at} exact workspace-root stop`);
  assertNoEscape(deep, `${ws}${path.sep}`, decoy, `${at} trailing-separator stop path`);
  assertNoEscape(deep, `${ws}${path.sep}.`, decoy, `${at} unnormalized stop path`);
  assertNoEscape(layout.outside, ws, decoy, `${at} start path outside the stop path`);
  assertNoEscape(path.join(layout.solutionRoot, 'deep'), above, decoy, `${at} solution stop`);
  assertNoEscape(layout.repoSub, above, decoy, `${at} .git stop`);
  assert.strictEqual(findEntryProject(ws), undefined, `${at}: an empty cone has no entry project`);
  await clearFocus();
  const refused = await resolveTarget(ws, legacyF5Config());
  assert.strictEqual(refused.threw, '', `${at}: refusing a target must not throw`);
  assert.strictEqual(refused.config, undefined, `${at}: an unserviceable request returns nothing`);
  assert.strictEqual(refused.program, undefined, `${at}: nothing above the cone may be launched`);
  assert.strictEqual(refused.cwd, undefined, `${at}: and no cwd is invented either`);
  await q.sessions.assertNoSession(`${at}: a refused target starts no session`, 0);
  await q.tasks.assertNoTask(`${at}: a refused target runs no task`, 0);
}

/** B24 — two runnable projects in one directory must prompt, never guess. */
async function assertAmbiguityPrompts(
  dir: string,
  names: readonly string[],
  winner: ConsoleProject,
  q: Quiet,
): Promise<void> {
  const at = `B24 ${path.extname(winner.projectFile)}`;
  const seen = q.stubs.log.quickPickItems.length;
  q.stubs.queuePick(undefined);
  const cancelled = await resolveTarget(dir, legacyF5Config());
  assert.strictEqual(q.stubs.log.quickPickItems.length, seen + 1, `${at}: prompts exactly once`);
  assertOffered(q.stubs.log.quickPickItems[seen] ?? [], names, `${at} first prompt`);
  assert.strictEqual(cancelled.config, undefined, `${at}: cancelling resolves no configuration`);
  assert.strictEqual(cancelled.program, undefined, `${at}: cancelling resolves no program`);
  assert.deepStrictEqual(
    q.stubs.log.warningMessages,
    [],
    `${at}: an ambiguity prompts, never warns`,
  );
  await q.sessions.assertNoSession(`${at}: cancelling the prompt starts nothing`, 0);
  await q.tasks.assertNoTask(`${at}: cancelling the prompt runs nothing`, 0);
  await assertPickDecides(dir, names, winner, q, at, seen);
}

/** B24 — the second half: the user's pick, not `readdirSync` order, decides. */
async function assertPickDecides(
  dir: string,
  names: readonly string[],
  winner: ConsoleProject,
  q: Quiet,
  at: string,
  seen: number,
): Promise<void> {
  const chosenName = path.basename(winner.projectFile);
  q.stubs.queuePick(chooses(chosenName));
  const chosen = await resolveTarget(dir, legacyF5Config());
  const prompts = q.stubs.log.quickPickItems.length;
  assert.strictEqual(prompts, seen + 2, `${at}: a cancelled choice must not be cached`);
  assertOffered(q.stubs.log.quickPickItems[seen + 1] ?? [], names, `${at} second prompt`);
  const dll = assertTargets(chosen, winner, `${at} chose ${chosenName}`);
  assert.strictEqual(path.basename(dll), `${winner.assemblyName}.dll`, `${at}: the pick wins`);
  const loser = names.find((name) => name !== chosenName) ?? '';
  const loserDll = comparablePath(projectEntryFromFile(path.join(dir, loser)).dll);
  assert.notStrictEqual(comparablePath(dll), loserDll, `${at}: ${loser} must not be launched`);
  await q.sessions.assertNoSession(`${at}: a completed pick still starts no session`, 0);
}

/** B27 — runnable means `<name>.runtimeconfig.json` beside `<name>.dll`. */
async function assertLibraryRefused(root: string, lang: LangKit, q: Quiet): Promise<void> {
  const at = `B27 ${lang.projectExt}`;
  const runner = lang.console(path.join(root, 'runner'), `${lang.tag}Runner`);
  await buildProject(runner);
  const runnerDll = assertTargets(await resolveTarget(runner.dir, legacyF5Config()), runner, at);
  assert.strictEqual(fs.existsSync(runnerDll), true, `${at}: a resolved program must exist`);
  const evidence = fs.existsSync(runtimeConfigFor(runnerDll));
  assert.strictEqual(evidence, true, `${at}: an executable assembly ships a runtimeconfig.json`);
  const lib = lang.library(path.join(root, 'lib'), `${lang.tag}Calc`);
  await buildProject(lib);
  const libDll = path.join(lib.dir, 'bin', 'Debug', TFM, `${lang.tag}Calc.dll`);
  const refused = await resolveTarget(lib.dir, legacyF5Config());
  assertNotRunnable(refused, libDll, `${at} library`);
  const fell = comparablePath(String(refused.program));
  assert.notStrictEqual(fell, comparablePath(runnerDll), `${at}: no fallback to the last target`);
  await q.sessions.assertNoSession(`${at}: an unlaunchable assembly starts no session`, 0);
  await q.tasks.assertNoTask(`${at}: refusing a library runs no task`, 0);
}

/** B25 — a document outside every workspace folder is refused, not redirected. */
async function assertOrphanRefused(file: string, q: Quiet, expected: number): Promise<void> {
  const at = `B25 ${path.extname(file)}`;
  await focusDocument(file);
  const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  assert.strictEqual(owner, undefined, `${at}: the fixture must lie outside every folder`);
  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.strictEqual(folders.length > 0, true, `${at}: a folder must exist to be wrongly used`);
  const outcome = await invokeCommand(CMD_DEBUG_PROGRAM);
  assert.strictEqual(outcome.rejected, false, `${at}: the command must exist: ${outcome.message}`);
  await q.sessions.assertNoSession(`${at}: an orphan document must start no session`);
  await q.tasks.assertNoTask(`${at}: an orphan document must run no build task`, 0);
  const warnings = q.stubs.log.warningMessages;
  assert.strictEqual(
    warnings.length,
    expected,
    `${at}: one warning per call; ${JSON.stringify(warnings)}`,
  );
  assertRefusalNamesBoundary(warnings[expected - 1] ?? '', at);
  assert.strictEqual(q.stubs.log.quickPickItems.length, 0, `${at}: a refusal is not an ambiguity`);
  assert.deepStrictEqual(q.stubs.log.errorMessages, [], `${at}: a refusal warns, it never errors`);
}

/** The refusal must describe the boundary that was hit, not a missing project. */
function assertRefusalNamesBoundary(message: string, at: string): void {
  assert.strictEqual(typeof message, 'string', `${at}: the refusal must be text`);
  assert.strictEqual(message.length > 0, true, `${at}: an empty warning tells the user nothing`);
  const lower = message.toLowerCase();
  const names = lower.includes('workspace') || lower.includes('active document');
  assert.strictEqual(names, true, `${at}: name the boundary that was hit; got "${message}"`);
  const misdescribes = lower.includes('directory tree');
  assert.strictEqual(misdescribes, false, `${at}: the file's directory tree is not the reason`);
}

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
    this.timeout(BUILD_TIMEOUT_MS);
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
    this.timeout(BUILD_TIMEOUT_MS);
    for (const lang of LANGS) {
      const layout = buildConeLayout(tmpDir, lang);
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
    this.timeout(BUILD_TIMEOUT_MS);
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
    this.timeout(BUILD_TIMEOUT_MS * 2);
    for (const lang of LANGS) {
      await assertLibraryRefused(path.join(tmpDir, lang.tag), lang, q);
    }
  });

  // B25, B26 — refuse, never fall back to `workspaceFolders[0]`.
  test('the debug command refuses an out-of-workspace document and a blind invocation', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
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
