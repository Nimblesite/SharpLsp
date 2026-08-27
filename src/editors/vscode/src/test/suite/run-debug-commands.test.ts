// The real user gestures: F5, Ctrl/Cmd+F5, "Run Program" and "Debug Program".
//
// Spec: [DEBUG-FEATURES-LAUNCH-NOCONFIG], [DEBUG-FEATURES-LAUNCH-NODEBUG],
// [DEBUG-FEATURES-LAUNCH-TARGET].
//
// This suite encodes the bug report verbatim — "if I hit F5 it should start
// debugging and I should be able to do Run Without Debugging" — so every test
// drives a SEQUENCE of interactions (focus a document, press the key, inspect
// what the workbench reports, focus another document, press again) and asserts
// exact values, their relationships, and the negatives: no second session, no
// stray notification, no cached target.
//
// Two techniques carry the weight:
//
//  * The SPY PROVIDER. A second `DebugConfigurationProvider` on the shipped
//    debug type records what the resolve chain hands it and returns `undefined`,
//    which cancels the launch cleanly — so F5 and Ctrl+F5 are observable with no
//    debug adapter present. A provider that THROWS rejects the whole chain and
//    the spy is never reached; that is precisely the reported crash.
//  * REAL BUILT PROJECTS inside the committed workspace folder. A target exists
//    only once `dotnet build` produced a dll, and `session.workspaceFolder` is
//    defined only when the document belongs to an open folder — a temp dir would
//    exercise the "outside every workspace folder" refusal instead.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SharpLspLaunchProvider } from '../../debug.js';
import {
  BUILD_TIMEOUT_MS,
  CMD_DEBUG_PROGRAM,
  CMD_RUN_PROGRAM,
  CMD_VSCODE_DEBUG_RUN,
  CMD_VSCODE_DEBUG_START,
  DEBUG_TYPE_ID,
  DebugSessionRecorder,
  OBSERVE_TIMEOUT_MS,
  adapterAvailable,
  assertCommandRegistered,
  emptyF5Config,
  fakeFolder,
  focusDocument,
  invokeCommand,
  stopAnyDebugSession,
  type ObservedSession,
} from './run-debug-kit';
import {
  buildProject,
  builtDll,
  isolateFromRepoMsbuild,
  writeCSharpConsole,
  type ConsoleProject,
} from './run-debug-fixtures';
import {
  closeAllEditors,
  comparablePath,
  pollUntilResult,
  removeDirRecursive,
  requireAt,
  requireWorkspaceRoot,
} from './test-helpers';
import { installUiStubs, type UiStubs } from './ui-stubs';

// This suite is assertion-dense by design and CLAUDE.md caps a file at 500 LOC,
// so the three assert forms it uses are bound once instead of being spelled out
// — every call still asserts an exact VALUE, with a message naming the contract.
type Compare = (actual: unknown, expected: unknown, message: string) => void;
const eq: Compare = assert.strictEqual;
const neq: Compare = assert.notStrictEqual;
const deepEq: Compare = assert.deepStrictEqual;

/** How long to wait for the resolve chain to reach the spy before failing. */
const CHAIN_TIMEOUT_MS = 15_000;

/** How long to wait for a stopped session to leave the workbench. */
const TEARDOWN_TIMEOUT_MS = 20_000;

/** One configuration the resolve chain handed to the spy provider. */
interface ResolveCapture {
  readonly folderPath: string | undefined;
  readonly config: vscode.DebugConfiguration;
}

/** The outcome of calling the shipped provider directly. */
interface ProviderResolution {
  readonly config: vscode.DebugConfiguration | undefined;
  readonly error: string;
}

/** Every user-visible refusal the extension issued, errors first. */
function refusals(stubs: UiStubs): string[] {
  return [...stubs.log.errorMessages, ...stubs.log.warningMessages];
}

