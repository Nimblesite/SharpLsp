// Session-scoped handle namespacing for the DAP proxy.
//
// Implements [DEBUG-FEATURES-MULTIPROCESS]: "DapRouter indexes independent
// adapter processes by session ID. Session-prefixed DAP messages multiplex
// them." Two netcoredbg processes each number their frames and variable
// references from 1, so a consumer that sees both sessions' handles cannot
// tell them apart. Each DapRouter therefore offsets every handle it forwards
// into its own private range, and maps requests back on the way in.
import { isRecord, recordList, type DapMessage } from './dap-emulate';

/** How far apart consecutive sessions' handle ranges sit. */
const RANGE = 1_000_000;

/** The next session's range base. Module-global: every router is distinct. */
let nextBase = 0;

/** One session's handle translator. */
export class HandleNamespace {
  private readonly base: number;

  constructor() {
    nextBase += 1;
    this.base = nextBase * RANGE;
  }

  /** Adapter handle -> session-scoped handle. Zero means "no handle" in DAP
   *  (a leaf variable) and is preserved; every other value is offset. */
  public outward(value: number): number {
    return value > 0 ? value + this.base : value;
  }

  /** Frame ids carry no "absent" sentinel — netcoredbg numbers from 0 — so
   *  every frame id, including 0, moves into the session's range. */
  public outwardFrameId(value: number): number {
    return value + this.base;
  }

  /** Session-scoped handle -> adapter handle. Values below the range are not
   *  ours (VS Code sends literal 0 for "no handle"); they pass through. */
  public inward(value: number): number {
    return value >= this.base ? value - this.base : value;
  }

  /** Rewrite every handle field one response body carries. */
  public translateResponseBody(message: DapMessage): DapMessage {
    const command = typeof message.command === 'string' ? message.command : '';
    const body = isRecord(message.body) ? message.body : undefined;
    if (body === undefined) return message;
    switch (command) {
      case 'stackTrace':
        return this.mapFrames(message, body);
      case 'scopes':
        return this.mapList(message, body, 'scopes', ['variablesReference']);
      case 'variables':
        return this.mapList(message, body, 'variables', ['variablesReference']);
      case 'evaluate':
        return this.mapFields(message, body, ['variablesReference']);
      case 'setBreakpoints':
        return this.mapList(message, body, 'breakpoints', ['id']);
      default:
        return message;
    }
  }

  /** Rewrite request arguments' handle fields back to adapter numbers. */
  public translateRequestArguments(message: DapMessage): DapMessage {
    const args = isRecord(message.arguments) ? message.arguments : undefined;
    if (args === undefined) return message;
    switch (typeof message.command === 'string' ? message.command : '') {
      case 'scopes':
      case 'restartFrame':
        return this.mapArgs(message, args, ['frameId']);
      case 'variables':
        return this.mapArgs(message, args, ['variablesReference']);
      case 'setVariable':
      case 'setExpression':
      case 'completions':
        return this.mapArgs(message, args, ['frameId', 'variablesReference']);
      case 'evaluate':
        return this.mapArgs(message, args, ['frameId']);
      default:
        return message;
    }
  }

  /** `stackFrames[].id` — the handle every later scopes/evaluate call quotes. */
  private mapFrames(message: DapMessage, body: Record<string, unknown>): DapMessage {
    const frames = recordList(body.stackFrames).map((frame) => ({
      ...frame,
      id: this.outwardFrameId(Number(frame.id ?? 0)),
    }));
    return { ...message, body: { ...body, stackFrames: frames } };
  }

  /** A `breakpoint` EVENT's `body.breakpoint.id`, same space as responses. */
  public translateEvent(message: DapMessage): DapMessage {
    const body = isRecord(message.body) ? message.body : undefined;
    const breakpoint = isRecord(body?.breakpoint) ? body.breakpoint : undefined;
    const id = breakpoint?.id;
    if (body === undefined || breakpoint === undefined || typeof id !== 'number' || id <= 0) {
      return message;
    }
    return {
      ...message,
      body: { ...body, breakpoint: { ...breakpoint, id: this.outward(id) } },
    };
  }

  /** One named list's handle fields, e.g. `scopes[].variablesReference`. */
  private mapList(
    message: DapMessage,
    body: Record<string, unknown>,
    field: string,
    handles: readonly string[],
  ): DapMessage {
    const translated = recordList(body[field]).map((entry) => {
      const copy = { ...entry };
      for (const handle of handles) {
        if (typeof copy[handle] === 'number') {
          copy[handle] = this.outward(copy[handle]);
        }
      }
      return copy;
    });
    return { ...message, body: { ...body, [field]: translated } };
  }

  /** Handle fields directly on a body object. */
  private mapFields(
    message: DapMessage,
    body: Record<string, unknown>,
    handles: readonly string[],
  ): DapMessage {
    const copy = { ...body };
    for (const handle of handles) {
      if (typeof copy[handle] === 'number') {
        copy[handle] = this.outward(copy[handle]);
      }
    }
    return { ...message, body: copy };
  }

  /** Request arguments' handle fields, translated back to adapter numbers. */
  private mapArgs(
    message: DapMessage,
    args: Record<string, unknown>,
    handles: readonly string[],
  ): DapMessage {
    const copy = { ...args };
    for (const handle of handles) {
      if (typeof copy[handle] === 'number') {
        copy[handle] = this.inward(copy[handle]);
      }
    }
    return { ...message, arguments: copy };
  }
}
