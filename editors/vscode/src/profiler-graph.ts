/**
 * Object retention graph webview panel.
 */

import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { getErrorMessage } from './utils.js';

interface ObjectGraphNode {
  readonly id: string;
  readonly type_name: string;
  readonly display_name: string;
  readonly size_bytes: number;
  readonly retained_size_bytes: number;
  readonly instance_count: number;
  readonly is_root: boolean;
  readonly root_kind?: string;
  readonly depth: number;
}

interface ObjectGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly field_name: string;
  readonly reference_kind: 'Strong' | 'Weak';
}

interface ObjectGraphStats {
  readonly total_nodes_traversed: number;
  readonly total_edges_traversed: number;
  readonly max_depth_reached: number;
  readonly truncated: boolean;
}

interface ObjectGraphResult {
  readonly nodes: ObjectGraphNode[];
  readonly edges: ObjectGraphEdge[];
  readonly stats: ObjectGraphStats;
}

export class ObjectGraphPanel {
  private static readonly panels = new Map<string, ObjectGraphPanel>();
  private static panelCounter = 0;

  private readonly panel: vscode.WebviewPanel;
  private readonly panelId: string;
  private disposed = false;

  private constructor(dumpPath: string, rootAddress: string, context: vscode.ExtensionContext) {
    this.panelId = `graph-${String(++ObjectGraphPanel.panelCounter)}`;
    this.panel = vscode.window.createWebviewPanel(
      'sharplspObjectGraph',
      `Object Graph: ${rootAddress}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );

    this.panel.onDidDispose(
      () => {
        this.disposed = true;
        ObjectGraphPanel.panels.delete(this.panelId);
      },
      undefined,
      context.subscriptions,
    );

    this.panel.webview.html = `<!DOCTYPE html><html><body>Loading object graph for ${rootAddress} in ${dumpPath}…</body></html>`;
  }

  public static async open(
    dumpPath: string,
    rootAddress: string,
    context: vscode.ExtensionContext,
    client: LanguageClient,
  ): Promise<void> {
    const pane = new ObjectGraphPanel(dumpPath, rootAddress, context);
    ObjectGraphPanel.panels.set(pane.panelId, pane);

    try {
      const result = await client.sendRequest<ObjectGraphResult>(
        'sharplsp/profiler/getObjectGraph',
        { dump_path: dumpPath, root_address: rootAddress },
      );
      if (!pane.disposed) {
        pane.panel.webview.html = renderGraphSummary(result, rootAddress);
      }
    } catch (err: unknown) {
      if (!pane.disposed) {
        pane.panel.webview.html = `<!DOCTYPE html><html><body>Error: ${getErrorMessage(err)}</body></html>`;
      }
    }
  }
}

function renderGraphSummary(result: ObjectGraphResult, rootAddress: string): string {
  const { stats } = result;
  const nodeList = result.nodes
    .map((n) => `${n.display_name} (${n.type_name}) depth=${String(n.depth)}`)
    .join('\n');
  return [
    `<!DOCTYPE html><html><body><pre>`,
    `Root: ${rootAddress}`,
    `Nodes: ${String(stats.total_nodes_traversed)}, Edges: ${String(stats.total_edges_traversed)}, Max depth: ${String(stats.max_depth_reached)}`,
    stats.truncated ? 'WARNING: graph truncated' : '',
    `\n${nodeList}`,
    `</pre></body></html>`,
  ].join('\n');
}

/** Prompt for dump path and root address, then open the graph panel. */
export async function promptAndOpenGraph(
  context: vscode.ExtensionContext,
  client: LanguageClient,
): Promise<void> {
  const dumpFiles = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Dump files': ['dmp'] },
    title: 'Select memory dump file for object graph',
  });
  const selectedFile = dumpFiles?.[0];
  if (selectedFile === undefined) return;

  const rootAddress = await vscode.window.showInputBox({
    prompt: 'Enter the root object address (hex, e.g. 00007ff812345678)',
    placeHolder: '00007ff812345678',
    validateInput: (v) => (v.trim().length > 0 ? undefined : 'Address is required'),
  });
  if (rootAddress === undefined) return;

  await ObjectGraphPanel.open(selectedFile.fsPath, rootAddress.trim(), context, client);
}
