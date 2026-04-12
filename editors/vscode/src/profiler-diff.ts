/**
 * Heap snapshot diff webview panel and leak detection commands.
 *
 * Shows a sortable table of type-level growth between two heap snapshots
 * and highlights probable leak suspects.
 */

import * as vscode from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
import { getErrorMessage } from "./utils.js";
import { ObjectGraphPanel } from "./profiler-graph.js";

// ── LSP types ─────────────────────────────────────────────────────

interface HeapTypeDiff {
    readonly type_name: string;
    readonly baseline_count: number;
    readonly comparison_count: number;
    readonly count_delta: number;
    readonly baseline_size_bytes: number;
    readonly comparison_size_bytes: number;
    readonly size_delta_bytes: number;
    readonly growth_percent: number;
}

interface LeakSuspect {
    readonly type_name: string;
    readonly severity: "high" | "medium" | "low";
    readonly reason: string;
    readonly count_delta: number;
    readonly size_delta_bytes: number;
}

interface HeapDiffResult {
    readonly baseline_total_objects: number;
    readonly baseline_total_size_bytes: number;
    readonly comparison_total_objects: number;
    readonly comparison_total_size_bytes: number;
    readonly diffs: HeapTypeDiff[];
    readonly leak_suspects: LeakSuspect[];
}

// ── Panel ─────────────────────────────────────────────────────────

/** Message sent from the diff webview to the extension host. */
interface DiffWebviewMessage {
    readonly command: "showGraph";
    readonly typeName: string;
    readonly dumpPath: string;
}

/** Manages the heap diff webview panel. */
export class HeapDiffPanel {
    private static panelCounter = 0;

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;

    private constructor(
        baselinePath: string,
        comparisonPath: string,
        context: vscode.ExtensionContext,
        client: LanguageClient,
    ) {
        const id = ++HeapDiffPanel.panelCounter;
        this.panel = vscode.window.createWebviewPanel(
            "forgeHeapDiff",
            `Heap Diff #${String(id)}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        this.panel.onDidDispose(
            () => {
                this.disposed = true;
            },
            undefined,
            context.subscriptions,
        );

        this.panel.webview.onDidReceiveMessage(
            async (msg: DiffWebviewMessage) => {
                const address = await vscode.window.showInputBox({
                    prompt: `Enter the object address (hex) for type: ${msg.typeName}`,
                    placeHolder: "00007ff812345678",
                    validateInput: (v) =>
                        v.trim().length > 0 ? undefined : "Address is required",
                });
                if (address === undefined) return;
                await ObjectGraphPanel.open(
                    msg.dumpPath,
                    address.trim(),
                    context,
                    client,
                );
            },
            undefined,
            context.subscriptions,
        );

        this.panel.webview.html = buildLoadingHtml(
            baselinePath,
            comparisonPath,
        );
    }

    /** Open a diff panel and fetch results. */
    public static async open(
        baselinePath: string,
        comparisonPath: string,
        context: vscode.ExtensionContext,
        client: LanguageClient,
    ): Promise<void> {
        const pane = new HeapDiffPanel(
            baselinePath,
            comparisonPath,
            context,
            client,
        );

        try {
            const result = await client.sendRequest<HeapDiffResult>(
                "forge/profiler/diffHeapSnapshots",
                {
                    baseline_dump_path: baselinePath,
                    comparison_dump_path: comparisonPath,
                },
            );
            pane.render(result, baselinePath, comparisonPath);
        } catch (err: unknown) {
            pane.showError(getErrorMessage(err));
        }
    }

    private render(
        result: HeapDiffResult,
        baselinePath: string,
        comparisonPath: string,
    ): void {
        if (this.disposed) return;
        this.panel.webview.html = buildDiffHtml(
            result,
            baselinePath,
            comparisonPath,
        );
    }

    private showError(message: string): void {
        if (this.disposed) return;
        this.panel.webview.html = buildErrorHtml(message);
    }
}

// ── HTML builders ─────────────────────────────────────────────────

function buildLoadingHtml(
    baselinePath: string,
    comparisonPath: string,
): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Heap Diff</title>
<style>
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background);
         color: var(--vscode-foreground); display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; }
  .loading { text-align: center; }
  .spinner { width: 32px; height: 32px; border: 3px solid var(--vscode-panel-border);
             border-top-color: var(--vscode-focusBorder); border-radius: 50%;
             animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  code { font-size: 0.85em; }
</style>
</head>
<body>
<div class="loading">
  <div class="spinner"></div>
  <p>Comparing heap snapshots…</p>
  <p style="font-size:0.82em; color:var(--vscode-descriptionForeground);">
    Baseline: <code>${escapeHtml(baselinePath)}</code><br>
    Comparison: <code>${escapeHtml(comparisonPath)}</code>
  </p>
</div>
</body>
</html>`;
}

function buildErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Heap Diff — Error</title>
<style>
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background);
         color: var(--vscode-foreground); padding: 20px; }
  .error { color: var(--vscode-errorForeground);
           border: 1px solid var(--vscode-inputValidation-errorBorder);
           padding: 12px; border-radius: 4px; }
