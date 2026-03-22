import * as vscode from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
import * as log from "./log.js";
import {
  CMD_PROFILER_LIST_PROCESSES,
  CMD_PROFILER_START_TRACE,
  CMD_PROFILER_STOP_TRACE,
  CMD_PROFILER_START_COUNTERS,
  CMD_PROFILER_STOP_COUNTERS,
  CMD_PROFILER_COLLECT_DUMP,
  CMD_PROFILER_ANALYZE_HEAP,
  CMD_PROFILER_REFRESH,
} from "./constants.js";

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
  readonly kind: string;
  readonly pid: number;
}

/** A node in the Profiler tree view. */
class ProfilerTreeItem extends vscode.TreeItem {
  public readonly nodeKind: string;
  public readonly processPid: number | undefined;
  public readonly sessionId: string | undefined;

  constructor(
    label: string,
    nodeKind: string,
    collapsible: vscode.TreeItemCollapsibleState,
    options?: { pid?: number; sessionId?: string },
  ) {
    super(label, collapsible);
    this.nodeKind = nodeKind;
    this.processPid = options?.pid ?? undefined;
    this.sessionId = options?.sessionId ?? undefined;
  }
}

export class ProfilerTreeProvider
  implements vscode.TreeDataProvider<ProfilerTreeItem>
{
  private readonly emitter = new vscode.EventEmitter<
    ProfilerTreeItem | undefined
  >();
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
        "forge/profiler/listProcesses",
        {},
      );
      this.processes = result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.info(`Failed to list .NET processes: ${msg}`);
      this.processes = [];
    }
    this.emitter.fire(undefined);
  }

  public addSession(id: string, kind: string, pid: number): void {
    this.activeSessions.push({ id, kind, pid });
    this.emitter.fire(undefined);
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
        "header",
        vscode.TreeItemCollapsibleState.None,
      );
      header.iconPath = new vscode.ThemeIcon("pulse");
      nodes.push(header);

      for (const session of this.activeSessions) {
        const node = new ProfilerTreeItem(
          `${session.kind}: PID ${String(session.pid)} [${session.id}]`,
          "session",
          vscode.TreeItemCollapsibleState.None,
          { sessionId: session.id },
        );
        node.iconPath = new vscode.ThemeIcon("debug-start");
        nodes.push(node);
      }
    }

    if (this.processes.length > 0) {
      const header = new ProfilerTreeItem(
        `.NET Processes (${String(this.processes.length)})`,
        "header",
        vscode.TreeItemCollapsibleState.None,
      );
      header.iconPath = new vscode.ThemeIcon("server-process");
      nodes.push(header);

      for (const proc of this.processes) {
        const node = new ProfilerTreeItem(
          `${proc.name} (PID ${String(proc.pid)})`,
          "process",
          vscode.TreeItemCollapsibleState.None,
          { pid: proc.pid },
        );
        node.description = proc.command_line;
        node.iconPath = new vscode.ThemeIcon("terminal");
        nodes.push(node);
      }
    }

    if (nodes.length === 0) {
      const empty = new ProfilerTreeItem(
        "No .NET processes found",
        "header",
        vscode.TreeItemCollapsibleState.None,
      );
      empty.iconPath = new vscode.ThemeIcon("info");
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
      "forgeCounters",
      `Counters: PID ${String(pid)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.onDidDispose(() => {
      this.disposed = true;
      CounterWebviewPanel.panels.delete(sessionId);
    }, undefined, context.subscriptions);

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
    this.panel.webview.html = buildCounterHtml(
      Array.from(this.counters.values()),
    );
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
    .join("\n");

  const timestamp = new Date().toLocaleTimeString();
  const placeholder = counters.length === 0
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
  if (u === "bytes" || u.includes("byte")) {
    return formatBytes(value);
  }
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(2);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Status Bar ────────────────────────────────────────────────────

/** Status bar item showing active profiling sessions. */
export class ProfilerStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.item.tooltip = "Active profiling sessions — click to list processes";
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

async function pickProcess(
  client: LanguageClient,
): Promise<DotNetProcess | undefined> {
  const processes = await client.sendRequest<DotNetProcess[]>(
    "forge/profiler/listProcesses",
    {},
  );

  if (processes.length === 0) {
    void vscode.window.showInformationMessage("No .NET processes found.");
    return undefined;
  }

  const items = processes.map((p) => ({
    label: `${p.name} (PID ${String(p.pid)})`,
    description: p.command_line,
    process: p,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a .NET process",
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
  /** Map from session ID to its counter webview (if open). */
  const counterPanels = new Map<string, CounterWebviewPanel>();

  /** Wire up the counterUpdate notification handler once a client exists. */
  function wireCounterNotifications(client: LanguageClient): void {
    client.onNotification(
      "forge/profiler/counterUpdate",
      (params: CounterUpdateParams) => {
        const panel = counterPanels.get(params.session_id);
        if (panel !== undefined) {
          panel.pushUpdate(params.counters);
        }
      },
    );
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

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_START_TRACE, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;

      try {
        const proc = await pickProcess(lsp);
        if (proc === undefined) return;

        const result = await lsp.sendRequest<StartTraceResult>(
          "forge/profiler/startTrace",
          { pid: proc.pid },
        );

        provider.addSession(result.session_id, "Trace", proc.pid);
        statusBar.update(provider.sessionCount);
        void vscode.window.showInformationMessage(
          `Trace started: ${result.output_path}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Start trace failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_STOP_TRACE, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;

      const sessionId = await pickActiveSession(provider, "Trace");
      if (sessionId === undefined) return;

      try {
        const result = await lsp.sendRequest<StopTraceResult>(
          "forge/profiler/stopTrace",
          { session_id: sessionId },
        );

        provider.removeSession(sessionId);
        statusBar.update(provider.sessionCount);
        const size = formatBytes(result.file_size_bytes);
        const dur = formatDuration(result.duration_ms);
        void vscode.window.showInformationMessage(
          `Trace saved: ${result.output_path} (${size}, ${dur})`,
        );

        // Open SpeedScope JSON in browser if the output is a speedscope file.
        if (result.output_path.endsWith(".speedscope.json")) {
          await openSpeedScope(result.output_path);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Stop trace failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_START_COUNTERS, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;

      try {
        const proc = await pickProcess(lsp);
        if (proc === undefined) return;

        const result = await lsp.sendRequest<StartCountersResult>(
          "forge/profiler/startCounters",
          { pid: proc.pid },
        );

        provider.addSession(result.session_id, "Counters", proc.pid);
        statusBar.update(provider.sessionCount);

        // Open the live counter webview.
        const panel = CounterWebviewPanel.open(
          result.session_id,
          proc.pid,
          context,
        );
        counterPanels.set(result.session_id, panel);

        // Wire notifications now if the client was unavailable at startup.
        const currentClient = getClient();
        if (currentClient !== undefined && !CounterWebviewPanel.has("__wired__")) {
          wireCounterNotifications(currentClient);
        }

        void vscode.window.showInformationMessage(
          `Counter monitoring started for PID ${String(proc.pid)}`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Start counters failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_STOP_COUNTERS, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;

      const sessionId = await pickActiveSession(provider, "Counters");
      if (sessionId === undefined) return;

      try {
        await lsp.sendRequest("forge/profiler/stopCounters", {
          session_id: sessionId,
        });
        provider.removeSession(sessionId);
        statusBar.update(provider.sessionCount);

        // Close the counter webview if open.
        const panel = counterPanels.get(sessionId);
        if (panel !== undefined) {
          panel.dispose();
          counterPanels.delete(sessionId);
        }

        void vscode.window.showInformationMessage("Counter monitoring stopped.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Stop counters failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_COLLECT_DUMP, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;

      try {
        const proc = await pickProcess(lsp);
        if (proc === undefined) return;

        const dumpType = await vscode.window.showQuickPick(
          ["Heap", "Full", "Mini"],
          { placeHolder: "Select dump type" },
        );
        if (dumpType === undefined) return;

        const result = await lsp.sendRequest<CollectDumpResult>(
          "forge/profiler/collectDump",
          { pid: proc.pid, dump_type: dumpType },
        );

        const size = formatBytes(result.file_size_bytes);
        void vscode.window.showInformationMessage(
          `Dump saved: ${result.output_path} (${size})`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Collect dump failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_ANALYZE_HEAP, async () => {
      const lsp = getClient();
      if (lsp === undefined) return;

      try {
        const dumpFiles = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "Dump files": ["dmp"] },
          title: "Select memory dump file",
        });
        const selectedFile = dumpFiles?.[0];
        if (selectedFile === undefined) return;

        const dumpPath = selectedFile.fsPath;
        const result = await lsp.sendRequest<HeapStats>(
          "forge/profiler/analyzeHeap",
          { dump_path: dumpPath },
        );

        await showHeapStats(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Heap analysis failed: ${msg}`);
      }
    }),
  );
}

// ── SpeedScope Integration ────────────────────────────────────────

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
      label: `${s.kind}: PID ${String(s.pid)} [${s.id}]`,
      sessionId: s.id,
    })),
    { placeHolder: `Select ${kind} session to stop` },
  );

  return picked?.sessionId;
}

async function showHeapStats(stats: HeapStats): Promise<void> {
  const lines: string[] = [
    `Heap Analysis — ${String(stats.total_objects)} objects, ${formatBytes(stats.total_size_bytes)}`,
    "",
    "Type Name                                            Count    Total Size",
    "\u2500".repeat(80),
  ];

  for (const t of stats.types) {
    const name = t.type_name.length > 50
      ? t.type_name.substring(0, 47) + "..."
      : t.type_name;
    const count = String(t.count).padStart(8);
    const size = formatBytes(t.total_size_bytes).padStart(12);
    lines.push(`${name.padEnd(53)} ${count}    ${size}`);
  }

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join("\n"),
    language: "plaintext",
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