/** The `program` a resolved configuration names, normalised for comparison. */
function programOf(config: Record<string, any> | undefined): string {
  return comparablePath(String(config?.['program']));
}

/** The `cwd` a resolved configuration names, normalised for comparison. */
function cwdOf(config: Record<string, any>): string {
  return comparablePath(String(config['cwd']));
}

/** Assert a filesystem path equals `expected`, case/separator-normalised. */
function samePath(actual: string | undefined, expected: string, message: string): void {
  eq(comparablePath(actual ?? ''), comparablePath(expected), message);
}

/**
 * Assert `key` is ABSENT from the configuration VS Code built.
 *
 * F5 with no launch.json arrives as an `Object.create(null)` bag: `type`,
 * `request` and `name` are missing keys, not empty strings, and reading
 * `.length` off one of them is the reported crash.
 */
function assertAbsent(config: vscode.DebugConfiguration, key: string, why: string): void {
  eq(Object.prototype.hasOwnProperty.call(config, key), false, `\`${key}\` ${why}`);
}

/**
 * Call the SHIPPED provider directly and report a throw as a value.
 *
 * [DEBUG-FEATURES-LAUNCH-NOCONFIG] rule 2: the provider MUST NOT throw for any
 * input. Catching turns "it threw" into a named assertion failure instead of an
 * unattributed TypeError in the mocha report.
 */