</style>
</head>
<body>
<div class="error"><strong>Heap diff failed:</strong><br>${escapeHtml(message)}</div>
</body>
</html>`;
}

function buildDiffHtml(
    result: HeapDiffResult,
    baselinePath: string,
    comparisonPath: string,
): string {
    const cmpPathEscaped = escapeHtml(comparisonPath);

    const susRows = result.leak_suspects
        .map((s) => {
            const badge = severityBadge(s.severity);
            const typeEscaped = escapeHtml(s.type_name);
            return `<tr class="suspect-row sev-${s.severity} clickable" data-type="${typeEscaped}" data-dump="${cmpPathEscaped}" title="Click to open object graph for ${typeEscaped}">
        <td>${badge}</td>
        <td class="type-name">${typeEscaped}</td>
        <td class="mono">+${String(s.count_delta)}</td>
        <td class="mono">${formatBytes(s.size_delta_bytes)}</td>
        <td class="reason">${escapeHtml(s.reason)}</td>
      </tr>`;
        })
        .join("\n");

    const diffRows = result.diffs
        .map((d) => {
            const growthSign = d.growth_percent >= 0 ? "+" : "";
            const deltaSign = d.size_delta_bytes >= 0 ? "+" : "";
            const typeEscaped = escapeHtml(d.type_name);
            return `<tr class="clickable" data-type="${typeEscaped}" data-dump="${cmpPathEscaped}" title="Click to open object graph for ${typeEscaped}">
        <td class="type-name">${typeEscaped}</td>
        <td class="mono">${String(d.baseline_count)}</td>
        <td class="mono">${String(d.comparison_count)}</td>
        <td class="mono ${d.count_delta > 0 ? "pos" : d.count_delta < 0 ? "neg" : ""}">${d.count_delta > 0 ? "+" : ""}${String(d.count_delta)}</td>
        <td class="mono">${formatBytes(d.baseline_size_bytes)}</td>
        <td class="mono">${formatBytes(d.comparison_size_bytes)}</td>
        <td class="mono ${d.size_delta_bytes > 0 ? "pos" : d.size_delta_bytes < 0 ? "neg" : ""}">${deltaSign}${formatBytes(d.size_delta_bytes)}</td>
        <td class="mono ${d.growth_percent > 0 ? "pos" : d.growth_percent < 0 ? "neg" : ""}">${growthSign}${d.growth_percent.toFixed(1)}%</td>
      </tr>`;
        })
        .join("\n");

    const baselineObj = result.baseline_total_objects.toLocaleString();
    const cmpObj = result.comparison_total_objects.toLocaleString();
    const baselineSize = formatBytes(result.baseline_total_size_bytes);
    const cmpSize = formatBytes(result.comparison_total_size_bytes);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Heap Diff</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         background: var(--vscode-editor-background); color: var(--vscode-foreground);
         margin: 0; padding: 12px; }
  h2 { font-size: 1.05em; margin: 0 0 6px; }
  h3 { font-size: 0.95em; margin: 14px 0 6px; color: var(--vscode-descriptionForeground); }
  .meta { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  .meta span { color: var(--vscode-foreground); }
  .summary { display: flex; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
  .summary-card { background: var(--vscode-editorWidget-background, #1e1e1e);
                  border: 1px solid var(--vscode-panel-border); border-radius: 4px;
                  padding: 8px 12px; font-size: 0.85em; }
  .summary-card .label { color: var(--vscode-descriptionForeground); font-size: 0.82em; }
  .summary-card .value { font-weight: 600; font-size: 1.05em; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
  th { text-align: left; padding: 4px 8px; border-bottom: 2px solid var(--vscode-panel-border);
       font-weight: 600; font-size: 0.82em; color: var(--vscode-descriptionForeground);
       cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { color: var(--vscode-foreground); }
  td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, #2a2a2a); }
  td.type-name { font-size: 0.83em; word-break: break-all; max-width: 260px; }
  td.mono { font-variant-numeric: tabular-nums; }
  td.pos { color: var(--vscode-notificationsWarningIcon-foreground, #e08c30); }
  td.neg { color: var(--vscode-gitDecoration-deletedResourceForeground, #6b8); }
  td.reason { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.78em;
           font-weight: 600; text-transform: uppercase; }
  .badge-high { background: #8b1a1a; color: #ff8080; }
  .badge-medium { background: #7a4a00; color: #ffa060; }
  .badge-low { background: #5a5a00; color: #e0e060; }
  .filter-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
  .filter-bar input { padding: 4px 8px; background: var(--vscode-input-background);
                      color: var(--vscode-input-foreground);
                      border: 1px solid var(--vscode-input-border, #555);
                      border-radius: 3px; font-size: 0.85em; width: 200px; }
  .filter-bar label { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
  .no-suspects { color: var(--vscode-gitDecoration-addedResourceForeground, #6b8);
                 font-size: 0.9em; padding: 8px 0; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: var(--vscode-list-hoverBackground); }
  .graph-hint { font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
</style>
</head>
<body>
<h2>Heap Snapshot Diff</h2>
<div class="meta">
  Baseline: <span>${escapeHtml(baselinePath)}</span><br>
  Comparison: <span>${escapeHtml(comparisonPath)}</span>
</div>

<div class="summary">
  <div class="summary-card">
    <div class="label">Baseline Objects</div>
    <div class="value">${baselineObj}</div>
  </div>
  <div class="summary-card">
    <div class="label">Comparison Objects</div>
    <div class="value">${cmpObj}</div>
  </div>
  <div class="summary-card">
    <div class="label">Baseline Heap</div>
    <div class="value">${baselineSize}</div>
  </div>
  <div class="summary-card">
    <div class="label">Comparison Heap</div>
    <div class="value">${cmpSize}</div>
  </div>
</div>

<h3>Leak Suspects (${String(result.leak_suspects.length)})</h3>
${
    result.leak_suspects.length === 0
        ? '<div class="no-suspects">No leak suspects detected.</div>'
        : `<p class="graph-hint">Click a row to open the object retention graph for that type.</p>
