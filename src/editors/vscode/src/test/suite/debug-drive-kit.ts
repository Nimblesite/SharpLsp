// The debugging gestures a user actually makes, and what the workbench must
// report afterwards.
//
// Spec: [DEBUG-FEATURES-STEPPING], [DEBUG-FEATURES-STACK],
// [DEBUG-FEATURES-VARIABLES], [DEBUG-FEATURES-BREAKPOINTS].
//
// Every driver here dispatches the SAME command id the keybinding does — F10 is
// `workbench.action.debug.stepOver`, F11 `…stepInto`, Shift+F11 `…stepOut`, F5
// `…continue` — and then waits for the adapter to report a new `stopped` event.
// Dispatching without waiting is the classic false green: the command resolves
// immediately, so the following assertions read the PREVIOUS stop and pass while
// stepping is entirely broken.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AnchoredSource } from './debug-anchors';
import { DapRecorder, dap, type StopRecord } from './debug-dap-kit';
import { DEBUG_SESSION_MS } from './test-timeouts';
import type { DebugFixture } from './debug-fixture-programs';
import { comparablePath, pollUntilResult } from './test-helpers';

/** F10. */
export const CMD_STEP_OVER = 'workbench.action.debug.stepOver';
/** F11. */
export const CMD_STEP_INTO = 'workbench.action.debug.stepInto';
/** Shift+F11. */
export const CMD_STEP_OUT = 'workbench.action.debug.stepOut';
/** F5 while stopped. */
export const CMD_CONTINUE = 'workbench.action.debug.continue';
/** F6. */
export const CMD_PAUSE = 'workbench.action.debug.pause';
/** Ctrl/Cmd+Shift+F5. */
export const CMD_RESTART = 'workbench.action.debug.restart';
/** Shift+F5. */
export const CMD_STOP = 'workbench.action.debug.stop';
/** The editor context-menu entry [DEBUG-FEATURES-STEPPING] calls "Run to cursor". */
export const CMD_RUN_TO_CURSOR = 'editor.debug.action.runToCursor';
/** F9 — the gutter toggle gated by `contributes.breakpoints`. */
export const CMD_TOGGLE_BREAKPOINT = 'editor.debug.action.toggleBreakpoint';

/** One `stackTrace` frame, flattened to the fields the specification names. */
export interface Frame {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly sourcePath: string;
  readonly presentationHint: string;
}

/** One `variables` entry, flattened. */
export interface Variable {
  readonly name: string;
  readonly value: string;
  readonly type: string;
  readonly reference: number;
  readonly evaluateName: string;
}

/** One `scopes` entry. */
export interface Scope {
  readonly name: string;
  readonly reference: number;
  readonly expensive: boolean;
}

/** The active session, failing with the specified reason when there is none. */
export function activeSession(): vscode.DebugSession {
  const session = vscode.debug.activeDebugSession;
  assert.ok(
    session,
    'a debug session must be active; without one every stepping gesture is a silent no-op',
  );
  return session;
}

/** Flatten one raw `stackTrace` frame. */
function frameFrom(raw: Record<string, any>): Frame {
  const source = (raw['source'] ?? {}) as Record<string, any>;
  return {
    id: Number(raw['id'] ?? -1),
    name: String(raw['name'] ?? ''),
    line: Number(raw['line'] ?? -1),
    column: Number(raw['column'] ?? -1),
    sourcePath: String(source['path'] ?? ''),
    presentationHint: String(raw['presentationHint'] ?? ''),
  };
}

/** Flatten one raw `variables` entry. */
function variableFrom(raw: Record<string, any>): Variable {
  return {
    name: String(raw['name'] ?? ''),
    value: String(raw['value'] ?? ''),
    type: String(raw['type'] ?? ''),
    reference: Number(raw['variablesReference'] ?? 0),
    evaluateName: String(raw['evaluateName'] ?? ''),
  };
}

/** The debuggee's threads, per the DAP `threads` request. */
export async function threadsOf(session: vscode.DebugSession): Promise<Record<string, any>[]> {
  const body = await dap(session, 'threads');
  const threads: unknown = body['threads'];
  assert.ok(Array.isArray(threads), '`threads` must answer with a threads array');
  return threads as Record<string, any>[];
}

