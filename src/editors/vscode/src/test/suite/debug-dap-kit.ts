// The DAP wire, as the workbench itself saw it.
//
// Spec: [DEBUG-PROTOCOL], [DEBUG-PROTOCOL-CAPABILITIES],
// [DEBUG-ARCHITECTURE-NETCOREDBG].
//
// A stepping test cannot be written against `executeCommand` return values: the
// desktop host resolves `workbench.action.debug.stepOver` the instant it has
// dispatched, long before the debuggee has moved, and it resolves identically
// when nothing is running at all. The only honest record of what happened is the
// Debug Adapter Protocol traffic, which `registerDebugAdapterTrackerFactory`
// exposes verbatim — requests on their way to the adapter, responses and events
// on their way back.
//
// Unlike `registerDebugAdapterDescriptorFactory`, a TRACKER factory may be
// registered many times for one debug type, so this observes the shipped
// adapter rather than replacing it. Nothing here fakes a debugger: if the VSIX
// ships no netcoredbg, the session never starts and the suites say so.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DEBUG_TYPE_ID } from './run-debug-kit';
import { pollUntilResult, requireAt, sleep } from './test-helpers';

/** How long a launch, a step or a stop may take before a suite gives up. */
export const DAP_TIMEOUT_MS = 60_000;

/** Settle window for proving a stop did NOT happen — an ignored exception. */
export const DAP_QUIET_MS = 4_000;

/** One `event` message the adapter sent. */
export interface DapEvent {
  readonly event: string;
  readonly body: Record<string, any>;
}

/** One `response` message the adapter sent. */
export interface DapResponse {
  readonly command: string;
  readonly success: boolean;
  readonly message: string;
  readonly body: Record<string, any>;
}

/** One `request` message the workbench sent towards the adapter. */
export interface DapRequest {
  readonly command: string;
  readonly args: Record<string, any>;
}

/** A `stopped` event, unpacked into the fields the DAP specification names. */
export interface StopRecord {
  readonly reason: string;
  readonly threadId: number;
  readonly description: string;
  readonly text: string;
  readonly hitBreakpointIds: readonly number[];
  readonly allThreadsStopped: boolean;
}

/** The `body` of a message, always an object so `?.` chains are unnecessary. */
function bodyOf(message: Record<string, any>): Record<string, any> {
  const body: unknown = message['body'];
  return typeof body === 'object' && body !== null ? (body as Record<string, any>) : {};
}

/** Unpack one `stopped` event body into the specified fields. */
function stopFrom(body: Record<string, any>): StopRecord {
  const hits: unknown = body['hitBreakpointIds'];
  return {
    reason: String(body['reason'] ?? ''),
    threadId: Number(body['threadId'] ?? 0),
    description: String(body['description'] ?? ''),
    text: String(body['text'] ?? ''),
    hitBreakpointIds: Array.isArray(hits) ? hits.map(Number) : [],
    allThreadsStopped: body['allThreadsStopped'] === true,
  };
}

/**
 * Records the whole DAP conversation of every `sharplsp-coreclr` session.
 *
 * Install it in `setup`, BEFORE anything starts a session: the factory is
 * consulted once, when the session is created, so a recorder installed after the
 * launch observes an empty wire and every assertion built on it is vacuous.
 */
export class DapRecorder implements vscode.Disposable {
  private readonly sentMessages: Record<string, any>[] = [];
  private readonly receivedMessages: Record<string, any>[] = [];
  private readonly trackedSessions: string[] = [];
  private readonly adapterErrors: string[] = [];
  private readonly adapterExits: string[] = [];
  private readonly registration: vscode.Disposable;

  public constructor(debugType: string = DEBUG_TYPE_ID) {
    this.registration = vscode.debug.registerDebugAdapterTrackerFactory(debugType, {
      createDebugAdapterTracker: (session) => this.trackerFor(session),
    });
  }

  /** Build the per-session tracker that funnels the wire into this recorder. */
  private trackerFor(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    this.trackedSessions.push(session.id);
    return {
      onWillReceiveMessage: (message: Record<string, any>) => {
        this.receivedMessages.push(message);
      },
      onDidSendMessage: (message: Record<string, any>) => {
        this.sentMessages.push(message);
      },
      onError: (error: Error) => {
        this.adapterErrors.push(error.message);
      },
      onExit: (code: number | undefined, signal: string | undefined) => {
        this.adapterExits.push(`code=${String(code)} signal=${String(signal)}`);
      },
    };
  }

