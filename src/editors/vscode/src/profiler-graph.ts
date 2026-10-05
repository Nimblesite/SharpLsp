/**
 * Object retention graph webview panel.
 */

import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { escapeHtml, getErrorMessage, isRecord } from './utils.js';
import { askObjectAddress, pickDumpFile, showPlainText } from './profiler-prompts.js';
import { profilerRequest } from './profiler-request.js';
import { fileUri, joinPath } from './paths.js';
import { buildGraphHtml } from './profiler-graph-html.js';
import type { ObjectGraphResult } from './profiler-graph-types.js';
import type { HeapDiffResult } from './profiler-diff.js';

export class ObjectGraphPanel {
  private static readonly panels = new Map<string, ObjectGraphPanel>();
  private static panelCounter = 0;

  private readonly panel: vscode.WebviewPanel;
  private readonly panelId: string;
  private disposed = false;
  private result: ObjectGraphResult | undefined;
  private readonly script: string;

  private constructor(
    private readonly dumpPath: string,
    private readonly rootAddress: string,
    context: vscode.ExtensionContext,
    private readonly client: LanguageClient,
  ) {
    this.panelId = `graph-${String(++ObjectGraphPanel.panelCounter)}`;
    this.panel = vscode.window.createWebviewPanel(
      'sharplspObjectGraph',
      `Object Graph: ${rootAddress}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [fileUri(joinPath(context.extensionPath, 'dist'))],
      },
    );
    this.script = this.panel.webview
      .asWebviewUri(fileUri(joinPath(context.extensionPath, 'dist', 'profiler-graph-webview.js')))
      .toString();
    this.panel.webview.onDidReceiveMessage(
      async (message: unknown) => {
        await this.receive(message);
      },
      undefined,
      context.subscriptions,
    );

    this.panel.onDidDispose(
      () => {
        this.disposed = true;
        ObjectGraphPanel.panels.delete(this.panelId);
      },
      undefined,
      context.subscriptions,
    );

    this.panel.webview.html = `<!DOCTYPE html><html><body>Loading object graph for ${escapeHtml(rootAddress)} in ${escapeHtml(dumpPath)}…</body></html>`;
  }

  public static async open(
    dumpPath: string,
    rootAddress: string,
    context: vscode.ExtensionContext,
    client: LanguageClient,
    comparison?: HeapDiffResult,
  ): Promise<void> {
    const pane = new ObjectGraphPanel(dumpPath, rootAddress, context, client);
    ObjectGraphPanel.panels.set(pane.panelId, pane);

    try {
      const result = await profilerRequest<ObjectGraphResult>(
        client,
        'sharplsp/profiler/getObjectGraph',
        { dump_path: dumpPath, root_address: rootAddress, max_depth: 3 },
        'Building object retention graph',
      );
      if (result === undefined) {
        pane.panel.dispose();
        return;
      }
      if (!pane.disposed) {
        pane.result = result;
        pane.panel.webview.html = buildGraphHtml(
          result,
          rootAddress,
          pane.script,
          pane.panel.webview.cspSource,
          comparison,
        );
      }
    } catch (err: unknown) {
      if (!pane.disposed) {
        pane.panel.webview.html = `<!DOCTYPE html><html><body>Error: ${escapeHtml(getErrorMessage(err))}</body></html>`;
      }
    }
  }

  private async receive(message: unknown): Promise<void> {
    if (this.disposed || !isRecord(message)) return;
    const value = message;
    try {
      if (value.command === 'export') await exportGraph(value);
      else if (value.command === 'depth' && validDepth(value.depth))
        await this.load(this.rootAddress, value.depth, false);
      else if (
        typeof value.address === 'string' &&
        this.result?.nodes.some((n) => n.id === value.address) === true
      ) {
        if (value.command === 'expand' && validDepth(value.depth))
          await this.load(value.address, value.depth, true);
        if (value.command === 'inspect') await this.inspect(value.address);
      }
    } catch (error: unknown) {
      await this.panel.webview.postMessage({ error: getErrorMessage(error) });
    }
  }

  private async load(address: string, depth: number, expand: boolean): Promise<void> {
    const result = await profilerRequest<ObjectGraphResult>(
      this.client,
      'sharplsp/profiler/getObjectGraph',
      { dump_path: this.dumpPath, root_address: address, max_depth: depth },
      'Loading object references',
    );
    if (this.disposed) return;
    if (result !== undefined)
      this.result = expand && this.result !== undefined ? mergeGraph(this.result, result) : result;
    await this.panel.webview.postMessage({ result: this.result });
  }

  private async inspect(address: string): Promise<void> {
    const result = await profilerRequest<unknown>(
      this.client,
      'sharplsp/profiler/inspectObject',
      { dump_path: this.dumpPath, object_address: address },
      'Inspecting object',
    );
    if (result !== undefined) await showPlainText([JSON.stringify(result, null, 2)]);
  }
}

function validDepth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10;
}

// [PROFILER-GRAPH-WEBVIEW-FEATURES] Expanded nodes augment the current graph without duplicate edges.
export function mergeGraph(
  current: ObjectGraphResult,
  expanded: ObjectGraphResult,
): ObjectGraphResult {
  const root = expanded.nodes.find((node) => node.depth === 0);
  const offset = current.nodes.find((node) => node.id === root?.id)?.depth ?? 0;
  const children = expanded.nodes.map((node) => ({ ...node, depth: node.depth + offset }));
  const nodes = [
    ...new Map([...children, ...current.nodes].map((node) => [node.id, node])).values(),
  ];
  const edges = [
    ...new Map(
      [...current.edges, ...expanded.edges].map((edge) => [
        JSON.stringify([edge.from, edge.to, edge.field_name]),
        edge,
      ]),
    ).values(),
  ];
  return {
    nodes,
    edges,
    stats: {
      total_nodes_traversed: nodes.length,
      total_edges_traversed: edges.length,
      max_depth_reached: Math.max(
        current.stats.max_depth_reached,
        expanded.stats.max_depth_reached,
        ...nodes.map((node) => node.depth),
      ),
      truncated: current.stats.truncated || expanded.stats.truncated,
    },
  };
}

async function exportGraph(value: Record<string, unknown>): Promise<void> {
  const format = value.format,
    content = value.content;
  if (
    (format !== 'svg' && format !== 'png') ||
    typeof content !== 'string' ||
    content.length > 20_000_000
  )
    return;
  const destination = await vscode.window.showSaveDialog({
    saveLabel: 'Export graph',
    filters: { [format.toUpperCase()]: [format] },
  });
  if (destination !== undefined)
    await vscode.workspace.fs.writeFile(
      destination,
      Buffer.from(content, format === 'svg' ? 'utf8' : 'base64'),
    );
}

/** Prompt for dump path and root address, then open the graph panel. */
export async function promptAndOpenGraph(
  context: vscode.ExtensionContext,
  client: LanguageClient,
): Promise<void> {
  const dumpPath = await pickDumpFile('Select memory dump file for object graph');
  if (dumpPath === undefined) return;
  const rootAddress = await askObjectAddress(
    'Enter the root object address (hex, e.g. 00007ff812345678)',
  );
  if (rootAddress === undefined) return;
  await ObjectGraphPanel.open(dumpPath, rootAddress.trim(), context, client);
}
