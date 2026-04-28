import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import * as log from './log.js';
import { getErrorMessage } from './utils.js';
import {
  CMD_PROFILER_LIST_PROCESSES,
  CMD_PROFILER_START_TRACE,
  CMD_PROFILER_STOP_TRACE,
  CMD_PROFILER_START_COUNTERS,
  CMD_PROFILER_STOP_COUNTERS,
  CMD_PROFILER_COLLECT_DUMP,
  CMD_PROFILER_ANALYZE_HEAP,
  CMD_PROFILER_REFRESH,
  CMD_PROFILER_DIFF_SNAPSHOTS,
  CMD_PROFILER_DETECT_LEAKS,
  CMD_PROFILER_SHOW_OBJECT_GRAPH,
  CMD_PROFILER_INSPECT_OBJECT,
  CMD_PROFILER_OPEN_TRACE,
  CMD_PROFILER_CONVERT_TRACE,
  CMD_PROFILER_STOP_SESSION,
  CMD_PROFILER_REVEAL_OUTPUT,
  CMD_PROFILER_COPY_OUTPUT_PATH,
  CMD_PROFILER_SHOW_COUNTERS_PANEL,
  CMD_PROFILER_TRACE_PROCESS,
  CMD_PROFILER_COUNTERS_PROCESS,
  CMD_PROFILER_DUMP_PROCESS,
  CMD_PROFILER_COPY_PID,
} from './constants.js';
import { promptAndOpenGraph } from './profiler-graph.js';
import { promptAndOpenDiff, detectLeaksWorkflow } from './profiler-diff.js';

// ── LSP Types ─────────────────────────────────────────────────────

interface DotNetProcess {
  readonly pid: number;
  readonly name: string;
  readonly command_line: string;
}

interface StartTraceResult {
  readonly session_id: string;
  readonly output_path: string;
}

interface StopTraceResult {
  readonly output_path: string;
  readonly file_size_bytes: number;
  readonly duration_ms: number;
}

interface StartCountersResult {
  readonly session_id: string;
}

interface CollectDumpResult {
  readonly output_path: string;
  readonly file_size_bytes: number;
}

interface HeapTypeInfo {
  readonly type_name: string;
  readonly count: number;
  readonly total_size_bytes: number;
}

interface HeapStats {
  readonly total_objects: number;
  readonly total_size_bytes: number;
  readonly types: HeapTypeInfo[];
}

interface CounterValue {
  readonly provider: string;
  readonly name: string;
  readonly display_name: string;
  readonly value: number;
  readonly unit: string;
}

interface CounterUpdateParams {
  readonly session_id: string;
  readonly counters: CounterValue[];
}

// ── Tree View ─────────────────────────────────────────────────────

interface SessionInfo {
  readonly id: string;
  /** 'Trace' or 'Counters'. */
  readonly kind: string;
  readonly pid: number;
  /** Human-readable process name, when known. */
  readonly processName: string | undefined;
  /** Output file path (for traces; counters sessions leave this undefined). */
  readonly outputPath: string | undefined;
  /** When the session was started. */
  readonly startedAt: number;
}

interface ConvertTraceResult {
  readonly output_path: string;
  readonly file_size_bytes: number;
}

/** A node in the Profiler tree view. */
export class ProfilerTreeItem extends vscode.TreeItem {
  public readonly nodeKind: string;
  public readonly processPid: number | undefined;
  public readonly sessionId: string | undefined;
  public readonly outputPath: string | undefined;

  constructor(
    label: string,
    nodeKind: string,
    collapsible: vscode.TreeItemCollapsibleState,
    options?: {
      pid?: number;
      sessionId?: string;
      outputPath?: string;
      contextValue?: string;
    },
  ) {
    super(label, collapsible);
    this.nodeKind = nodeKind;
    this.processPid = options?.pid ?? undefined;
    this.sessionId = options?.sessionId ?? undefined;
    this.outputPath = options?.outputPath ?? undefined;
    if (options?.contextValue !== undefined) this.contextValue = options.contextValue;
  }
}