  /** Ids of the sessions this recorder was attached to, in creation order. */
  public get sessions(): readonly string[] {
    return this.trackedSessions;
  }

  /** Adapter transport errors. A conforming session produces none. */
  public get errors(): readonly string[] {
    return this.adapterErrors;
  }

  /** Adapter process exits, as `code=<n> signal=<s>` strings. */
  public get exits(): readonly string[] {
    return this.adapterExits;
  }

  /** Every `event` the adapter sent whose name is `name`, in arrival order. */
  public events(name: string): DapEvent[] {
    return this.sentMessages
      .filter((message) => message['type'] === 'event' && message['event'] === name)
      .map((message) => ({ event: name, body: bodyOf(message) }));
  }

  /** Every `response` the adapter sent for `command`, in arrival order. */
  public responses(command: string): DapResponse[] {
    return this.sentMessages
      .filter((message) => message['type'] === 'response' && message['command'] === command)
      .map((message) => ({
        command,
        success: message['success'] === true,
        message: String(message['message'] ?? ''),
        body: bodyOf(message),
      }));
  }

  /** Every `request` the workbench sent for `command`, in dispatch order. */
  public requests(command: string): DapRequest[] {
    return this.receivedMessages
      .filter((message) => message['type'] === 'request' && message['command'] === command)
      .map((message) => ({
        command,
        args: (message['arguments'] ?? {}) as Record<string, any>,
      }));
  }