<table id="suspect-table">
  <thead>
    <tr>
      <th>Severity</th><th>Type</th><th>Count Delta</th><th>Size Delta</th><th>Reason</th>
    </tr>
  </thead>
  <tbody>${susRows}</tbody>
</table>`
}

<h3>All Growing Types (${String(result.diffs.length)})</h3>
<div class="filter-bar">
  <input id="type-filter" type="text" placeholder="Filter by type name…">
  <label>Showing <span id="visible-count">${String(result.diffs.length)}</span> of ${String(result.diffs.length)}</label>
</div>
<table id="diff-table">
  <thead>
    <tr>
      <th onclick="sortTable(0)">Type</th>
      <th onclick="sortTable(1)">Baseline Count</th>
      <th onclick="sortTable(2)">Current Count</th>
      <th onclick="sortTable(3)">Count Delta</th>
      <th onclick="sortTable(4)">Baseline Size</th>
      <th onclick="sortTable(5)">Current Size</th>
      <th onclick="sortTable(6)">Size Delta</th>
      <th onclick="sortTable(7)">Growth %</th>
    </tr>
  </thead>
  <tbody id="diff-tbody">${diffRows}</tbody>
</table>

<script>
(function() {
  "use strict";

  const filterInput = document.getElementById("type-filter");
  const tbody = document.getElementById("diff-tbody");
  const visibleCount = document.getElementById("visible-count");
  const allRows = Array.from(tbody.querySelectorAll("tr"));

  filterInput.addEventListener("input", function() {
    const lower = this.value.toLowerCase();
    let visible = 0;
    allRows.forEach(function(row) {
      const name = row.querySelector(".type-name");
      const text = name ? name.textContent.toLowerCase() : "";
      const show = lower === "" || text.includes(lower);
      row.style.display = show ? "" : "none";
      if (show) visible++;
    });
    visibleCount.textContent = String(visible);
  });

  let sortCol = -1, sortAsc = true;

  window.sortTable = function(col) {
    if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }

    const rows = Array.from(tbody.querySelectorAll("tr"));
    rows.sort(function(a, b) {
      const aCell = a.querySelectorAll("td")[col];
      const bCell = b.querySelectorAll("td")[col];
      const aText = aCell ? aCell.textContent.trim() : "";
      const bText = bCell ? bCell.textContent.trim() : "";
      const aNum = parseFloat(aText.replace(/[^0-9.\\-]/g, ""));
      const bNum = parseFloat(bText.replace(/[^0-9.\\-]/g, ""));
      const numeric = !isNaN(aNum) && !isNaN(bNum);
      let cmp = numeric ? aNum - bNum : aText.localeCompare(bText);
      return sortAsc ? cmp : -cmp;
    });
    rows.forEach(function(r) { tbody.appendChild(r); });
  };

  // Click-to-graph: clicking a row sends a message to the extension host.
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("tr.clickable").forEach(function(row) {
    row.addEventListener("click", function() {
      const typeName = row.getAttribute("data-type") || "";
      const dumpPath = row.getAttribute("data-dump") || "";
      if (typeName && dumpPath) {
        vscode.postMessage({ command: "showGraph", typeName: typeName, dumpPath: dumpPath });
      }
    });
  });
})();
</script>
</body>
</html>`;
}

