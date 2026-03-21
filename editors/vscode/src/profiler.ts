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
  getClient: () => LanguageClient | undefined,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_REFRESH, async () => {
      await provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_LIST_PROCESSES, async () => {
      const client = getClient();
      if (client === undefined) return;
      await provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_START_TRACE, async () => {
      const client = getClient();
      if (client === undefined) return;

      try {
        const proc = await pickProcess(client);
        if (proc === undefined) return;

        const result = await client.sendRequest<StartTraceResult>(
          "forge/profiler/startTrace",
          { pid: proc.pid },
        );

        provider.addSession(result.session_id, "Trace", proc.pid);
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
      const client = getClient();
      if (client === undefined) return;

      const sessionId = await pickActiveSession(provider, "Trace");
      if (sessionId === undefined) return;

      try {
        const result = await client.sendRequest<StopTraceResult>(
          "forge/profiler/stopTrace",
          { session_id: sessionId },
        );

        provider.removeSession(sessionId);
        const size = formatBytes(result.file_size_bytes);
        const dur = formatDuration(result.duration_ms);
        void vscode.window.showInformationMessage(
          `Trace saved: ${result.output_path} (${size}, ${dur})`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Stop trace failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_START_COUNTERS, async () => {
      const client = getClient();
      if (client === undefined) return;

      try {
        const proc = await pickProcess(client);
        if (proc === undefined) return;

        const result = await client.sendRequest<StartCountersResult>(
          "forge/profiler/startCounters",
          { pid: proc.pid },
        );

        provider.addSession(result.session_id, "Counters", proc.pid);
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
      const client = getClient();
      if (client === undefined) return;

      const sessionId = await pickActiveSession(provider, "Counters");
      if (sessionId === undefined) return;

      try {
        await client.sendRequest("forge/profiler/stopCounters", {
          session_id: sessionId,
        });
        provider.removeSession(sessionId);
        void vscode.window.showInformationMessage("Counter monitoring stopped.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Stop counters failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_PROFILER_COLLECT_DUMP, async () => {
      const client = getClient();
      if (client === undefined) return;

      try {
        const proc = await pickProcess(client);
        if (proc === undefined) return;

        const dumpType = await vscode.window.showQuickPick(
          ["Heap", "Full", "Mini"],
          { placeHolder: "Select dump type" },
        );
        if (dumpType === undefined) return;

        const result = await client.sendRequest<CollectDumpResult>(
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
      const client = getClient();
      if (client === undefined) return;

      try {
        const dumpFiles = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "Dump files": ["dmp"] },
          title: "Select memory dump file",
        });
        const selectedFile = dumpFiles?.[0];
        if (selectedFile === undefined) return;

        const dumpPath = selectedFile.fsPath;
        const result = await client.sendRequest<HeapStats>(
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
