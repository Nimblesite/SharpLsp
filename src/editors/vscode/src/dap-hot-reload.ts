// Roslyn delta generation and runtime application for one DAP session.
// Implements [DEBUG-FEATURES-HOT-RELOAD]: saves become Roslyn Edit-and-Continue
// deltas in the C# sidecar, netcoredbg's `applyDeltas` request hands them to
// the LIVE debuggee, and a two-phase commit keeps the sidecar's baseline and
// the running process in lockstep — the sidecar commits only after the runtime
// confirmed every delta, and discards whenever it did not.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DapMessage } from './dap-emulate';
import { error, traceInfo } from './log';
import * as state from './state';
import { getErrorMessage } from './utils';

interface HotReloadHost {
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
  /** Per-type debugger metadata caches go stale once new IL is committed. */
  invalidateMetadataCaches?(): void;
}

interface HotReloadDelta {
  readonly metadataDelta: string;
  readonly ilDelta: string;
  readonly pdbDelta: string;
}

interface HotReloadResponse {
  readonly status: string;
  readonly sessionId: string;
  readonly assemblyName: string;
  readonly updates: readonly HotReloadDelta[];
  readonly diagnostics: readonly string[];
}

/** One saved document in the batch a debounce window collected. */
interface SavedDocument {
  readonly filePath: string;
  readonly newText: string;
}

/** The delta files one `applyDeltas` request hands to netcoredbg. */
interface DeltaFiles extends Record<string, string> {
  readonly metadataDeltaFile: string;
  readonly ilDeltaFile: string;
  readonly pdbDeltaFile: string;
  readonly lineUpdatesFile: string;
}

/** Tracks whether any delta REACHED netcoredbg, deciding discard vs latch. */
interface ApplyProgress {
  issued: boolean;
}

/** How long consecutive saves coalesce before one update is sent. */
const SAVE_DEBOUNCE_MS = 75;

/** How long a transparent pause may take to report its stop. */
const PAUSE_STOP_TIMEOUT_MS = 3_000;

/** Owns the save-to-Roslyn-to-runtime pipeline for one debug session. */
export class DapHotReload implements vscode.Disposable {
  private enabled = false;
  private projectPath: string | undefined;
  private starting: Promise<void> | undefined;
  private session: HotReloadResponse | undefined;
  private readonly pendingSaves = new Map<string, string>();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private updateQueue: Promise<void> = Promise.resolve();
  private readonly shownWarnings = new Set<string>();
  private disposed = false;
  /** Latched once the runtime and the sidecar may disagree; only restart heals. */
  private broken = false;
  private deltaDirectory: string | undefined;
  private updateSequence = 0;
  private pauseWaiter: ((threadId: number | undefined) => void) | undefined;
  private readonly saves: vscode.Disposable;

  constructor(private readonly host: HotReloadHost) {
    this.saves = vscode.workspace.onDidSaveTextDocument((document) => {
      this.onSaved(document);
    });
  }

  /** Collect one saved document; the debounce window batches Save All. */
  private onSaved(document: vscode.TextDocument): void {
    if (this.disposed || this.broken || !this.owns(document)) return;
    this.pendingSaves.set(document.uri.fsPath, document.getText());
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.flushSaves();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Send everything the window collected as ONE cross-file candidate. */
  private flushSaves(): void {
    const documents = [...this.pendingSaves].map(([filePath, newText]) => ({ filePath, newText }));
    this.pendingSaves.clear();
    if (documents.length === 0) return;
    this.updateQueue = this.updateQueue
      .then(async () => {
        await this.update(documents);
      })
      .catch((cause: unknown) => {
        this.warn(`Hot reload failed: ${getErrorMessage(cause)}. Restart the debug session.`);
      });
  }

  /** Enable runtime metadata updates before netcoredbg launches the process. */
  public prepareLaunch(args: Record<string, unknown> | undefined): void {
    this.enabled = args?.hotReload === true;
    if (!this.enabled || args === undefined) return;
    const env = isRecord(args.env) ? args.env : {};
    args.env = { ...env, DOTNET_MODIFIABLE_ASSEMBLIES: 'debug' };
    this.projectPath = findOwningProject(args);
    this.deltaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-hot-reload-'));
  }

  /** Gate a real stop on the baseline; consume a stop this class induced. */
  public onStopped(message: DapMessage, ready: () => void): void {
    if (!this.enabled) {
      ready();
      return;
    }
    const body = isRecord(message.body) ? message.body : {};
    if (this.settleSyntheticPause(body)) return;
    this.starting ??= this.startFromStop(Number(body.threadId ?? 0));
    void this.starting.then(ready, (cause: unknown) => {
      this.warn(`Hot reload failed: ${getErrorMessage(cause)}. Restart the debug session.`);
      ready();
    });
  }

  /** True when the stop was the transparent pause; it never reaches VS Code. */
  private settleSyntheticPause(body: Record<string, unknown>): boolean {
    if (this.pauseWaiter === undefined || body.reason !== 'pause') return false;
    const waiter = this.pauseWaiter;
    this.pauseWaiter = undefined;
    waiter(Number(body.threadId ?? 0));
    return true;
  }

  public dispose(): void {
    this.disposed = true;
    this.saves.dispose();
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer);
    const directory = this.deltaDirectory;
    this.deltaDirectory = undefined;
    // The delta directory outlives any in-flight update, then goes.
    void this.updateQueue
      .catch(() => undefined)
      .finally(() => {
        removeDirectory(directory);
      });
    this.endSession();
  }