function severityBadge(severity: "high" | "medium" | "low"): string {
    return `<span class="badge badge-${severity}">${severity}</span>`;
}

function formatBytes(bytes: number): string {
    const abs = Math.abs(bytes);
    const sign = bytes < 0 ? "-" : "";
    if (abs < 1024) return `${sign}${String(abs)} B`;
    const kb = abs / 1024;
    if (kb < 1024) return `${sign}${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${sign}${mb.toFixed(1)} MB`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Prompt for two dump files and open the diff panel. */
export async function promptAndOpenDiff(
    context: vscode.ExtensionContext,
    client: LanguageClient,
): Promise<void> {
    const baseline = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Dump files": ["dmp"] },
        title: "Select BASELINE dump file",
    });
    const baselineFile = baseline?.[0];
    if (baselineFile === undefined) return;

    const comparison = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Dump files": ["dmp"] },
        title: "Select COMPARISON dump file",
    });
    const comparisonFile = comparison?.[0];
    if (comparisonFile === undefined) return;

    await HeapDiffPanel.open(
        baselineFile.fsPath,
        comparisonFile.fsPath,
        context,
        client,
    );
}

/** Guided "Detect Leaks" workflow: baseline → prompt user → comparison → diff. */
export async function detectLeaksWorkflow(
    context: vscode.ExtensionContext,
    client: LanguageClient,
): Promise<void> {
    const answer = await vscode.window.showInformationMessage(
        "Leak Detection: Select the BASELINE dump first (collected before the suspected leak).",
        "Select Baseline",
        "Cancel",
    );
    if (answer !== "Select Baseline") return;

    const baseline = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Dump files": ["dmp"] },
        title: "Select BASELINE dump file",
    });
    const baselineFile = baseline?.[0];
    if (baselineFile === undefined) return;

    const answer2 = await vscode.window.showInformationMessage(
        "Now exercise the suspected leak path in your application, then collect a comparison dump.",
        "Select Comparison Dump",
        "Cancel",
    );
    if (answer2 !== "Select Comparison Dump") return;

    const comparison = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Dump files": ["dmp"] },
        title: "Select COMPARISON dump file",
    });
    const comparisonFile = comparison?.[0];
    if (comparisonFile === undefined) return;

    await HeapDiffPanel.open(
        baselineFile.fsPath,
        comparisonFile.fsPath,
        context,
        client,
    );
}
