// The DAP proxy that sits between VS Code and netcoredbg.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER]'s Phase Four responsibilities that are
// reachable from the editor process: adapter lifecycle, DAP proxying, capability
// augmentation, and async stack enrichment. Without it the extension hands VS
// Code a bare `DebugAdapterExecutable`, and every proxy-layer feature the spec
// attributes to the router is simply absent.
//
// SCOPE. The spec sites the router in the Rust host and gives it more jobs than
// this class does — `[DebuggerDisplay]` emulation and logpoint emulation both
// need the C# sidecar, and continuation-following needs ICorDebug. Those are
// NOT implemented here. What is implemented is honest: a capability is only
// advertised once this file actually honours it, because over-claiming lights
// up VS Code UI for features that do not exist, which is worse than admitting
// the gap.
import * as cp from 'node:child_process';
import * as vscode from 'vscode';
import { enrichAsyncFrames, type RawFrame } from './dap-frames';
import { error, info } from './log';

/** DAP frames are `Content-Length: N\r\n\r\n<json>`; this is the separator. */
const HEADER_END = '\r\n\r\n';

/** The header that carries the payload length. */
const CONTENT_LENGTH = 'Content-Length: ';

/**
 * One DAP message, named where this file reads it and open elsewhere.
 *
 * The index signature matters: the router forwards messages it does not
 * understand untouched, so every field it never names must survive a spread.
 */
interface DapMessage {
  type?: unknown;
  command?: unknown;
  body?: unknown;
  arguments?: unknown;
  [field: string]: unknown;
}

/** The `stackTrace` response body, narrowed to what enrichment rewrites. */
interface StackTraceBody {
  stackFrames?: unknown;
  [field: string]: unknown;
}

/** Narrow an unknown to an object without asserting it is one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The launch/attach arguments, narrowed to the flag enrichment depends on. */
interface LaunchArguments {
  justMyCode?: unknown;
}

/** Narrow an unknown to launch/attach arguments. */
function isLaunchArguments(value: unknown): value is LaunchArguments {
  return isRecord(value);
}

/** Narrow the parsed frames to the shape the transform reads. */
function isFrameList(value: unknown): value is RawFrame[] {
  return Array.isArray(value);
}

/** Read the body length out of one DAP header block, if it is well-formed. */
function parseContentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    if (!line.startsWith(CONTENT_LENGTH)) continue;
    const value = Number.parseInt(line.slice(CONTENT_LENGTH.length), 10);
    return Number.isNaN(value) ? undefined : value;
  }
  return undefined;
}

/**
 * Capabilities the router itself supplies on top of whatever netcoredbg
 * reports.
 *
 * netcoredbg advertises ten capabilities; [DEBUG-PROTOCOL-CAPABILITIES] marks
 * far more as "Yes" for Phase Four. Only the ones this proxy genuinely honours
 * are added here:
 *
 * - `supportsEvaluateForHovers` — `evaluate` is forwarded verbatim and
 *   netcoredbg answers it, so the hover context needs nothing extra from us.
 *
 * The remaining Phase-Four rows (`supportsHitConditionalBreakpoints`,
 * `supportsLogPoints`, `supportsGotoTargetsRequest`, `supportsRestartRequest`,
 * `supportsExceptionOptions`, `supportsVariableType`, `supportsANSIStyling`)
 * are deliberately NOT claimed: this router does not implement them yet, and
 * claiming them would make VS Code offer UI that silently does nothing.
 */
const ROUTER_CAPABILITIES: Readonly<Record<string, boolean>> = {
  supportsEvaluateForHovers: true,
};

/**
 * Proxies DAP between VS Code and a netcoredbg child process, enriching the
 * messages the spec requires the router to enrich.
 */
export class DapRouter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private readonly child: cp.ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  /** Mirrors the launch argument so stack enrichment matches the user's choice. */
  private justMyCode = true;
  /** Set once the child is gone, so a late frame never reaches a dead session. */
  private closed = false;

  public readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.emitter.event;

  constructor(adapterPath: string) {
    info(`DapRouter starting netcoredbg: ${adapterPath}`);
    this.child = cp.spawn(adapterPath, ['--interpreter=vscode'], { stdio: 'pipe' });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.consume(chunk);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      error(`netcoredbg: ${chunk.toString('utf8').trimEnd()}`);
    });
    this.child.on('exit', (code) => {
      info(`netcoredbg exited with code ${String(code)}`);
      this.closed = true;
    });
    this.child.on('error', (cause: Error) => {
      error(`netcoredbg failed to start: ${cause.message}`);
      this.closed = true;
    });
  }

  /** VS Code -> netcoredbg. */
  public handleMessage(message: vscode.DebugProtocolMessage): void {
    if (!isRecord(message)) return;
    this.rememberLaunchOptions(message);
    this.write(message);
  }

  public dispose(): void {
    this.emitter.dispose();
    if (!this.closed) this.child.kill();
  }

  /** Track `justMyCode` off the launch/attach request that carries it. */
  private rememberLaunchOptions(message: DapMessage): void {
    if (message.command !== 'launch' && message.command !== 'attach') return;
    const args: unknown = message.arguments;
    if (!isLaunchArguments(args)) return;
    if (typeof args.justMyCode === 'boolean') this.justMyCode = args.justMyCode;
  }

  /** Serialise one message to the child using DAP's length-prefixed framing. */
  private write(message: DapMessage): void {
    if (this.closed) return;
    const body = JSON.stringify(message);
    this.child.stdin.write(
      `${CONTENT_LENGTH}${String(Buffer.byteLength(body))}${HEADER_END}${body}`,
    );
  }

  /** Accumulate child output and dispatch every complete frame it contains. */
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.takeFrame();
      if (frame === undefined) return;
      this.emitter.fire(this.enrich(frame));
    }
  }

  /** Split one complete frame off the front of the buffer, if there is one. */
  private takeFrame(): DapMessage | undefined {
    const end = this.buffer.indexOf(HEADER_END);
    if (end < 0) return undefined;
    const length = parseContentLength(this.buffer.subarray(0, end).toString('utf8'));
    if (length === undefined) return undefined;
    const start = end + HEADER_END.length;
    if (this.buffer.length < start + length) return undefined;
    const text = this.buffer.subarray(start, start + length).toString('utf8');
    this.buffer = this.buffer.subarray(start + length);
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  }

  /** netcoredbg -> VS Code, with the router's enrichments applied. */
  private enrich(message: DapMessage): DapMessage {
    if (message.type !== 'response') return message;
    if (message.command === 'initialize') return withRouterCapabilities(message);
    if (message.command === 'stackTrace') return this.withLogicalFrames(message);
    return message;
  }

  /** Rebuild a `stackTrace` body around the reconstructed logical chain. */
  private withLogicalFrames(message: DapMessage): DapMessage {
    const body: unknown = message.body;
    if (!isRecord(body)) return message;
    const stack: StackTraceBody = body;
    if (!isFrameList(stack.stackFrames)) return message;
    const logical = enrichAsyncFrames(stack.stackFrames, this.justMyCode);
    return { ...message, body: { ...stack, stackFrames: logical, totalFrames: logical.length } };
  }
}

/** Merge the router's own capabilities into an `initialize` response body. */
function withRouterCapabilities(message: DapMessage): DapMessage {
  const body: unknown = message.body;
  const existing = isRecord(body) ? body : {};
  return { ...message, body: { ...existing, ...ROUTER_CAPABILITIES } };
}