  /** Release the sidecar's Roslyn baseline; safe to call at most once. */
  private endSession(): void {
    const lsp = state.client.value;
    if (lsp === undefined || this.session === undefined) return;
    const sessionId = this.session.sessionId;
    this.session = undefined;
    void lsp.sendRequest('sharplsp/hotReload', { action: 'end', sessionId });
  }

  /** Baseline start from a real stop: the frame is already paused. */
  private async startFromStop(threadId: number): Promise<void> {
    const capabilities = await this.capabilitiesAt(threadId);
    await this.startSession(capabilities);
  }

  /**
   * Baseline start with NO stop in sight — the canonical run-edit-save loop.
   * The runtime capability probe needs a paused frame, so the debuggee is
   * paused transparently for milliseconds and resumed before the (slow)
   * workspace load begins.
   */
  private async startWhileRunning(): Promise<void> {
    const capabilities = await this.capabilitiesWithPause();
    if (this.disposed) return;
    await this.startSession(capabilities);
  }

  private async capabilitiesWithPause(): Promise<string[]> {
    const threadId = await this.firstThreadId();
    const stoppedAt = await this.pauseTransparently(threadId);
    if (stoppedAt === undefined) return await this.capabilitiesAt(threadId);
    try {
      return await this.capabilitiesAt(stoppedAt);
    } finally {
      await this.host.request('continue', { threadId: stoppedAt });
    }
  }

  /** Pause and wait for the induced stop; undefined when no stop was induced. */
  private async pauseTransparently(threadId: number): Promise<number | undefined> {
    const synthetic = new Promise<number | undefined>((resolve) => {
      this.pauseWaiter = resolve;
      setTimeout(() => {
        if (this.pauseWaiter === resolve) {
          this.pauseWaiter = undefined;
          resolve(undefined);
        }
      }, PAUSE_STOP_TIMEOUT_MS);
    });
    const paused = await this.host.request('pause', { threadId });
    if (paused.success !== true) {
      this.pauseWaiter = undefined;
      return undefined;
    }
    return await synthetic;
  }

  private async firstThreadId(): Promise<number> {
    const response = await this.host.request('threads', {});
    const body = isRecord(response.body) ? response.body : {};
    const threads = Array.isArray(body.threads) ? body.threads : [];
    const first: unknown = threads.at(0);
    if (response.success !== true || !isRecord(first) || typeof first.id !== 'number') {
      throw new Error('netcoredbg reported no debuggee threads');
    }
    return first.id;
  }

  private async capabilitiesAt(threadId: number): Promise<string[]> {
    return await this.runtimeCapabilities(await this.topFrameId(threadId));
  }

  private async startSession(capabilities: string[]): Promise<void> {
    if (this.projectPath === undefined)
      throw new Error('the launched C# project could not be found');
    const session = await this.request({
      action: 'start',
      projectPath: this.projectPath,
      capabilities,
    });
    if (session.status !== 'started') {
      throw new Error(`the sidecar returned '${session.status}' while starting`);
    }
    this.session = session;
    // The debug session can end while the baseline is still loading; the
    // sidecar must not keep a dead session's workspace alive.
    if (this.disposed) {
      this.endSession();
      return;
    }
    traceInfo(`[hot-reload] baseline ready for ${this.projectPath}`);
  }

  private async update(documents: SavedDocument[]): Promise<void> {
    if (this.cannotUpdate()) return;
    this.starting ??= this.startWhileRunning();
    await this.starting;
    if (this.cannotUpdate()) return;
    const response = await this.request({
      action: 'update',
      sessionId: this.sessionId(),
      documents,
    });
    await this.deliver(response);
  }

  private cannotUpdate(): boolean {
    return this.disposed || this.broken;
  }