async function resolveThroughProvider(
  folder: vscode.WorkspaceFolder,
  config: vscode.DebugConfiguration,
): Promise<ProviderResolution> {
  try {
    const resolved = await new SharpLspLaunchProvider().resolveDebugConfiguration(folder, config);
    return { config: resolved ?? undefined, error: '' };
  } catch (error) {
    return { config: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Wait until the spy has recorded at least `count` configurations. */
async function waitForCaptures(
  captures: readonly ResolveCapture[],
  count: number,
): Promise<readonly ResolveCapture[]> {
  const reached = (seen: readonly ResolveCapture[]): boolean => seen.length >= count;
  return pollUntilResult(async () => captures, reached, CHAIN_TIMEOUT_MS, 100);
}

/** Stop the active session and wait for the workbench to forget it. */
async function stopAndSettle(rec: DebugSessionRecorder, id: string): Promise<readonly string[]> {
  await stopAnyDebugSession();
  const gone = (session: vscode.DebugSession | undefined): boolean => session === undefined;
  await pollUntilResult(
    async () => vscode.debug.activeDebugSession,
    gone,
    TEARDOWN_TIMEOUT_MS,
    100,
  );
  const ended = (ids: readonly string[]): boolean => ids.includes(id);
  return pollUntilResult(async () => rec.terminated, ended, TEARDOWN_TIMEOUT_MS, 100);
}

/** The shape every SharpLsp session must have, whichever gesture started it. */
function assertSessionShape(session: ObservedSession, gesture: string): void {
  eq(session.type, DEBUG_TYPE_ID, `${gesture} must start a SharpLsp session`);
  eq(session.configuration['request'], 'launch', `${gesture} must launch, never attach`);
  neq(session.name, '', `${gesture} must name its session for the debug toolbar`);
  neq(session.workspaceFolder, undefined, `${gesture} must bind the session to a folder`);
}

suite('Run and Debug commands — the F5 / Ctrl+F5 gestures', () => {
  let workspaceRoot: string;
  let scratchDir: string;
  let appA: ConsoleProject;
  let appB: ConsoleProject;
  let unbuilt: ConsoleProject;
  let stubs: UiStubs;
  let recorder: DebugSessionRecorder;
  let spy: vscode.Disposable | undefined;
  let captures: ResolveCapture[];

  suiteSetup(async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    workspaceRoot = requireWorkspaceRoot();
    scratchDir = fs.mkdtempSync(path.join(workspaceRoot, 'run-debug-cmds-'));
    isolateFromRepoMsbuild(scratchDir);
    appA = writeCSharpConsole(path.join(scratchDir, 'AppA'), 'AppA', { marker: 'run-debug A' });
    appB = writeCSharpConsole(path.join(scratchDir, 'AppB'), 'AppB', { marker: 'run-debug B' });
    unbuilt = writeCSharpConsole(path.join(scratchDir, 'Unbuilt'), 'Unbuilt', {
      marker: 'unbuilt',
    });
    await buildProject(appA);
    await buildProject(appB);
  });

  suiteTeardown(() => {
    removeDirRecursive(scratchDir);
  });

  setup(() => {
    stubs = installUiStubs();
    recorder = new DebugSessionRecorder();
    captures = [];
    spy = undefined;
  });

  teardown(async () => {
    stubs.restore();
    spy?.dispose();
    await stopAnyDebugSession();
    recorder.dispose();
    await closeAllEditors();
  });

  /** Register the spy that records what the resolve chain passes downstream. */
  function registerSpy(): void {
    spy = vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE_ID, {
      resolveDebugConfiguration: (folder, config) => {
        captures.push({ folderPath: folder?.uri.fsPath, config });
        // `undefined` cancels the launch silently — no adapter is ever needed.
        return undefined;
      },
    });
  }

  // Implements [DEBUG-FEATURES-LAUNCH-NOCONFIG], [DEBUG-FEATURES-LAUNCH-NODEBUG].
  test('F5 then Ctrl+F5 with no launch.json both reach the provider chain', async function () {
    this.timeout(OBSERVE_TIMEOUT_MS);
    registerSpy();

    // Interaction 1 — focus a C# document so VS Code's debugger guess is
    // unambiguous and no "Select debugger" quick pick can appear.
    const editor = await focusDocument(appA.sourceFile);
    eq(editor.document.languageId, 'csharp', 'the fixture must open as a C# document');
    samePath(editor.document.uri.fsPath, appA.sourceFile, 'the focused document picks the target');
    deepEq(captures, [], 'focusing a document must not resolve any configuration');

    // Interaction 2 — press F5.
    const f5 = await invokeCommand(CMD_VSCODE_DEBUG_START);
    eq(f5.rejected, false, `F5 must not reject: ${f5.message}`); // B08
    const afterF5 = await waitForCaptures(captures, 1);
    eq(
      afterF5.length,
      1,
      'F5 must reach every provider on the debug type; a provider that throws rejects the ' +
        'whole chain — the reported "Cannot read properties of undefined" crash',
    ); // B08
    const debugCapture = requireAt(afterF5, 0, 'the config F5 handed the chain');
    eq(typeof debugCapture.config, 'object', 'the resolve chain must be passed an object'); // B08
    neq(debugCapture.config, null, 'the resolve chain must not be passed null'); // B08
    assertAbsent(debugCapture.config, 'type', 'is absent on the no-launch.json path'); // B08
    assertAbsent(debugCapture.config, 'request', 'is absent; reading .length off it throws'); // B08
    assertAbsent(debugCapture.config, 'name', 'is absent; reading .length off it throws'); // B08
    neq(debugCapture.config['noDebug'], true, 'plain F5 is a DEBUG request, not a run'); // B09
    samePath(debugCapture.folderPath, workspaceRoot, 'the chain gets the document’s folder');
    deepEq(
      recorder.ours.map((s) => s.name),
      [],
      'a cancelled resolve starts no session',
    );

    // Interaction 3 — press Ctrl/Cmd+F5, Run Without Debugging.
    const ctrlF5 = await invokeCommand(CMD_VSCODE_DEBUG_RUN);
    eq(ctrlF5.rejected, false, `Ctrl+F5 must not reject: ${ctrlF5.message}`); // B09
    const afterRun = await waitForCaptures(captures, 2);
    eq(afterRun.length, 2, 'Ctrl+F5 must reach the provider chain exactly once more'); // B09
    const runCapture = requireAt(afterRun, 1, 'the config Ctrl+F5 handed the chain');
    eq(
      runCapture.config['noDebug'],
      true,
      'Ctrl+F5 is debug.start with noDebug stamped BEFORE the provider chain runs',
    ); // B09
    assertAbsent(runCapture.config, 'type', 'is absent for Ctrl+F5 exactly as it is for F5'); // B09
    neq(runCapture.config, debugCapture.config, 'each gesture builds its own config object');
    samePath(runCapture.folderPath, workspaceRoot, 'run resolves against the same folder as debug');

    // Interaction 4 — focus the OTHER project and press F5 again.
    await focusDocument(appB.sourceFile);
    const again = await invokeCommand(CMD_VSCODE_DEBUG_START);
    eq(again.rejected, false, `the second F5 must not reject either: ${again.message}`);
    const afterSecond = await waitForCaptures(captures, 3);
    eq(afterSecond.length, 3, 'every F5 press must reach the provider chain');
    const secondCapture = requireAt(afterSecond, 2, 'the config the second F5 handed the chain');
    neq(secondCapture.config['noDebug'], true, 'noDebug must not leak from the earlier Ctrl+F5'); // B09
    deepEq(
      recorder.ours.map((s) => s.id),
      [],
      'three cancelled resolves, zero sessions',
    );
    deepEq(recorder.terminated, [], 'nothing started, so nothing may have terminated');
    deepEq(stubs.log.errorMessages, [], 'a cleanly cancelled launch is not an extension error');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-NODEBUG], [DEBUG-FEATURES-LAUNCH-TARGET].
  test('Run and Debug start one session each on the identical target', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    if (!adapterAvailable()) this.skip();

    // Interaction 1 — the palette must offer both commands.
    const commands = await vscode.commands.getCommands(true);
    deepEq(
      [CMD_DEBUG_PROGRAM, CMD_RUN_PROGRAM].filter((id) => commands.includes(id)),
      [CMD_DEBUG_PROGRAM, CMD_RUN_PROGRAM],
      'a user who can debug a project must be able to run it: both must be registered',
    ); // B11
    await assertCommandRegistered(CMD_RUN_PROGRAM); // B11

    // Interaction 2 — focus the built project's entry point.
    const dllA = builtDll(appA);
    eq(fs.existsSync(dllA), true, `the fixture build must have produced ${dllA}`);
    await focusDocument(appA.sourceFile);

    // Interaction 3 — Run Without Debugging.
    const run = await invokeCommand(CMD_RUN_PROGRAM);
    eq(run.rejected, false, `${CMD_RUN_PROGRAM} must exist and succeed: ${run.message}`); // B11
    eq(run.message, '', 'a successful run reports no failure message');
    const afterRun = await recorder.waitForSessions(1);
    eq(afterRun.length, 1, 'Run must start exactly one debug session'); // B15
    const runSession = requireAt(afterRun, 0, 'the session Run started');
    const runCfg = runSession.configuration;
    assertSessionShape(runSession, 'Run Without Debugging'); // B15, B63
    eq(runCfg['noDebug'], true, 'Run must go through startDebugging with noDebug:true'); // B15
    eq(programOf(runCfg), comparablePath(dllA), 'Run launches the dll the build produced'); // B15
    eq(cwdOf(runCfg), comparablePath(appA.dir), 'cwd must be the project directory'); // B63
    samePath(runSession.workspaceFolder?.uri.fsPath, workspaceRoot, 'session folder is bound'); // B63
    eq(vscode.debug.activeDebugSession?.id, runSession.id, 'the session must be ACTIVE'); // B63
    eq(vscode.debug.activeDebugSession?.type, DEBUG_TYPE_ID, 'the active session is ours'); // B63
    deepEq(
      vscode.debug.activeDebugSession?.configuration,
      runCfg,
      'the active session carries the very configuration the start event reported',
    ); // B63

    // Interaction 4 — stop it from the debug toolbar.
    const terminated = await stopAndSettle(recorder, runSession.id);
    deepEq(
      terminated.filter((id) => id === runSession.id),
      [runSession.id],
      'a run started through startDebugging must be cancellable from the debug toolbar',
    );
    eq(vscode.debug.activeDebugSession, undefined, 'stopping must clear the active session');

    // Interaction 5 — Debug the same document.
    const dbg = await invokeCommand(CMD_DEBUG_PROGRAM);
    eq(dbg.rejected, false, `${CMD_DEBUG_PROGRAM} must succeed: ${dbg.message}`);
    const afterDebug = await recorder.waitForSessions(2);
    eq(afterDebug.length, 2, 'Debug must start a second session'); // B16
    const debugSession = requireAt(afterDebug, 1, 'the session Debug started');
    const dbgCfg = debugSession.configuration;
    assertSessionShape(debugSession, 'Debug Program');
    neq(dbgCfg['noDebug'], true, 'Debug must NOT set noDebug — the sole difference'); // B16
    // B15, B16 — one resolver, two flags.
    eq(programOf(dbgCfg), programOf(runCfg), 'Run and Debug must resolve the identical target');
    eq(cwdOf(dbgCfg), cwdOf(runCfg), 'Run and Debug must share the cwd too'); // B16
    neq(debugSession.id, runSession.id, 'the second gesture is a distinct session');
    deepEq(refusals(stubs), [], 'two successful launches must produce no refusal message');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-TARGET].
  test('Debug Program follows the focused document and agrees with the provider', async function () {
    this.timeout(BUILD_TIMEOUT_MS);
    if (!adapterAvailable()) this.skip();
    const folder = fakeFolder(workspaceRoot);
    const dllA = builtDll(appA);
    const dllB = builtDll(appB);

    // Interaction 1 — focus B, then resolve the SAME document through the
    // provider F5 uses. Both surfaces must agree; there is one resolver.
    await focusDocument(appB.sourceFile);
    const resolvedB = await resolveThroughProvider(folder, emptyF5Config());
    eq(resolvedB.error, '', 'the provider MUST NOT throw for the bare F5 configuration'); // B20
    const configB = resolvedB.config;
    neq(configB, undefined, 'a runnable project must resolve to a configuration');
    eq(configB?.type, DEBUG_TYPE_ID, 'a returned config with a falsy type is discarded silently');
    eq(configB?.request, 'launch', 'the synthesized request must be exactly "launch"');
    eq(programOf(configB), comparablePath(dllB), 'the ACTIVE document picks the target'); // B20

    // Interaction 2 — Debug Program on the same document.
    const first = await invokeCommand(CMD_DEBUG_PROGRAM);
    eq(first.rejected, false, `Debug Program must succeed for project B: ${first.message}`);
    const afterB = await recorder.waitForSessions(1);
    eq(afterB.length, 1, 'Debug Program must start exactly one session');
    const sessionB = requireAt(afterB, 0, 'the session started while B was focused');
    const cfgB = sessionB.configuration;
    assertSessionShape(sessionB, 'Debug Program on project B');
    eq(programOf(cfgB), comparablePath(dllB), 'focusing B must launch project B'); // B20
    eq(cwdOf(cfgB), comparablePath(appB.dir), 'the cwd must be project B’s directory');
    eq(programOf(cfgB), programOf(configB), 'the command and F5 must not diverge'); // B20

    // Interaction 3 — stop, then focus the OTHER project.
    await stopAndSettle(recorder, sessionB.id);
    await focusDocument(appA.sourceFile);
    const resolvedA = await resolveThroughProvider(folder, emptyF5Config());
    eq(resolvedA.error, '', 'the provider must stay total across a focus change');
    const configA = resolvedA.config;
    eq(programOf(configA), comparablePath(dllA), 'a focus change MUST change the target'); // B20
    neq(programOf(configA), programOf(configB), 'the previous target must not be reused'); // B20

    // Interaction 4 — Debug Program again, now on A.
    const second = await invokeCommand(CMD_DEBUG_PROGRAM);
    eq(second.rejected, false, `the second Debug Program must succeed: ${second.message}`);
    const afterA = await recorder.waitForSessions(2);
    eq(afterA.length, 2, 'the second gesture must start a second session');
    const sessionA = requireAt(afterA, 1, 'the session started while A was focused');
    const cfgA = sessionA.configuration;
    eq(programOf(cfgA), comparablePath(dllA), 'focusing A must launch project A'); // B20
    neq(programOf(cfgA), programOf(cfgB), 'the command is document-sensitive'); // B20
    eq(programOf(cfgA), programOf(configA), 'command and provider agree on A too'); // B20
    neq(sessionA.id, sessionB.id, 'two gestures produce two distinct sessions');
    deepEq(refusals(stubs), [], 'two resolvable targets must produce no refusal message');
  });

  // Implements [DEBUG-FEATURES-LAUNCH-NODEBUG].
  test('a refused launch is reported to the user instead of being swallowed', async function () {
    this.timeout(OBSERVE_TIMEOUT_MS);

    // Interaction 1 — a project that exists but was never built.
    const missingDll = builtDll(unbuilt);
    eq(fs.existsSync(unbuilt.projectFile), true, 'the refusal fixture is a real project file');
    eq(fs.existsSync(missingDll), false, 'the refusal fixture must NOT have been built'); // B62

    // Interaction 2 — focus it.
    const editor = await focusDocument(unbuilt.sourceFile);
    samePath(editor.document.uri.fsPath, unbuilt.sourceFile, 'the unbuilt document is active');
    deepEq(refusals(stubs), [], 'merely opening a document must not warn about anything');

    // Interaction 3 — Debug Program. startDebugging resolves false.
    const dbg = await invokeCommand(CMD_DEBUG_PROGRAM);
    eq(dbg.rejected, false, `a refusal is reported, not thrown at the caller: ${dbg.message}`); // B62
    await recorder.assertNoSession('a launch whose program is missing must start no session'); // B62
    const afterDebug = refusals(stubs);
    eq(
      afterDebug.length,
      1,
      'the discarded Promise<boolean> from startDebugging must be observed: exactly one ' +
        `message must tell the user the session was refused; saw ${afterDebug.length}`,
    ); // B62
    const debugMessage = requireAt(afterDebug, 0, 'the refusal message for Debug Program');
    neq(debugMessage, '', 'a refusal message must have content');
    eq(debugMessage.includes('Cannot read properties'), false, 'not a TypeError'); // B62
    deepEq(stubs.log.infoMessages, [], 'a refusal is not an informational message');
    eq(vscode.debug.activeDebugSession, undefined, 'a refused launch leaves no active session');

    // Interaction 4 — Run Without Debugging on the same document must refuse
    // identically: one resolver means one refusal, never a silent no-op.
    const run = await invokeCommand(CMD_RUN_PROGRAM);
    eq(run.rejected, false, `${CMD_RUN_PROGRAM} must exist and refuse cleanly: ${run.message}`); // B11
    await recorder.assertNoSession('Run must refuse the same unbuildable target Debug refused'); // B62
    const afterRun = refusals(stubs);
    eq(afterRun.length, 2, 'Run must produce exactly one further refusal message'); // B62
    const runMessage = requireAt(afterRun, 1, 'the refusal message for Run Without Debugging');
    neq(runMessage, '', 'the Run refusal must have content too');
    eq(runMessage.includes('Cannot read properties'), false, 'no leaked TypeError'); // B62
    deepEq(recorder.terminated, [], 'nothing started across either gesture, so nothing ended');
    eq(fs.existsSync(missingDll), false, 'a refused launch must not have built anything');
  });
});
