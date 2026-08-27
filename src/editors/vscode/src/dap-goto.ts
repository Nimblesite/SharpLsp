// Run-to-cursor emulation for the DAP proxy.
//
// Implements [DEBUG-FEATURES-STEPPING] row "Run to cursor (temporary
// breakpoint) | goto | P2": netcoredbg answers `gotoTargets`/`goto` with
// E_NOTIMPL ([DEBUG-ADAPTER-GAPS]), so the router synthesizes targets and
// serves the gesture with a temporary adapter-side breakpoint that is merged
// into the source's current set, then removed the moment it hits — leaving the
// Breakpoints view untouched, exactly as the gesture promises.
import { isRecord, recordList, type DapMessage } from './dap-emulate';

/** What the emulator needs from its owning router. */
export interface GotoHost {
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  /** Emit one message towards VS Code. */
  fire(message: Record<string, unknown> & { seq?: unknown }): void;
  /** Respond to a client request on the router's behalf. */
  respondTo(message: DapMessage, success: boolean, body: unknown): void;
  /** The seq of a recorded client message, for response correlation. */
  seqOf(message: DapMessage): number;
}

/** Serves `gotoTargets`/`goto` without netcoredbg's help. */
export class GotoEmulator {
  /** Synthetic targets: id -> location. */
  private readonly targets = new Map<number, { readonly path: string; readonly line: number }>();
  private nextId = 0;
  /** The live temporary breakpoint, if any. */
  private temp?: { path: string; line: number; id?: number } | undefined;

  constructor(
    private readonly host: GotoHost,
    private readonly breakpointArgsFor: (path: string) => Record<string, unknown>,
  ) {}

  /** Answer `gotoTargets` synthetically; netcoredbg has none. */
  public onGotoTargets(message: DapMessage): void {
    const args = isRecord(message.arguments) ? message.arguments : {};
    const path = sourcePathOf(args);
    const line = Number(args.line ?? 0);
    if (path === undefined || line <= 0) {
      this.host.respondTo(message, false, { targets: [] });
      return;
    }
    const id = ++this.nextId;
    this.targets.set(id, { path, line });
    const label = path.split('/').pop() ?? path;
    this.host.respondTo(message, true, {
      targets: [{ id, label: `${label}:${String(line)}`, line, column: 1 }],
    });
  }

  /** Run to a synthetic target: temporary breakpoint, continue, clean up. */
  public onGoto(message: DapMessage): void {
    const args = isRecord(message.arguments) ? message.arguments : {};
    const targetId = Number(args.targetId ?? 0);
    const threadId = Number(args.threadId ?? 0);
    const target = this.targets.get(targetId);
    this.host.respondTo(message, target !== undefined, {});
    if (target === undefined) return;
    const current = this.breakpointArgsFor(target.path);
    const merged = [...recordList(current.breakpoints), { line: target.line }];
    this.temp = { path: target.path, line: target.line };
    void this.host
      .request('setBreakpoints', {
        ...current,
        lines: merged.map((entry) => Number(entry.line ?? 0)),
        breakpoints: merged,
      })
      .then(async (response) => {
        const body = isRecord(response.body) ? response.body : {};
        const id = Number(recordList(body.breakpoints).at(-1)?.id ?? 0);
        if (this.temp !== undefined && id > 0) this.temp.id = id;
        await this.host.request('continue', { threadId });
      })
      .catch(() => {
        // The temporary breakpoint never armed; the run continues regardless.
      });
  }

  /** Remove the temporary breakpoint once it is the reason for a stop. */
  public absorbHit(hits: readonly number[]): void {
    const temp = this.temp;
    if (temp?.id === undefined || !hits.includes(temp.id)) return;
    this.temp = undefined;
    void this.host.request('setBreakpoints', this.breakpointArgsFor(temp.path));
  }

  /** The id-less equivalent: the stop landed exactly on the temporary line. */
  public absorbHitAt(path: string | undefined, line: number): void {
    const temp = this.temp;
    if (temp === undefined || temp.path !== path || temp.line !== line) return;
    this.temp = undefined;
    void this.host.request('setBreakpoints', this.breakpointArgsFor(temp.path));
  }

  /** True while a temporary breakpoint is armed. */
  public hasTemp(): boolean {
    return this.temp !== undefined;
  }
}

/** The `source.path` of an arguments record, if it carries one. */
function sourcePathOf(args: Record<string, unknown>): string | undefined {
  const source = args.source;
  if (!isRecord(source) || typeof source.path !== 'string') return undefined;
  return source.path;
}