  private sessionId(): string {
    if (this.session === undefined) throw new Error('the hot reload session did not start');
    return this.session.sessionId;
  }

  private async request(params: Record<string, unknown>): Promise<HotReloadResponse> {
    const lsp = state.client.value;
    if (lsp === undefined) throw new Error('the SharpLsp language client is unavailable');
    return await lsp.sendRequest<HotReloadResponse>('sharplsp/hotReload', params);
  }

  /** Act on one sidecar verdict: apply-and-commit, refuse, or wait. */
  private async deliver(response: HotReloadResponse): Promise<void> {
    const count = String(response.updates.length);
    traceInfo(`[hot-reload] ${response.status}: ${count} update(s)`);
    if (response.status === 'notCompilable') {
      // The editor's live diagnostics already name every error; the edit
      // simply waits for a compilable save.
      traceInfo(`[hot-reload] waiting: ${response.diagnostics.join('; ')}`);
      return;
    }
    if (response.status === 'restartRequired') {
      const reason = response.diagnostics.join('; ') || 'the edit is not supported by the runtime';
      this.warn(`Hot reload requires restart: ${reason}`);
      return;
    }
    if (response.status !== 'applied') {
      throw new Error(`the sidecar returned '${response.status}'`);
    }
    if (response.updates.length > 0) await this.applyAll(response);
  }

  /**
   * Hand every delta to netcoredbg, then resolve the sidecar's pending emit:
   * commit on success; discard on failure. A failure after any delta REACHED
   * the runtime latches the session broken — runtime and sidecar state can no
   * longer be reconciled without a restart.
   */
  private async applyAll(response: HotReloadResponse): Promise<void> {
    const progress: ApplyProgress = { issued: false };
    try {
      for (const update of response.updates) {
        await this.applyDelta(response.assemblyName, update, progress);
      }
    } catch (cause: unknown) {
      await this.abandon(progress.issued, cause);
      return;
    }
    await this.confirm();
  }

  /** The runtime holds every delta: the sidecar's baseline may advance. */
  private async confirm(): Promise<void> {
    try {
      await this.request({ action: 'commit', sessionId: this.sessionId() });
    } catch (cause: unknown) {
      this.breakSession(
        `the sidecar could not record a committed update: ${getErrorMessage(cause)}`,
      );
      return;
    }
    traceInfo('[hot-reload] committed');
    this.host.invalidateMetadataCaches?.();
  }

  /** The runtime did not confirm; roll the sidecar back, latch if partial. */
  private async abandon(issued: boolean, cause: unknown): Promise<void> {
    try {
      await this.request({ action: 'discard', sessionId: this.sessionId() });
    } catch (discardFailure: unknown) {
      error(`[hot-reload] discard failed: ${getErrorMessage(discardFailure)}`);
    }
    if (issued) {
      this.breakSession(getErrorMessage(cause));
      return;
    }
    this.warn(`Hot reload skipped this save: ${getErrorMessage(cause)}. Save again to retry.`);
  }

  private breakSession(reason: string): void {
    this.broken = true;
    error(`[hot-reload] session latched broken: ${reason}`);
    this.show(
      `Hot reload can no longer update this process: ${reason}. Restart the debug session.`,
    );
  }