export class ProfilerTreeProvider implements vscode.TreeDataProvider<ProfilerTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ProfilerTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  private processes: DotNetProcess[] = [];
  private activeSessions: SessionInfo[] = [];
  private client: LanguageClient | undefined;

  public setClient(client: LanguageClient): void {
    this.client = client;
  }

  public async refresh(): Promise<void> {
    if (this.client === undefined) return;
    try {
      const result = await this.client.sendRequest<DotNetProcess[]>(
        'sharplsp/profiler/listProcesses',
        {},
      );
      this.processes = result;
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      log.info(`Failed to list .NET processes: ${msg}`);
      this.processes = [];
    }
    this.emitter.fire(undefined);
  }

  public addSession(
    id: string,
    kind: string,
    pid: number,
    outputPath?: string,
    processName?: string,
  ): void {
    this.activeSessions.push({
      id,
      kind,
      pid,
      processName,
      outputPath,
      startedAt: Date.now(),
    });
    this.emitter.fire(undefined);
  }

  /** Find the cached process name for a PID, if we've seen it in `refresh()`. */
  public processNameFor(pid: number): string | undefined {
    return this.processes.find((p) => p.pid === pid)?.name;
  }

  /** Lookup a session by ID (for context-menu dispatch). */
  public findSession(id: string): SessionInfo | undefined {
    return this.activeSessions.find((s) => s.id === id);
  }

  public removeSession(id: string): void {
    this.activeSessions = this.activeSessions.filter((s) => s.id !== id);
    this.emitter.fire(undefined);
  }

  public getTreeItem(element: ProfilerTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ProfilerTreeItem): ProfilerTreeItem[] {
    if (element !== undefined) return [];

    const nodes: ProfilerTreeItem[] = [];

    if (this.activeSessions.length > 0) {
      const header = new ProfilerTreeItem(
        `Active Sessions (${String(this.activeSessions.length)})`,
        'header',
        vscode.TreeItemCollapsibleState.None,
        { contextValue: 'profiler-header-sessions' },
      );
      header.iconPath = new vscode.ThemeIcon('pulse');
      nodes.push(header);

      for (const session of this.activeSessions) {
        nodes.push(buildSessionNode(session));
      }
    }

    if (this.processes.length > 0) {
      const header = new ProfilerTreeItem(
        `.NET Processes (${String(this.processes.length)})`,
        'header',
        vscode.TreeItemCollapsibleState.None,
        { contextValue: 'profiler-header-processes' },
      );
      header.iconPath = new vscode.ThemeIcon('server-process');
      nodes.push(header);

      for (const proc of this.processes) {
        nodes.push(buildProcessNode(proc));
      }
    }

    if (nodes.length === 0) {
      const empty = new ProfilerTreeItem(
        'No .NET processes found',
        'header',
        vscode.TreeItemCollapsibleState.None,
      );
      empty.description = 'Click the refresh icon to scan again';
      empty.iconPath = new vscode.ThemeIcon('info');
      nodes.push(empty);
    }

    return nodes;
  }

  /** Get active sessions matching a kind for the session picker. */
  public getActiveSessions(kind: string): SessionInfo[] {
    return this.activeSessions.filter((s) => s.kind === kind);
  }

  /** Total active session count. */
  public get sessionCount(): number {
    return this.activeSessions.length;
  }
}

