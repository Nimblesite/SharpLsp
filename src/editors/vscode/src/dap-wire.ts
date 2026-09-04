// The netcoredbg child process and the DAP framing carried on its stdio.
//
// Split out of `dap-router.ts`: the router decides WHAT to say, this owns the
// process that carries it. Everything touching `cp.ChildProcess` or the
// `Content-Length` framing lives here — spawning netcoredbg
// ([DEBUG-ADAPTER-NETCOREDBG], B59: no `cwd` and no `env` override is imposed),
// respawning it for the restart and terminal-launch emulations
// ([DEBUG-ADAPTER-GAPS]), writing frames to its stdin, parsing frames off its
// stdout, and noticing — exactly once — that it is gone.
//
// Deliberately free of `vscode` imports: nothing here needs the workbench.
import * as cp from 'node:child_process';
import { isRecord, type DapMessage } from './dap-emulate';
import { signalChild } from './child-signal';
import { error, info } from './log';
import { getErrorMessage } from './utils';

/** DAP frames are `Content-Length: N\r\n\r\n<json>`; this is the separator. */
const HEADER_END = '\r\n\r\n';

/** The header that carries the payload length. */
const CONTENT_LENGTH = 'Content-Length: ';

/** Read the body length out of one DAP header block, if well-formed. */
function parseContentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    if (!line.startsWith(CONTENT_LENGTH)) continue;
    const value = Number.parseInt(line.slice(CONTENT_LENGTH.length), 10);
    return Number.isNaN(value) ? undefined : value;
  }
  return undefined;
}

/** What the wire needs from its owning router. */
export interface WireHost {
  /** Route one complete frame the child produced towards VS Code. */
  onFrame(message: DapMessage): void;
  /**
   * The child is gone, or its wire is corrupt beyond repair.
   *
   * `why` is undefined for a clean protocol shutdown — the child already sent
   * `terminated` — which needs no ceremony.
   */
  onGone(why: string | undefined): void;
  /** True once the child itself sent the DAP `terminated` event. */
  announcedTerminated(): boolean;
  /** True once the death has been settled; nothing more may be parsed. */
  isClosed(): boolean;
  /** True once the session is being torn down; nothing may be written. */
  isDisposed(): boolean;
}

/** Owns the netcoredbg child process and the DAP frames on its stdio. */
export class AdapterWire {
  private child: cp.ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  /**
   * The child a respawn is deliberately killing.
   *
   * Its death is ORDERED, not observed. Reporting it through `onGone`
   * latches the router closed, and `consume` then drops every frame the
   * REPLACEMENT child sends — so `restart` produced a live netcoredbg nobody
   * could hear, plus a spurious `terminated` telling VS Code the session was
   * already over.
   */
  private replaced: cp.ChildProcessWithoutNullStreams | undefined;

  /**
   * Frames written while a respawn is in flight.
   *
   * The replacement child does not exist yet and the outgoing one is dying, so
   * these have nowhere to go for up to a second. Holding them is what keeps a
   * `disconnect` sent mid-respawn from vanishing and leaving VS Code with a
   * session it can never close.
   */
  private queued: DapMessage[] = [];

  constructor(
    private readonly adapterPath: string,
    private readonly spawnArgs: readonly string[],
    private readonly spawnOptions: cp.SpawnOptionsWithoutStdio,
    private readonly host: WireHost,
  ) {
    this.child = this.spawn([]);
  }

  /** Serialise one message to the child using DAP's framing. */
  public write(message: DapMessage): void {
    if (this.host.isDisposed()) return;
    if (this.replaced !== undefined) {
      // Mid-respawn: the outgoing child's stdin is already unwritable and the
      // replacement has not been spawned. Hold the frame rather than drop it.
      this.queued.push(message);
      return;
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) return;
    const body = JSON.stringify(message);
    const frame = `${CONTENT_LENGTH}${String(Buffer.byteLength(body))}${HEADER_END}${body}`;
    // `write` can also throw SYNCHRONOUSLY once the stream has been destroyed.
    // Both failure modes mean the same thing and end the session once.
    try {
      this.child.stdin.write(frame);
    } catch (cause) {
      this.host.onGone(`stdin closed: ${getErrorMessage(cause)}`);
    }
  }