  private owns(document: vscode.TextDocument): boolean {
    if (!this.enabled || document.languageId !== 'csharp' || this.projectPath === undefined) {
      return false;
    }
    const relative = path.relative(path.dirname(this.projectPath), document.uri.fsPath);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  private async topFrameId(threadId: number): Promise<number> {
    const response = await this.host.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
    const body = isRecord(response.body) ? response.body : {};
    const stackFrames = body.stackFrames;
    const first: unknown = Array.isArray(stackFrames) ? stackFrames.at(0) : undefined;
    if (response.success !== true || !isRecord(first) || typeof first.id !== 'number') {
      throw new Error(
        typeof response.message === 'string'
          ? response.message
          : 'netcoredbg returned no paused frame',
      );
    }
    return first.id;
  }

  private async runtimeCapabilities(frameId: number): Promise<string[]> {
    const response = await this.host.request('evaluate', {
      expression: 'System.Reflection.Metadata.MetadataUpdater.GetCapabilities()',
      frameId,
      context: 'repl',
    });
    const body = isRecord(response.body) ? response.body : {};
    if (response.success !== true || typeof body.result !== 'string') return ['Baseline'];
    return body.result
      .replace(/^"|"$/g, '')
      .split(/\s+/u)
      .filter((item) => item.length > 0);
  }

  private async applyDelta(
    assemblyName: string,
    update: HotReloadDelta,
    progress: ApplyProgress,
  ): Promise<void> {
    const directory = this.deltaDirectory;
    if (directory === undefined || this.disposed) {
      throw new Error('the debug session ended before the update was applied');
    }
    const prefix = path.join(directory, String(++this.updateSequence));
    const files = await writeDeltaFiles(prefix, update);
    try {
      if (this.sessionEnded()) {
        throw new Error('the debug session ended before the update was applied');
      }
      progress.issued = true;
      await this.requestApplyDeltas(assemblyName, files);
    } finally {
      await removeFiles(files);
    }
  }

  private sessionEnded(): boolean {
    return this.disposed;
  }

  /** Hand one set of delta files to netcoredbg's `applyDeltas` request. */
  private async requestApplyDeltas(assemblyName: string, files: DeltaFiles): Promise<void> {
    const response = await this.host.request('applyDeltas', {
      dllFileName: assemblyName.endsWith('.dll') ? assemblyName : `${assemblyName}.dll`,
      ...files,
    });
    if (response.success !== true) {
      throw new Error(
        typeof response.message === 'string'
          ? response.message
          : 'netcoredbg rejected the Edit-and-Continue deltas',
      );
    }
  }

  /** Log ALWAYS; toast each distinct message once, never after dispose. */
  private warn(message: string): void {
    error(`[hot-reload] ${message}`);
    this.show(message);
  }

  private show(message: string): void {
    if (this.disposed || this.shownWarnings.has(message)) return;
    this.shownWarnings.add(message);
    void vscode.window.showWarningMessage(message);
  }
}

/** Write one update's deltas where netcoredbg can read them. */
async function writeDeltaFiles(prefix: string, update: HotReloadDelta): Promise<DeltaFiles> {
  const files: DeltaFiles = {
    metadataDeltaFile: `${prefix}.metadata`,
    ilDeltaFile: `${prefix}.il`,
    pdbDeltaFile: `${prefix}.pdb`,
    lineUpdatesFile: `${prefix}.lines`,
  };
  await Promise.all([
    fs.promises.writeFile(files.metadataDeltaFile, Buffer.from(update.metadataDelta, 'base64')),
    fs.promises.writeFile(files.ilDeltaFile, Buffer.from(update.ilDelta, 'base64')),
    fs.promises.writeFile(files.pdbDeltaFile, Buffer.from(update.pdbDelta, 'base64')),
    // Four zero bytes: a line-updates table with zero sources, netcoredbg's
    // "no lines moved" shape.
    fs.promises.writeFile(files.lineUpdatesFile, Buffer.alloc(4)),
  ]);
  return files;
}

async function removeFiles(files: DeltaFiles): Promise<void> {
  await Promise.all(
    Object.values(files).map(async (file) => {
      await removeDeltaFile(file);
    }),
  );
}

/**
 * Delete one delta file, tolerating the Windows file-lock race.
 *
 * netcoredbg reads the PDB through a handle that can outlive the
 * `applyDeltas` response, so an immediate unlink fails with EBUSY/EPERM. A
 * locked delta file is inert — each update writes a fresh unique prefix and
 * the whole temp directory is removed on dispose — so the cleanup retries
 * briefly and then gives up silently instead of failing the apply. The
 * previous behaviour let this race escape `applyDelta`, which made `applyAll`
 * treat an already-applied update as a failure and latch the session broken.
 */
async function removeDeltaFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.promises.rm(file, { force: true });
      return;
    } catch (cause) {
      if (!isFileLockError(cause)) {
        // Genuinely unexpected: surface it rather than hiding a disk error.
        throw cause;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50 * (attempt + 1));
      });
    }
  }
  // Still locked after the retries; leave it for dispose-time directory removal.
  traceInfo(`[hot-reload] delta file still locked, deferred cleanup: ${file}`);
}

function isFileLockError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  const code = cause.code;
  return code === 'EBUSY' || code === 'EPERM';
}

function removeDirectory(directory: string | undefined): void {
  if (directory === undefined) return;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (cause: unknown) {
    error(`[hot-reload] could not remove ${directory}: ${getErrorMessage(cause)}`);
  }
}

function findOwningProject(args: Record<string, unknown>): string | undefined {
  const starts = [
    args.cwd,
    typeof args.program === 'string' ? path.dirname(args.program) : undefined,
  ];
  for (const start of starts) {
    if (typeof start !== 'string') continue;
    let current = path.resolve(start);
    for (;;) {
      const projects = projectsAt(current);
      const project = projects.length === 1 ? projects.at(0) : undefined;
      if (project !== undefined) return path.join(current, project);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return undefined;
}

function projectsAt(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.csproj'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