/** The call stack of `threadId`, deepest-callee first, as DAP orders it. */
export async function stackFrames(
  session: vscode.DebugSession,
  threadId: number,
  levels = 32,
): Promise<Frame[]> {
  const body = await dap(session, 'stackTrace', { threadId, startFrame: 0, levels });
  const frames: unknown = body['stackFrames'];
  assert.ok(Array.isArray(frames), '`stackTrace` must answer with a stackFrames array');
  return frames.map((frame) => frameFrom(frame as Record<string, any>));
}

/** The frame execution is stopped in — frame 0 of the stopped thread. */
export async function topFrame(session: vscode.DebugSession, threadId: number): Promise<Frame> {
  const frames = await stackFrames(session, threadId, 1);
  assert.ok(frames.length > 0, '`stackTrace` must report at least the frame the debuggee is in');
  return frames[0]!;
}

/** The scopes of `frameId` — `Locals` and whatever else the adapter exposes. */
export async function scopesOf(session: vscode.DebugSession, frameId: number): Promise<Scope[]> {
  const body = await dap(session, 'scopes', { frameId });
  const scopes: unknown = body['scopes'];
  assert.ok(Array.isArray(scopes), '`scopes` must answer with a scopes array');
  return scopes.map((scope) => ({
    name: String((scope as Record<string, any>)['name'] ?? ''),
    reference: Number((scope as Record<string, any>)['variablesReference'] ?? 0),
    expensive: (scope as Record<string, any>)['expensive'] === true,
  }));
}

/** The children of a `variablesReference` — a scope, an object, or an array. */
export async function variablesOf(
  session: vscode.DebugSession,
  reference: number,
): Promise<Variable[]> {
  assert.notStrictEqual(reference, 0, 'a zero variablesReference has no children to request');
  const body = await dap(session, 'variables', { variablesReference: reference });
  const variables: unknown = body['variables'];
  assert.ok(Array.isArray(variables), '`variables` must answer with a variables array');
  return variables.map((variable) => variableFrom(variable as Record<string, any>));
}

/**
 * The locals of `frameId`.
 *
 * [DEBUG-FEATURES-VARIABLES] makes "Local variables", "Function arguments" and
 * "`this` / instance members" three separate P1 rows, and every one of them
 * arrives through the scope netcoredbg names `Locals`.
 */
export async function localsOf(session: vscode.DebugSession, frameId: number): Promise<Variable[]> {
  return variablesOf(session, (await localsScopeOf(session, frameId)).reference);
}

/**
 * The `Locals` scope of `frameId`.
 *
 * `setVariable` addresses a variable by its CONTAINER's reference plus its name,
 * so a test that modifies a local needs the scope itself, not just its contents.
 */
export async function localsScopeOf(session: vscode.DebugSession, frameId: number): Promise<Scope> {
  const scopes = await scopesOf(session, frameId);
  const locals = scopes.find((scope) => scope.name.toLowerCase().includes('local'));
  assert.ok(
    locals,
    `a stopped frame must expose a Locals scope; scopes offered: ${scopes
      .map((scope) => scope.name)
      .join(', ')}`,
  );
  return locals;
}

/** One named variable out of a list, failing with what WAS offered. */
export function variableNamed(variables: readonly Variable[], name: string): Variable {
  const match = variables.find((variable) => variable.name === name);
  assert.ok(
    match,
    `'${name}' must be inspectable; the frame offered: ${variables
      .map((variable) => variable.name)
      .join(', ')}`,
  );
  return match;
}

/** Evaluate `expression` in `frameId`. `context` is hover, watch or repl. */
export async function evaluate(
  session: vscode.DebugSession,
  expression: string,
  frameId: number,
  context: 'hover' | 'watch' | 'repl',
): Promise<Variable> {
  const body = await dap(session, 'evaluate', { expression, frameId, context });
  return variableFrom({ ...body, name: expression, value: body['result'] });
}