/** Build a tree node for an active profiling session. */
function buildSessionNode(session: SessionInfo): ProfilerTreeItem {
  const kindLower = session.kind.toLowerCase();
  const contextValue = `profiler-session-${kindLower}`;
  const options: { sessionId: string; contextValue: string; outputPath?: string } = {
    sessionId: session.id,
    contextValue,
  };
  if (session.outputPath !== undefined) options.outputPath = session.outputPath;
  const label =
    session.processName !== undefined && session.processName.length > 0
      ? `${session.kind}: ${session.processName} (PID ${String(session.pid)})`
      : `${session.kind}: PID ${String(session.pid)}`;
  const node = new ProfilerTreeItem(
    label,
    'session',
    vscode.TreeItemCollapsibleState.None,
    options,
  );
  const elapsedSec = Math.floor((Date.now() - session.startedAt) / 1000);
  node.description = session.kind === 'Trace' ? `recording · ${String(elapsedSec)}s` : 'streaming';
  node.iconPath = new vscode.ThemeIcon(
    session.kind === 'Trace' ? 'record' : 'pulse',
    new vscode.ThemeColor('charts.red'),
  );
  node.tooltip = new vscode.MarkdownString(
    [
      `**${session.kind} session**`,
      session.processName !== undefined && session.processName.length > 0
        ? `- Process: \`${session.processName}\``
        : '',
      `- PID: \`${String(session.pid)}\``,
      `- Session ID: \`${session.id}\``,
      session.outputPath !== undefined ? `- Output: \`${session.outputPath}\`` : '',
      '',
      session.kind === 'Trace'
        ? 'Click to **stop & open** the trace. Right-click for more options.'
        : 'Click to **show the live counters panel**. Right-click to stop.',
    ]
      .filter((s) => s.length > 0)
      .join('\n'),
  );
  node.command = {
    command: CMD_PROFILER_STOP_SESSION,
    title: session.kind === 'Trace' ? 'Stop Trace' : 'Show Counters',
    arguments: [node],
  };
  return node;
}

/** Build a tree node for a discovered .NET process. */
function buildProcessNode(proc: DotNetProcess): ProfilerTreeItem {
  const node = new ProfilerTreeItem(
    `${proc.name} (PID ${String(proc.pid)})`,
    'process',
    vscode.TreeItemCollapsibleState.None,
    { pid: proc.pid, contextValue: 'profiler-process' },
  );
  node.description = proc.command_line;
  node.iconPath = new vscode.ThemeIcon('terminal');
  node.tooltip = new vscode.MarkdownString(
    [
      `**${proc.name}** · PID \`${String(proc.pid)}\``,
      '',
      `\`${proc.command_line}\``,
      '',
      'Click to choose an action. Right-click for: trace, counters, dump, copy PID.',
    ].join('\n'),
  );
  node.command = {
    command: CMD_PROFILER_TRACE_PROCESS,
    title: 'Start Trace',
    arguments: [node],
  };
  return node;
}

// ── Counter Webview ───────────────────────────────────────────────

/** Manages a webview panel that displays live counter values. */
class CounterWebviewPanel {
  private static readonly panels = new Map<string, CounterWebviewPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly counters = new Map<string, CounterValue>();
  private disposed = false;