  /**
   * Every request the workbench sent, in DISPATCH order, deduplicated by first
   * appearance. The DAP launch handshake is an ORDER — `initialize`, then
   * `launch`, then the configuration requests the `initialized` event unlocks,
   * then `configurationDone` — and a sorted list cannot express it.
   */
  public requestOrder(): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const message of this.receivedMessages) {
      if (message['type'] !== 'request') continue;
      const command = String(message['command']);
      if (seen.has(command)) continue;
      seen.add(command);
      order.push(command);
    }
    return order;
  }

  /**
   * Every REVERSE request the adapter sent to the client, for `command`.
   *
   * DAP reverse requests travel adapter -> client: `runInTerminal` (how a
   * `console: integratedTerminal` launch is realised) and `startDebugging` (how
   * a child process is auto-attached) are both specified behaviours that are
   * invisible on the forward channel.
   */
  public reverseRequests(command: string): DapRequest[] {
    return this.sentMessages
      .filter((message) => message['type'] === 'request' && message['command'] === command)
      .map((message) => ({
        command,
        args: (message['arguments'] ?? {}) as Record<string, any>,
      }));
  }

  /** Every command name the workbench asked the adapter for, deduplicated. */
  public requestedCommands(): string[] {
    const names = this.receivedMessages
      .filter((message) => message['type'] === 'request')
      .map((message) => String(message['command']));
    return [...new Set(names)].sort();
  }

  /**
   * The capabilities the adapter advertised in its `initialize` response.
   *
   * [DEBUG-PROTOCOL-CAPABILITIES] is a table of exactly these flags, so a suite
   * that wants to know whether conditional breakpoints are supported asks the
   * adapter, not the extension's opinion of the adapter.
   */
  public capabilities(): Record<string, any> {
    const initialize = this.responses('initialize');
    assert.ok(
      initialize.length > 0,
      'the adapter must answer `initialize`; no response means netcoredbg never started, ' +
        'which [DEBUG-ARCHITECTURE-NETCOREDBG] requires the VSIX to bundle for this platform',
    );
    return initialize[initialize.length - 1]?.body ?? {};
  }

  /** Every `stopped` event so far, unpacked. */
  public stops(): StopRecord[] {
    return this.events('stopped').map((event) => stopFrom(event.body));
  }

  /** The text of every `output` event, optionally narrowed to one category. */
  public outputText(category?: string): string {
    return this.events('output')
      .filter((event) => category === undefined || event.body['category'] === category)
      .map((event) => String(event.body['output'] ?? ''))
      .join('');
  }

  /** Wait until at least `count` `stopped` events have arrived. */
  public async waitForStops(count = 1, timeoutMs = DAP_TIMEOUT_MS): Promise<StopRecord[]> {
    const stops = await pollUntilResult(
      async () => this.stops(),
      (seen) => seen.length >= count,
      timeoutMs,
      50,
    );
    assert.ok(
      stops.length >= count,
      `the debuggee must stop ${String(count)} time(s); it stopped ${String(stops.length)}. ` +
        `Stops seen: ${JSON.stringify(stops.map((stop) => stop.reason))}`,
    );
    return stops;
  }

  /**
   * The `command` request the caller sent, found by POSITION rather than by
   * being first, and waited for rather than assumed to have landed.
   *
   * `requests()` is the whole wire, and the wire carries the workbench's own
   * traffic as well as the suite's. On `initialized` VS Code sends its
   * configuration burst, and for an adapter that advertises
   * `exceptionBreakpointFilters` — netcoredbg advertises `all` and
   * `user-unhandled`, neither marked `default` — that burst includes a
   * `setExceptionBreakpoints` carrying the filters the Breakpoints view has
   * ticked, which on a fresh profile is none:
   * `{"filters":[],"filterOptions":[]}`. Reading index 0 after sending one
   * therefore asserts against THAT request, whose `filters` is empty, instead
   * of the suite's own — and whether it is on the wire at all is VS Code's
   * scheduling, not the extension's, so the mistake shows up on one OS and
   * hides on another.
   *
   * Snapshot `requests(command).length` BEFORE sending, and the request at that
   * index is the first one to arrive afterwards: the caller's own, whatever
   * preceded it. The wait is what makes it deterministic — the tracker sees the
   * wire across the extension-host boundary, so `customRequest` resolving is not
   * proof the recording has caught up.
   */
  public async requestAfter(
    command: string,
    baseline: number,
    timeoutMs = DAP_TIMEOUT_MS,
  ): Promise<DapRequest> {
    const seen = await pollUntilResult(
      async () => this.requests(command),
      (all) => all.length > baseline,
      timeoutMs,
      50,
    );
    return requireAt(seen, baseline, `the '${command}' request the suite sent`);
  }

  /** Wait until at least `count` `name` events have arrived; returns them all. */
  public async waitForEvents(
    name: string,
    count = 1,
    timeoutMs = DAP_TIMEOUT_MS,
  ): Promise<DapEvent[]> {
    const events = await pollUntilResult(
      async () => this.events(name),
      (seen) => seen.length >= count,
      timeoutMs,
      50,
    );
    assert.ok(
      events.length >= count,
      `the adapter must send ${String(count)} '${name}' event(s); it sent ${String(events.length)}`,
    );
    return events;
  }

  /** Wait until the debuggee's output contains `needle`; returns all output. */
  public async waitForOutput(needle: string, timeoutMs = DAP_TIMEOUT_MS): Promise<string> {
    const text = await pollUntilResult(
      async () => this.outputText(),
      (seen) => seen.includes(needle),
      timeoutMs,
      50,
    );
    assert.ok(
      text.includes(needle),
      `the debuggee must emit '${needle}' as a DAP output event; saw: ${JSON.stringify(text)}`,
    );
    return text;
  }

  /**
   * Settle, then assert the debuggee did NOT stop again.
   *
   * This is the whole of "ignoring exceptions": a filter the user did not select
   * must leave the program running, and the only way to prove that is to wait
   * and find nothing.
   */
  public async assertNoFurtherStop(
    baseline: number,
    reason: string,
    quietMs = DAP_QUIET_MS,
  ): Promise<void> {
    await sleep(quietMs);
    const stops = this.stops();
    assert.deepStrictEqual(
      stops.slice(baseline).map((stop) => `${stop.reason}:${stop.text}`),
      [],
      reason,
    );
  }

  public dispose(): void {
    this.registration.dispose();
  }
}

/**
 * Send one DAP request through the live session and return its body.
 *
 * `customRequest` is the only public API that reaches requests VS Code's own UI
 * does not surface — `setExceptionBreakpoints` with explicit filters,
 * `exceptionInfo`, `setVariable`, `evaluate` in the `repl` context — and every
 * one of those is a P1 row of [DEBUG-FEATURES-EXCEPTIONS] or
 * [DEBUG-FEATURES-VARIABLES].
 */
export async function dap(
  session: vscode.DebugSession,
  command: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result: unknown = await session.customRequest(command, args);
  return typeof result === 'object' && result !== null ? (result as Record<string, any>) : {};
}

/** Send a DAP request and report a rejection as a value instead of throwing. */
export async function tryDap(
  session: vscode.DebugSession,
  command: string,
  args: Record<string, unknown> = {},
): Promise<{ body: Record<string, any>; failure: string }> {
  try {
    return { body: await dap(session, command, args), failure: '' };
  } catch (error) {
    return { body: {}, failure: error instanceof Error ? error.message : String(error) };
  }
}