/** Dispatch a workbench command, failing loudly instead of swallowing a reject. */
export async function gesture(command: string, ...args: unknown[]): Promise<void> {
  try {
    await vscode.commands.executeCommand(command, ...args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert.fail(`the '${command}' gesture must not reject: ${detail}`);
  }
}

/**
 * Make one stepping gesture and wait for the debuggee to come to rest again.
 *
 * Returns the NEW stop, never a stale one: the baseline is taken before the
 * command is dispatched.
 */
export async function stepAndStop(
  recorder: DapRecorder,
  command: string,
  timeoutMs = DEBUG_SESSION_MS,
): Promise<StopRecord> {
  const baseline = recorder.stops().length;
  await gesture(command);
  const stops = await recorder.waitForStops(baseline + 1, timeoutMs);
  return stops[stops.length - 1]!;
}

/** Step, then read the frame the debuggee came to rest in. One call, one step. */
export async function stepToFrame(
  recorder: DapRecorder,
  command: string,
): Promise<{ stop: StopRecord; frame: Frame }> {
  const stop = await stepAndStop(recorder, command);
  const frame = await topFrame(activeSession(), stop.threadId);
  return { stop, frame };
}

/** Assert a `stopped` event carries the specified reason. */
export function assertStopReason(stop: StopRecord, reason: string, why: string): void {
  const accepted = ACCEPTED_REASONS.get(reason) ?? [reason];
  assert.ok(
    accepted.includes(stop.reason),
    `${why}: the DAP stop reason must be one of ${accepted.join(' | ')}, ` +
      `was '${stop.reason}' (${stop.description})`,
  );
  assert.ok(stop.threadId > 0, `${why}: a stop must name the thread it happened on`);
}

/**
 * Stop reasons netcoredbg reports differently from the DAP specification.
 *
 * It answers a function breakpoint with the plain `breakpoint` reason
 * ([DEBUG-ADAPTER-GAPS]). Which KIND of breakpoint stopped is identified from
 * the breakpoint that bound, not from this string, so accepting both is exact
 * rather than lenient — pinning the spec's spelling would assert a behaviour
 * this adapter does not have and can never gain from anything SharpLsp does.
 */
const ACCEPTED_REASONS = new Map<string, string[]>([
  ['function breakpoint', ['function breakpoint', 'breakpoint']],
]);

/** Assert the debuggee is stopped on the statement `anchor` addresses. */
export function assertFrameAt(
  frame: Frame,
  source: AnchoredSource,
  anchor: string,
  why: string,
): void {
  assert.strictEqual(
    frame.line,
    source.dapLine(anchor),
    `${why}: expected to stop on line ${String(source.dapLine(anchor))} ` +
      `(${source.code(anchor).trim()}), stopped on line ${String(frame.line)} in ${frame.name}`,
  );
  assert.ok(frame.column > 0, `${why}: a DAP frame must carry a 1-based column`);
}

/** Assert the frame's source really is the fixture the test wrote. */
export function assertFrameSource(frame: Frame, fixture: DebugFixture, why: string): void {
  assert.strictEqual(
    comparablePath(frame.sourcePath),
    comparablePath(fixture.sourceFile),
    `${why}: the frame must be attributed to the fixture source, not to ${frame.sourcePath}`,
  );
}

/** Assert `frame` is at `anchor` in `fixture`, and named `expected`. */
export function assertStoppedAt(
  frame: Frame,
  fixture: DebugFixture,
  anchor: string,
  expectedName: string,
  why: string,
): void {
  assertFrameAt(frame, fixture.source, anchor, why);
  assertFrameSource(frame, fixture, why);
  assert.ok(
    frame.name.includes(expectedName),
    `${why}: the frame must name ${expectedName}; DAP reported '${frame.name}'`,
  );
}

/** Wait until VS Code's own stack-item focus catches up with the adapter. */
export async function waitForActiveFrame(
  timeoutMs = DEBUG_SESSION_MS,
): Promise<vscode.DebugStackFrame> {
  const item = await pollUntilResult(
    async () => vscode.debug.activeStackItem,
    (current) => current instanceof vscode.DebugStackFrame,
    timeoutMs,
    50,
  );
  assert.ok(
    item instanceof vscode.DebugStackFrame,
    'a stopped session must focus a stack frame; `vscode.debug.activeStackItem` is what the ' +
      'editor uses to place the yellow instruction pointer, so an unfocused stop leaves the ' +
      'user staring at an unmarked file',
  );
  return item;
}

/** Open the debuggee's source and make it the active editor. */
export async function openFixture(fixture: DebugFixture): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(fixture.uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  assert.strictEqual(
    document.languageId,
    fixture.languageId,
    `the debuggee source must open as a ${fixture.languageId} document — the language id is ` +
      'what gates `contributes.breakpoints`, the F5 auto-pick and every debug editor action',
  );
  return editor;
}

/**
 * Put the caret on the statement `anchor` addresses.
 *
 * "Run to cursor" and the F9 gutter toggle both act on the ACTIVE editor's
 * selection, so a test that forgets this drives them against whatever document
 * the previous test left open.
 */
export async function focusAnchor(
  fixture: DebugFixture,
  anchor: string,
): Promise<vscode.TextEditor> {
  const editor = await openFixture(fixture);
  const position = fixture.source.position(anchor);
  editor.selection = new vscode.Selection(position, position);
  assert.strictEqual(
    editor.selection.active.line,
    fixture.source.line(anchor),
    `the caret must sit on '${anchor}' before an editor-scoped debug action`,
  );
  return editor;
}

/**
 * Make `commands.length` gestures in order and report where each one landed.
 *
 * Stepping is a SEQUENCE — "F10 three times walks the loop and never enters the
 * callee" is one claim about four stops, not four independent claims — so the
 * whole walk is captured and asserted at once.
 */
export async function walk(
  recorder: DapRecorder,
  commands: readonly string[],
): Promise<{ stops: StopRecord[]; frames: Frame[] }> {
  const stops: StopRecord[] = [];
  const frames: Frame[] = [];
  for (const command of commands) {
    const landed = await stepToFrame(recorder, command);
    stops.push(landed.stop);
    frames.push(landed.frame);
  }
  return { stops, frames };
}

/** Render frames as `<method>@<line>`, the form a walk assertion compares. */
export function trace(frames: readonly Frame[]): string[] {
  return frames.map((frame) => `${methodOf(frame)}@${String(frame.line)}`);
}

/** The bare method name of a frame, with any namespace/class qualifier dropped. */
export function methodOf(frame: Frame): string {
  const withoutArgs = frame.name.split('(')[0] ?? frame.name;
  const parts = withoutArgs.trim().split('.');
  return parts[parts.length - 1] ?? withoutArgs;
}

/** The `<method>@<line>` label a walk must produce for one anchor. */
export function at(fixture: DebugFixture, method: string, anchor: string): string {
  return `${method}@${String(fixture.source.dapLine(anchor))}`;
}

/** A DAP `exceptionInfo` response, flattened to the fields the panel shows. */
export interface ExceptionInfo {
  readonly exceptionId: string;
  readonly description: string;
  readonly breakMode: string;
  readonly typeName: string;
  readonly message: string;
  readonly stackTrace: string;
  readonly innerMessages: readonly string[];
}

/** Every message in an `ExceptionDetails` chain, outermost first. */
function innerChain(details: Record<string, any>): string[] {
  const messages: string[] = [];
  let inner: unknown = details['innerException'];
  while (Array.isArray(inner) && inner.length > 0) {
    const next = inner[0] as Record<string, any>;
    messages.push(String(next['message'] ?? ''));
    inner = next['innerException'];
  }
  return messages;
}

/**
 * The exception the debuggee stopped on.
 *
 * [DEBUG-FEATURES-EXCEPTIONS] makes "Exception info panel (type, message,
 * stack)" a P1 row and "Inner exception chain traversal" a P2 one; both are
 * carried by this single request, so both are read here.
 */
export async function exceptionInfoOf(
  session: vscode.DebugSession,
  threadId: number,
): Promise<ExceptionInfo> {
  const body = await dap(session, 'exceptionInfo', { threadId });
  const details = (body['details'] ?? {}) as Record<string, any>;
  return {
    exceptionId: String(body['exceptionId'] ?? ''),
    description: String(body['description'] ?? ''),
    breakMode: String(body['breakMode'] ?? ''),
    typeName: String(details['typeName'] ?? ''),
    message: String(details['message'] ?? ''),
    stackTrace: String(details['stackTrace'] ?? ''),
    innerMessages: innerChain(details),
  };
}

/** Assert the exception panel names the right type and the right message. */
export function assertExceptionIs(
  info: ExceptionInfo,
  typeName: string,
  message: string,
  why: string,
): void {
  const identity = `${info.exceptionId} / ${info.typeName}`;
  assert.ok(
    identity.includes(typeName),
    `${why}: the exception panel must name ${typeName}; it reported '${identity}'`,
  );
  const text = `${info.description} ${info.message}`;
  assert.ok(
    text.includes(message),
    `${why}: the exception panel must carry the message '${message}'; it reported '${text}'`,
  );
}