  private constructor(
    private readonly sessionId: string,
    pid: number,
    context: vscode.ExtensionContext,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'sharplspCounters',
      `Counters: PID ${String(pid)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(
      () => {
        this.disposed = true;
        CounterWebviewPanel.panels.delete(sessionId);
      },
      undefined,
      context.subscriptions,
    );

    this.panel.webview.html = buildCounterHtml([]);
  }

  /** Open or reveal the webview for a session. */
  public static open(
    sessionId: string,
    pid: number,
    context: vscode.ExtensionContext,
  ): CounterWebviewPanel {
    const existing = CounterWebviewPanel.panels.get(sessionId);
    if (existing !== undefined) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return existing;
    }
    const pane = new CounterWebviewPanel(sessionId, pid, context);
    CounterWebviewPanel.panels.set(sessionId, pane);
    return pane;
  }

  /** Push new counter values to the webview. */
  public pushUpdate(counters: CounterValue[]): void {
    if (this.disposed) return;
    for (const c of counters) {
      const key = `${c.provider}/${c.name}`;
      this.counters.set(key, c);
    }
    this.panel.webview.html = buildCounterHtml(Array.from(this.counters.values()));
  }

  /** Close the webview. */
  public dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
    CounterWebviewPanel.panels.delete(this.sessionId);
  }

  /** Check if a webview exists for the given session. */
  public static has(sessionId: string): boolean {
    return CounterWebviewPanel.panels.has(sessionId);
  }
}

/** Build the HTML content for the counter webview. */
function buildCounterHtml(counters: CounterValue[]): string {
  const rows = counters
    .sort((a, b) => `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`))
    .map((c) => {
      const displayName = c.display_name.length > 0 ? c.display_name : c.name;
      const formattedValue = formatCounterValue(c.value, c.unit);
      return `<tr>
        <td class="provider">${escapeHtml(c.provider)}</td>
        <td class="name">${escapeHtml(displayName)}</td>
        <td class="value">${escapeHtml(formattedValue)}</td>
        <td class="unit">${escapeHtml(c.unit)}</td>
      </tr>`;
    })
    .join('\n');

  const timestamp = new Date().toLocaleTimeString();
  const placeholder =
    counters.length === 0
      ? `<tr><td colspan="4" class="empty">Waiting for counter data…</td></tr>`
      : rows;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Live Counters</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 12px; }
  h2 { font-size: 1.1em; margin: 0 0 8px 0; color: var(--vscode-titleBar-activeForeground, inherit); }
  .updated { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, #2a2a2a); font-size: 0.9em; }
  td.provider { color: var(--vscode-descriptionForeground); font-size: 0.8em; }
  td.value { font-variant-numeric: tabular-nums; font-weight: 600; }
  td.unit { color: var(--vscode-descriptionForeground); font-size: 0.8em; }
  td.empty { text-align: center; padding: 20px; color: var(--vscode-descriptionForeground); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
<h2>Live .NET Performance Counters</h2>
<p class="updated">Last updated: ${timestamp}</p>
<table>
  <thead>
    <tr><th>Provider</th><th>Counter</th><th>Value</th><th>Unit</th></tr>
  </thead>
  <tbody>
    ${placeholder}
  </tbody>
</table>
</body>
</html>`;
}

function formatCounterValue(value: number, unit: string): string {
  const u = unit.toLowerCase();
  if (u === 'bytes' || u.includes('byte')) {
    return formatBytes(value);
  }
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(2);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Status Bar ────────────────────────────────────────────────────

/** Status bar item showing active profiling sessions. */
export class ProfilerStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.tooltip = 'Active profiling sessions — click to list processes';
    this.item.command = CMD_PROFILER_LIST_PROCESSES;
    context.subscriptions.push(this.item);
    this.update(0);
  }

  /** Update the status bar to reflect the current session count. */
  public update(count: number): void {
    if (count === 0) {
      this.item.hide();
    } else {
      this.item.text = `$(pulse) ${String(count)} profiling`;
      this.item.show();
    }
  }
}

// ── Process Picker ────────────────────────────────────────────────

