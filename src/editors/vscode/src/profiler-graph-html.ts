// Implements [PROFILER-GRAPH-WEBVIEW]. All assets ship in the VSIX.
import { escapeHtml } from './utils.js';
import { graphSummary, type ObjectGraphResult } from './profiler-graph-types.js';
import type { HeapDiffResult } from './profiler-diff.js';

export function buildGraphHtml(
  result: ObjectGraphResult,
  root: string,
  script: string,
  source: string,
  comparison?: HeapDiffResult,
): string {
  const data = JSON.stringify({ result, comparison, root }).replaceAll('<', '\\u003c');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${escapeHtml(source)}; style-src 'unsafe-inline'; img-src data: blob:;">
<style>body{font-family:var(--vscode-font-family, sans-serif);color:var(--vscode-foreground,#ddd);background:var(--vscode-editor-background,#202020);margin:16px}header{display:flex;gap:12px;flex-wrap:wrap;align-items:center}input,button{font:inherit}svg{width:100%;height:65vh;border:1px solid #666}pre{white-space:pre-wrap}.node{cursor:pointer}.edge text{font-size:11px}#status{min-height:1.4em}</style>
</head><body><header><label>Filter by type <input id="filter" type="search"></label>
<label>Search address <input id="search" type="search"></label>
<label>Traversal depth <input id="depth" type="range" min="1" max="10" value="3"><output id="depth-value">3</output></label>
<button id="svg-export">Export SVG</button><button id="png-export">Export PNG</button></header>
<p>Click to expand and highlight the shortest root path. Right-click to inspect. Double-click to collapse.</p>
<p id="status" role="status"></p><svg id="graph" viewBox="0 0 1100 700" role="img" aria-label="Object retention graph"></svg>
<details><summary>Object list</summary><pre id="graph-summary">${escapeHtml(graphSummary(result, root))}</pre></details>
<script id="graph-data" type="application/json">${data}</script>
<script src="${escapeHtml(script)}"></script></body></html>`;
}
