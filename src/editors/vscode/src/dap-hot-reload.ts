// Roslyn delta generation and runtime application for one DAP session.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DapMessage } from './dap-emulate';
import * as state from './state';
import { getErrorMessage } from './utils';

interface HotReloadHost {
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
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

/** Owns the save-to-Roslyn-to-runtime pipeline for one debug session. */
export class DapHotReload implements vscode.Disposable {
  private enabled = false;
  private projectPath: string | undefined;
  private starting: Promise<void> | undefined;
  private session: HotReloadResponse | undefined;
  private frameId: number | undefined;
  private readonly saves: vscode.Disposable;

  constructor(private readonly host: HotReloadHost) {
    this.saves = vscode.workspace.onDidSaveTextDocument((document) => {
      if (!this.owns(document)) return;
      void this.update(document).catch((cause: unknown) => {
        void vscode.window.showWarningMessage(
          `Hot reload failed: ${getErrorMessage(cause)}. Restart the debug session.`,
        );
      });
    });
  }

  /** Enable runtime metadata updates before netcoredbg launches the process. */
  public prepareLaunch(args: Record<string, unknown> | undefined): void {
    this.enabled = args?.hotReload === true;
    if (!this.enabled || args === undefined) return;
    const env = isRecord(args.env) ? args.env : {};
    args.env = { ...env, DOTNET_MODIFIABLE_ASSEMBLIES: 'debug' };
    this.projectPath = findOwningProject(args);
  }

  /** Start Roslyn's baseline against the first real paused frame. */
  public onStopped(threadId: number): void {
    if (!this.enabled) return;
    this.starting ??= this.start(threadId);
  }

  public dispose(): void {
    this.saves.dispose();
    const lsp = state.client.value;
    if (lsp !== undefined && this.session !== undefined) {
      void lsp.sendRequest('sharplsp/hotReload', {
        action: 'end',
        sessionId: this.session.sessionId,
      });
    }
  }

  private async start(threadId: number): Promise<void> {
    const lsp = state.client.value;
    if (lsp === undefined) throw new Error('the SharpLsp language client is unavailable');
    if (this.projectPath === undefined)
      throw new Error('the launched C# project could not be found');
    this.frameId = await this.topFrameId(threadId);
    const capabilities = await this.runtimeCapabilities(this.frameId);
    this.session = await lsp.sendRequest<HotReloadResponse>('sharplsp/hotReload', {
      action: 'start',
      projectPath: this.projectPath,
      capabilities,
    });
  }

  private async update(document: vscode.TextDocument): Promise<void> {
    await this.starting;
    const lsp = state.client.value;
    if (lsp === undefined || this.session === undefined || this.frameId === undefined) {
      throw new Error('the hot reload session did not start');
    }
    const response = await lsp.sendRequest<HotReloadResponse>('sharplsp/hotReload', {
      action: 'update',
      sessionId: this.session.sessionId,
      filePath: document.uri.fsPath,
      newText: document.getText(),
    });
    if (response.status === 'restartRequired') {
      const reason = response.diagnostics.join('; ') || 'the edit is not supported by the runtime';
      void vscode.window.showWarningMessage(`Hot reload requires restart: ${reason}`);
      return;
    }
    if (response.status !== 'applied') {
      throw new Error(`the sidecar returned '${response.status}'`);
    }
    for (const update of response.updates) {
      await this.applyDelta(response.assemblyName, update, this.frameId);
    }
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
    frameId: number,
  ): Promise<void> {
    const expression =
      `System.Reflection.Metadata.MetadataUpdater.ApplyUpdate(` +
      `System.Reflection.Assembly.Load(${JSON.stringify(assemblyName)}),` +
      `System.Convert.FromBase64String(${JSON.stringify(update.metadataDelta)}),` +
      `System.Convert.FromBase64String(${JSON.stringify(update.ilDelta)}),` +
      `System.Convert.FromBase64String(${JSON.stringify(update.pdbDelta)}))`;
    const response = await this.host.request('evaluate', { expression, frameId, context: 'repl' });
    if (response.success !== true) {
      throw new Error(
        typeof response.message === 'string'
          ? response.message
          : 'netcoredbg rejected MetadataUpdater.ApplyUpdate',
      );
    }
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