async function pickProcess(client: LanguageClient): Promise<DotNetProcess | undefined> {
  const processes = await client.sendRequest<DotNetProcess[]>(
    'sharplsp/profiler/listProcesses',
    {},
  );

  if (processes.length === 0) {
    void vscode.window.showInformationMessage('No .NET processes found.');
    return undefined;
  }

  const items = processes.map((p) => ({
    label: `${p.name} (PID ${String(p.pid)})`,
    description: p.command_line,
    process: p,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a .NET process',
  });

  return picked?.process;
}

// ── Command Registration ──────────────────────────────────────────

export function registerCommands(
  context: vscode.ExtensionContext,
  provider: ProfilerTreeProvider,
  statusBar: ProfilerStatusBar,
  getClient: () => LanguageClient | undefined,
): void {
  // Interactive dialogs (showQuickPick, showOpenDialog) hang forever in
  // automated test runners.  Skip dialog-gated commands in test mode.
  const isTestMode = context.extensionMode === vscode.ExtensionMode.Test;

  /** Map from session ID to its counter webview (if open). */
  const counterPanels = new Map<string, CounterWebviewPanel>();

  /** Wire up the counterUpdate notification handler once a client exists. */
  function wireCounterNotifications(client: LanguageClient): void {
    client.onNotification('sharplsp/profiler/counterUpdate', (params: CounterUpdateParams) => {
      const panel = counterPanels.get(params.session_id);
      if (panel !== undefined) {
        panel.pushUpdate(params.counters);
      }
    });
  }

  const client = getClient();
  if (client !== undefined) {
    wireCounterNotifications(client);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_REFRESH, async () => {
      await provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_LIST_PROCESSES, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;
      await provider.refresh();
    }),
  );

  /** Start a trace session on a known PID. Used by toolbar + per-process menu. */
  async function startTraceOn(pid: number, processName?: string): Promise<void> {
    const lsp = getClient();
    if (lsp === undefined) return;
    const name = processName ?? provider.processNameFor(pid);
    try {
      const result = await lsp.sendRequest<StartTraceResult>('sharplsp/profiler/startTrace', {
        pid,
      });
      provider.addSession(result.session_id, 'Trace', pid, result.output_path, name);
      statusBar.update(provider.sessionCount);
      const who = name !== undefined ? `${name} (PID ${String(pid)})` : `PID ${String(pid)}`;
      void vscode.window.showInformationMessage(
        `Trace recording on ${who} → ${result.output_path}`,
      );
    } catch (err: unknown) {
      void vscode.window.showErrorMessage(`Start trace failed: ${getErrorMessage(err)}`);
    }
  }

  /** Stop a trace session by ID. Returns the output path of the resulting file. */
  async function stopTraceById(sessionId: string): Promise<string | undefined> {
    const lsp = getClient();
    if (lsp === undefined) return undefined;
    try {
      const result = await lsp.sendRequest<StopTraceResult>('sharplsp/profiler/stopTrace', {
        session_id: sessionId,
      });
      provider.removeSession(sessionId);
      statusBar.update(provider.sessionCount);
      const size = formatBytes(result.file_size_bytes);
      const dur = formatDuration(result.duration_ms);
      void vscode.window.showInformationMessage(
        `Trace saved: ${result.output_path} (${size}, ${dur})`,
      );
      return result.output_path;
    } catch (err: unknown) {
      void vscode.window.showErrorMessage(`Stop trace failed: ${getErrorMessage(err)}`);
      return undefined;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_START_TRACE, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;
      const proc = await pickProcess(lsp);
      if (proc === undefined) return;
      await startTraceOn(proc.pid, proc.name);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_TRACE_PROCESS, async (item?: ProfilerTreeItem) => {
      const pid = item?.processPid;
      if (pid === undefined) return;
      await startTraceOn(pid);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_STOP_TRACE, async (item?: ProfilerTreeItem) => {
      let sessionId = item?.sessionId;
      sessionId ??= await pickActiveSession(provider, 'Trace');
      if (sessionId === undefined) return;
      const outputPath = await stopTraceById(sessionId);
      if (outputPath !== undefined) {
        // Default Stop action also opens the resulting trace (converted if needed).
        await openTraceFile(getClient(), outputPath);
      }
    }),
  );

  async function startCountersOn(pid: number, processName?: string): Promise<void> {
    const lsp = getClient();
    if (lsp === undefined) return;
    const name = processName ?? provider.processNameFor(pid);
    try {
      const result = await lsp.sendRequest<StartCountersResult>('sharplsp/profiler/startCounters', {
        pid,
      });
      provider.addSession(result.session_id, 'Counters', pid, undefined, name);
      statusBar.update(provider.sessionCount);
      const panel = CounterWebviewPanel.open(result.session_id, pid, context);
      counterPanels.set(result.session_id, panel);
      const currentClient = getClient();
      if (currentClient !== undefined && !CounterWebviewPanel.has('__wired__')) {
        wireCounterNotifications(currentClient);
      }
      void vscode.window.showInformationMessage(
        `Counter monitoring started for PID ${String(pid)}`,
      );
    } catch (err: unknown) {
      void vscode.window.showErrorMessage(`Start counters failed: ${getErrorMessage(err)}`);
    }
  }

  async function stopCountersById(sessionId: string): Promise<void> {
    const lsp = getClient();
    if (lsp === undefined) return;
    try {
      await lsp.sendRequest('sharplsp/profiler/stopCounters', { session_id: sessionId });
      provider.removeSession(sessionId);
      statusBar.update(provider.sessionCount);
      const panel = counterPanels.get(sessionId);
      if (panel !== undefined) {
        panel.dispose();
        counterPanels.delete(sessionId);
      }
      void vscode.window.showInformationMessage('Counter monitoring stopped.');
    } catch (err: unknown) {
      void vscode.window.showErrorMessage(`Stop counters failed: ${getErrorMessage(err)}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_START_COUNTERS, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;
      const proc = await pickProcess(lsp);
      if (proc === undefined) return;
      await startCountersOn(proc.pid, proc.name);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD_PROFILER_COUNTERS_PROCESS,
      async (item?: ProfilerTreeItem) => {
        const pid = item?.processPid;
        if (pid === undefined) return;
        await startCountersOn(pid);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_STOP_COUNTERS, async (item?: ProfilerTreeItem) => {
      let sessionId = item?.sessionId;
      sessionId ??= await pickActiveSession(provider, 'Counters');
      if (sessionId === undefined) return;
      await stopCountersById(sessionId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_SHOW_COUNTERS_PANEL, (item?: ProfilerTreeItem) => {
      const sessionId = item?.sessionId;
      if (sessionId === undefined) return;
      const session = provider.findSession(sessionId);
      if (session === undefined) return;
      const panel = CounterWebviewPanel.open(sessionId, session.pid, context);
      counterPanels.set(sessionId, panel);
    }),
  );

  // Default click on a session tree item: dispatch to the right "stop" by kind.
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_STOP_SESSION, async (item?: ProfilerTreeItem) => {
      const sessionId = item?.sessionId;
      if (sessionId === undefined) return;
      const session = provider.findSession(sessionId);
      if (session === undefined) return;
      if (session.kind === 'Trace') {
        const outputPath = await stopTraceById(sessionId);
        if (outputPath !== undefined) {
          await openTraceFile(getClient(), outputPath);
        }
      } else if (session.kind === 'Counters') {
        // Clicking a counters session reveals the live panel rather than stopping it.
        const panel = CounterWebviewPanel.open(sessionId, session.pid, context);
        counterPanels.set(sessionId, panel);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_COPY_PID, async (item?: ProfilerTreeItem) => {
      const pid = item?.processPid;
      if (pid === undefined) return;
      await vscode.env.clipboard.writeText(String(pid));
      void vscode.window.showInformationMessage(`Copied PID ${String(pid)} to clipboard`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD_PROFILER_COPY_OUTPUT_PATH,
      async (item?: ProfilerTreeItem) => {
        const path = item?.outputPath;
        if (path === undefined || path.length === 0) {
          void vscode.window.showInformationMessage('Session has no output file yet.');
          return;
        }
        await vscode.env.clipboard.writeText(path);
        void vscode.window.showInformationMessage(`Copied: ${path}`);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_REVEAL_OUTPUT, async (item?: ProfilerTreeItem) => {
      const path = item?.outputPath;
      if (path === undefined || path.length === 0) {
        void vscode.window.showInformationMessage('Session has no output file yet.');
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_OPEN_TRACE, async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Traces: ['nettrace', 'speedscope.json', 'json'] },
        title: 'Open Trace File',
      });
      const file = picked?.[0];
      if (file === undefined) return;
      await openTraceFile(getClient(), file.fsPath);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_CONVERT_TRACE, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'nettrace files': ['nettrace'] },
        title: 'Convert .nettrace File',
      });
      const file = picked?.[0];
      if (file === undefined) return;
      try {
        const result = await lsp.sendRequest<ConvertTraceResult>('sharplsp/profiler/convertTrace', {
          input_path: file.fsPath,
          format: 'speedscope',
        });
        const size = formatBytes(result.file_size_bytes);
        void vscode.window.showInformationMessage(`Converted: ${result.output_path} (${size})`);
        await openSpeedScope(result.output_path);
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Convert failed: ${getErrorMessage(err)}`);
      }
    }),
  );

  async function collectDumpOn(pid: number): Promise<void> {
    const lsp = getClient();
    if (lsp === undefined || isTestMode) return;
    try {
      const dumpType = await vscode.window.showQuickPick(['Heap', 'Full', 'Mini'], {
        placeHolder: 'Select dump type',
      });
      if (dumpType === undefined) return;
      const result = await lsp.sendRequest<CollectDumpResult>('sharplsp/profiler/collectDump', {
        pid,
        dump_type: dumpType,
      });
      const size = formatBytes(result.file_size_bytes);
      void vscode.window.showInformationMessage(`Dump saved: ${result.output_path} (${size})`);
    } catch (err: unknown) {
      void vscode.window.showErrorMessage(`Collect dump failed: ${getErrorMessage(err)}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_COLLECT_DUMP, async () => {
      const lsp = getClient();
      if (lsp === undefined || isTestMode) return;
      const proc = await pickProcess(lsp);
      if (proc === undefined) return;
      await collectDumpOn(proc.pid);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_DUMP_PROCESS, async (item?: ProfilerTreeItem) => {
      const pid = item?.processPid;
      if (pid === undefined) return;
      await collectDumpOn(pid);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_ANALYZE_HEAP, async () => {
      const lsp = getClient();
      if (lsp === undefined || isTestMode) return;

      try {
        const dumpFiles = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Dump files': ['dmp'] },
          title: 'Select memory dump file',
        });
        const selectedFile = dumpFiles?.[0];
        if (selectedFile === undefined) return;

        const dumpPath = selectedFile.fsPath;
        const result = await lsp.sendRequest<HeapStats>('sharplsp/profiler/analyzeHeap', {
          dump_path: dumpPath,
        });

        await showHeapStats(result);
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        void vscode.window.showErrorMessage(`Heap analysis failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_DIFF_SNAPSHOTS, async () => {
      const lsp = getClient();
      if (lsp === undefined || isTestMode) return;
      try {
        await promptAndOpenDiff(context, lsp);
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Heap diff failed: ${getErrorMessage(err)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_DETECT_LEAKS, async () => {
      const lsp = getClient();
      if (lsp === undefined || isTestMode) return;
      try {
        await detectLeaksWorkflow(context, lsp);
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Leak detection failed: ${getErrorMessage(err)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_SHOW_OBJECT_GRAPH, async () => {
      const lsp = getClient();
      if (lsp === undefined || isTestMode) return;
      try {
        await promptAndOpenGraph(context, lsp);
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Object graph failed: ${getErrorMessage(err)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_INSPECT_OBJECT, async () => {
      const lsp = getClient();
      if (lsp === undefined || isTestMode) return;

      const dumpFiles = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Dump files': ['dmp'] },
        title: 'Select memory dump file',
      });
      const dumpFile = dumpFiles?.[0];
      if (dumpFile === undefined) return;

      const address = await vscode.window.showInputBox({
        prompt: 'Enter the object address (hex)',
        placeHolder: '00007ff812345678',
        validateInput: (v) => (v.trim().length > 0 ? undefined : 'Address is required'),
      });
      if (address === undefined) return;

      try {
        const result = await lsp.sendRequest<{
          address: string;
          type_name: string;
          size_bytes: number;
          generation: string;
          is_pinned: boolean;
          fields: {
            name: string;
            type_name: string;
            value: string;
            is_reference: boolean;
            reference_address?: string;
          }[];
        }>('sharplsp/profiler/inspectObject', {
          dump_path: dumpFile.fsPath,
          object_address: address.trim(),
        });

        const lines = [
          `Object Inspection: ${result.type_name}`,
          `Address: ${result.address}`,
          `Size: ${String(result.size_bytes)} bytes`,
          `Generation: ${result.generation}`,
          `Pinned: ${String(result.is_pinned)}`,
          '',
          'Fields:',
          '─'.repeat(60),
        ];
        for (const f of result.fields) {
          const ref = f.reference_address !== undefined ? ` → ${f.reference_address}` : '';
          lines.push(`  ${f.name}: ${f.type_name} = ${f.value}${ref}`);
        }

        const doc = await vscode.workspace.openTextDocument({
          content: lines.join('\n'),
          language: 'plaintext',
        });
        await vscode.window.showTextDocument(doc, {
          preview: true,
        });
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(`Object inspection failed: ${getErrorMessage(err)}`);
      }
    }),
  );
}

// ── SpeedScope Integration ────────────────────────────────────────

/**
 * Open a trace file. Converts `.nettrace` to SpeedScope JSON on the fly via
 * `sharplsp/profiler/convertTrace` when needed. The LSP client may be unavailable
 * if the extension hasn't finished activating — in that case we just surface
 * the file path to the user.
 */
async function openTraceFile(client: LanguageClient | undefined, filePath: string): Promise<void> {
  if (filePath.endsWith('.speedscope.json')) {
    await openSpeedScope(filePath);
    return;
  }
  if (filePath.endsWith('.nettrace')) {
    if (client === undefined) {
      void vscode.window.showWarningMessage(
        `Language server is not ready — can't convert ${filePath} yet.`,
      );
      return;
    }
    try {
      const result = await client.sendRequest<ConvertTraceResult>(
        'sharplsp/profiler/convertTrace',
        {
          input_path: filePath,
          format: 'speedscope',
        },
      );
      await openSpeedScope(result.output_path);
    } catch (err: unknown) {
      void vscode.window.showErrorMessage(`Failed to convert trace: ${getErrorMessage(err)}`);
    }
    return;
  }
  // Fallback: try to open as SpeedScope directly.
  await openSpeedScope(filePath);
}

/** Open a SpeedScope JSON trace file in the browser. */
async function openSpeedScope(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const fileUri = uri.toString();
  // SpeedScope online viewer accepts a local file URL via the #localProfilePath
  // parameter — no data is uploaded; the file is read by the browser directly.
  const speedscopeUrl = `https://www.speedscope.app/#localProfilePath=${encodeURIComponent(fileUri)}`;
  await vscode.env.openExternal(vscode.Uri.parse(speedscopeUrl));
}

// ── Helpers ───────────────────────────────────────────────────────

async function pickActiveSession(
  provider: ProfilerTreeProvider,
  kind: string,
): Promise<string | undefined> {
  const sessions = provider.getActiveSessions(kind);

  if (sessions.length === 0) {
    void vscode.window.showInformationMessage(`No active ${kind} sessions.`);
    return undefined;
  }

  if (sessions.length === 1) {
    return sessions[0]?.id;
  }

  const picked = await vscode.window.showQuickPick(
    sessions.map((s) => ({
      label:
        s.processName !== undefined && s.processName.length > 0
          ? `${s.kind}: ${s.processName} (PID ${String(s.pid)}) [${s.id}]`
          : `${s.kind}: PID ${String(s.pid)} [${s.id}]`,
      sessionId: s.id,
    })),
    { placeHolder: `Select ${kind} session to stop` },
  );

  return picked?.sessionId;
}

async function showHeapStats(stats: HeapStats): Promise<void> {
  const lines: string[] = [
    `Heap Analysis — ${String(stats.total_objects)} objects, ${formatBytes(stats.total_size_bytes)}`,
    '',
    'Type Name                                            Count    Total Size',
    '\u2500'.repeat(80),
  ];

  for (const t of stats.types) {
    const name = t.type_name.length > 50 ? t.type_name.substring(0, 47) + '...' : t.type_name;
    const count = String(t.count).padStart(8);
    const size = formatBytes(t.total_size_bytes).padStart(12);
    lines.push(`${name.padEnd(53)} ${count}    ${size}`);
  }

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'plaintext',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${String(minutes)}m ${remaining.toFixed(0)}s`;
}