  /** Swap the child process for a respawn, clearing stale transport state. */
  public respawn(attachArgs: readonly string[], onReady?: () => void): void {
    this.buffer = Buffer.alloc(0);
    const old = this.child;
    // Marked BEFORE the signal, or the exit races the flag: the death below is
    // ordered by us, so it must not be reported as the session dying.
    this.replaced = old;
    old.stdout.removeAllListeners('data');
    // Both signals go through `signalChild`: an adapter that never started has
    // no pid, and the escalation below would otherwise SIGKILL the extension
    // host's own process group — a signal nothing in it can catch or survive.
    signalChild(old);
    // A paused debuggee can make netcoredbg linger on SIGTERM; the restart
    // gesture must not wait for it. Escalate to SIGKILL after a grace second.
    const escalate = setTimeout(() => {
      signalChild(old, 'SIGKILL');
    }, 1_000);
    old.once('exit', () => {
      clearTimeout(escalate);
      this.child = this.spawn(attachArgs);
      this.replaced = undefined;
      // `onReady` replays the handshake, so it must reach the replacement
      // BEFORE the client frames that were waiting on it.
      onReady?.();
      this.flushQueued();
    });
  }

  /** Send everything held during the respawn, in the order it was written. */
  private flushQueued(): void {
    const held = this.queued;
    this.queued = [];
    for (const message of held) {
      this.write(message);
    }
  }

  /**
   * Detach from the child and stop it.
   *
   * `signalChild`, not `child.kill()`: a child whose spawn failed has no pid,
   * and Node turns that into `kill(0, ...)` — a SIGTERM to the extension
   * host's own process group. See child-signal.ts.
   */
  public dispose(): void {
    this.child.stdout.removeAllListeners('data');
    this.child.stderr.removeAllListeners('data');
    if (!this.host.isClosed()) signalChild(this.child);
  }

  /** Spawn netcoredbg and wire its output into the frame parser. */
  private spawn(attachArgs: readonly string[]): cp.ChildProcessWithoutNullStreams {
    info(`DapRouter starting netcoredbg: ${this.adapterPath}`);
    const child = cp.spawn(this.adapterPath, [...this.spawnArgs, ...attachArgs], this.spawnOptions);
    child.stdout.on('data', (chunk: Buffer) => {
      this.consume(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error(`netcoredbg: ${chunk.toString('utf8').trimEnd()}`);
    });
    this.watchDeath(child);
    return child;
  }

  /** Every way the child can die settles through the one idempotent path. */
  private watchDeath(child: cp.ChildProcessWithoutNullStreams): void {
    // A write can fail long AFTER the `writable` guard in `write()` passes:
    // netcoredbg can die between that check and the syscall, and Node reports
    // the broken pipe asynchronously on the stream. With no listener here an
    // `EPIPE` is an UNCAUGHT exception in the extension host — which is how a
    // dead adapter took the whole host down mid-session instead of ending one
    // debug session. A broken pipe IS the child being gone, so it settles
    // through the same idempotent path as `exit` and `error`.
    child.stdin.on('error', (cause: Error) => {
      if (this.replaced === child) return;
      this.host.onGone(`stdin closed: ${getErrorMessage(cause)}`);
    });
    child.on('exit', (code, signal) => {
      info(`netcoredbg exited with code ${String(code)}`);
      if (this.replaced === child) return;
      // A clean protocol shutdown (the child already sent `terminated`) needs
      // no ceremony; anything else ends the session honestly.
      this.host.onGone(
        this.host.announcedTerminated()
          ? undefined
          : `exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
      );
    });
    child.on('error', (cause: Error) => {
      if (this.replaced === child) return;
      this.host.onGone(`failed to start: ${cause.message}`);
    });
  }

  /** Accumulate child output and dispatch every complete frame it contains. */
  private consume(chunk: Buffer): void {
    if (this.host.isClosed()) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.takeFrame();
      if (frame === undefined) return;
      this.host.onFrame(frame);
    }
  }

  /**
   * Split one complete frame off the front of the buffer, if there is one.
   *
   * A corrupt or malformed frame closes the router from inside this method, so
   * the closed check lives here rather than in the caller's drain loop: the
   * next turn of that loop stops instead of routing frames off a dead wire.
   */
  private takeFrame(): DapMessage | undefined {
    if (this.host.isClosed()) return undefined;
    const end = this.buffer.indexOf(HEADER_END);
    if (end < 0) return undefined;
    const length = parseContentLength(this.buffer.subarray(0, end).toString('utf8'));
    if (length === undefined) {
      // A header without a parseable Content-Length is a corrupt wire: the
      // buffer can never drain past it, so every later frame would be lost.
      this.host.onGone('sent a corrupt DAP header');
      return undefined;
    }
    const start = end + HEADER_END.length;
    if (this.buffer.length < start + length) return undefined;
    const text = this.buffer.subarray(start, start + length).toString('utf8');
    this.buffer = this.buffer.subarray(start + length);
    return this.parseFrame(text);
  }

  /** Parse one frame body, ending the session if it is not JSON. */
  private parseFrame(text: string): DapMessage | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      // Contained here, not thrown into the extension host: a frame that is
      // not JSON ends the session deterministically instead.
      this.host.onGone(`sent a malformed DAP frame: ${getErrorMessage(cause)}`);
      return undefined;
    }
    return isRecord(parsed) ? parsed : undefined;
  }
}
