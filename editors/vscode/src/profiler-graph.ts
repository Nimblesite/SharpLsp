/**
 * Object retention graph webview panel.
 *
 * Renders a D3.js force-directed graph showing which objects hold
 * references to each other in a managed heap dump.
 */

import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { getErrorMessage } from './utils.js';

// ── LSP types ─────────────────────────────────────────────────────

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

// ── Panel ─────────────────────────────────────────────────────────

/** Manages the object graph webview panel. */
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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.onDidDispose(
      () => {
        this.disposed = true;
        ObjectGraphPanel.panels.delete(this.panelId);
      },
      undefined,
      context.subscriptions,
    );

    this.panel.webview.html = buildLoadingHtml(dumpPath, rootAddress);
  }

  /** Open a graph panel and begin loading data. */
  public static async open(
    dumpPath: string,
    rootAddress: string,
    context: vscode.ExtensionContext,
    client: LanguageClient,
  ): Promise<void> {
    const pane = new ObjectGraphPanel(dumpPath, rootAddress, context);
    ObjectGraphPanel.panels.set(pane.panelId, pane);

    try {
      const result = await client.sendRequest<ObjectGraphResult>('sharplsp/profiler/getObjectGraph', {
        dump_path: dumpPath,
        root_address: rootAddress,
      });
      pane.render(result);
    } catch (err: unknown) {
      pane.showError(getErrorMessage(err));
    }
  }

  private render(result: ObjectGraphResult): void {
    if (this.disposed) return;
    this.panel.webview.html = buildGraphHtml(result);
  }

  private showError(message: string): void {
    if (this.disposed) return;
    this.panel.webview.html = buildErrorHtml(message);
  }
}

// ── HTML builders ─────────────────────────────────────────────────

function buildLoadingHtml(dumpPath: string, rootAddress: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Object Graph</title>
<style>
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background);
         color: var(--vscode-foreground); display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; }
  .loading { text-align: center; }
  .spinner { width: 32px; height: 32px; border: 3px solid var(--vscode-panel-border);
             border-top-color: var(--vscode-focusBorder); border-radius: 50%;
             animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="loading">
  <div class="spinner"></div>
  <p>Building object graph for <code>${escapeHtml(rootAddress)}</code>…</p>
  <p style="font-size:0.85em; color: var(--vscode-descriptionForeground);">${escapeHtml(dumpPath)}</p>
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
<title>Object Graph — Error</title>
<style>
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background);
         color: var(--vscode-foreground); padding: 20px; }
  .error { color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder);
           padding: 12px; border-radius: 4px; }
</style>
</head>
<body>
<div class="error"><strong>Failed to build object graph:</strong><br>${escapeHtml(message)}</div>
</body>
</html>`;
}

function buildGraphHtml(result: ObjectGraphResult): string {
  const nodesJson = JSON.stringify(result.nodes);
  const edgesJson = JSON.stringify(result.edges);
  const stats = result.stats;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Object Retention Graph</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: var(--vscode-editor-background);
         color: var(--vscode-foreground); font-family: var(--vscode-font-family);
         font-size: var(--vscode-font-size); overflow: hidden; }
  #header { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border);
             display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  #header h2 { margin: 0; font-size: 1em; font-weight: 600; }
  .stat { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
  .stat span { color: var(--vscode-foreground); font-weight: 600; }
  #filter-input { padding: 3px 8px; background: var(--vscode-input-background);
                  color: var(--vscode-input-foreground);
                  border: 1px solid var(--vscode-input-border, #555);
                  border-radius: 3px; font-size: 0.85em; width: 180px; }
  .ctrl-group { display: flex; align-items: center; gap: 6px; font-size: 0.82em;
                color: var(--vscode-descriptionForeground); }
  .ctrl-group input[type="range"] { width: 80px; }
  .btn { padding: 3px 8px; background: var(--vscode-button-secondaryBackground, #3a3d41);
         color: var(--vscode-button-secondaryForeground, #ccc);
         border: 1px solid var(--vscode-input-border, #555);
         border-radius: 3px; font-size: 0.82em; cursor: pointer; white-space: nowrap; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, #4a4d51); }
  #canvas-container { width: 100%; height: calc(100vh - 60px); position: relative; }
  svg { width: 100%; height: 100%; }
  .node circle { stroke-width: 2; cursor: pointer; }
  .node circle.root { stroke-dasharray: 4 2; }
  .node text { font-size: 10px; fill: var(--vscode-foreground); pointer-events: none;
               text-anchor: middle; dominant-baseline: central; }
  .link { stroke-opacity: 0.5; fill: none; }
  .link.strong { stroke: var(--vscode-panel-border, #555); }
  .link.weak { stroke: var(--vscode-panel-border, #555); stroke-dasharray: 4 2; }
  #tooltip { position: absolute; background: var(--vscode-editorHoverWidget-background, #252526);
             color: var(--vscode-editorHoverWidget-foreground, #ccc);
             border: 1px solid var(--vscode-editorHoverWidget-border, #555);
             padding: 8px 10px; border-radius: 4px; font-size: 0.82em;
             pointer-events: none; display: none; max-width: 320px;
             box-shadow: 0 2px 8px rgba(0,0,0,0.4); z-index: 10; }
  #tooltip .name { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
  #legend { position: absolute; bottom: 12px; left: 12px; font-size: 0.78em;
            background: var(--vscode-editorWidget-background, #1e1e1e);
            border: 1px solid var(--vscode-panel-border); padding: 8px 10px; border-radius: 4px; }
  #legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
                 margin-right: 4px; vertical-align: middle; }
  #legend div { margin-bottom: 3px; }
</style>
</head>
<body>
<div id="header">
  <h2>Object Retention Graph</h2>
  <div class="stat">Nodes: <span id="stat-nodes">${String(stats.total_nodes_traversed)}</span></div>
  <div class="stat">Edges: <span id="stat-edges">${String(stats.total_edges_traversed)}</span></div>
  <div class="stat">Max depth: <span>${String(stats.max_depth_reached)}</span></div>
  ${stats.truncated ? '<div class="stat" style="color:var(--vscode-notificationsWarningIcon-foreground)">&#9888; Graph truncated</div>' : ''}
  <input id="filter-input" type="text" placeholder="Filter by type…" />
  <div class="ctrl-group">
    <label for="depth-slider">Depth:</label>
    <input id="depth-slider" type="range" min="0" max="${String(stats.max_depth_reached)}" value="${String(stats.max_depth_reached)}" />
    <span id="depth-value">${String(stats.max_depth_reached)}</span>
  </div>
  <button class="btn" id="export-svg-btn">Export SVG</button>
</div>
<div id="canvas-container">
  <svg id="graph-svg"></svg>
  <div id="tooltip"></div>
  <div id="legend">
    <div><span class="dot" style="background:#e05050;"></span> Leak suspect / GC root</div>
    <div><span class="dot" style="background:#e08c30;"></span> Large retained size</div>
    <div><span class="dot" style="background:#4a8fd4;"></span> GC root</div>
    <div><span class="dot" style="background:#666;"></span> Normal object</div>
  </div>
</div>
<script>
(function() {
  "use strict";

  const allNodes = ${nodesJson};
  const allEdges = ${edgesJson};

  let visibleNodes = allNodes.slice();
  let visibleEdges = allEdges.slice();

  const svg = document.getElementById("graph-svg");
  const tooltip = document.getElementById("tooltip");
  const filterInput = document.getElementById("filter-input");

  // Simple force-directed layout using requestAnimationFrame.
  // Each node has position (x, y) and velocity (vx, vy).

  const WIDTH = () => svg.clientWidth || 800;
  const HEIGHT = () => svg.clientHeight || 600;
  const NODE_RADIUS = (node) => {
    const base = 12;
    const scale = Math.log10(Math.max(node.retained_size_bytes, 100) / 100);
    return Math.min(base + scale * 4, 32);
  };
  const NODE_COLOR = (node) => {
    if (node.is_root) return "#4a8fd4";
    if (node.retained_size_bytes > 1_000_000) return "#e08c30";
    return "#666";
  };

  let positions = {};
  let velocities = {};

  function initPositions(nodes) {
    const cx = WIDTH() / 2;
    const cy = HEIGHT() / 2;
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * 2 * Math.PI;
      const r = 150;
      positions[n.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
      velocities[n.id] = { vx: 0, vy: 0 };
    });
  }

  let animId = null;
  let iteration = 0;

  function simulate() {
    const REPULSION = 1200;
    const SPRING = 0.05;
    const SPRING_LEN = 120;
    const DAMPING = 0.8;
    const MAX_ITER = 300;

    if (iteration >= MAX_ITER) { render(); return; }
    iteration++;

    const nodeIds = visibleNodes.map(n => n.id);
    const idSet = new Set(nodeIds);

    // Repulsion between all node pairs.
    for (let i = 0; i < visibleNodes.length; i++) {
      for (let j = i + 1; j < visibleNodes.length; j++) {
        const a = visibleNodes[i], b = visibleNodes[j];
        const pa = positions[a.id], pb = positions[b.id];
        if (!pa || !pb) continue;
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        velocities[a.id].vx -= fx; velocities[a.id].vy -= fy;
        velocities[b.id].vx += fx; velocities[b.id].vy += fy;
      }
    }

    // Spring force along edges.
    visibleEdges.forEach(e => {
      if (!idSet.has(e.from) || !idSet.has(e.to)) return;
      const pa = positions[e.from], pb = positions[e.to];
      if (!pa || !pb) return;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const stretch = dist - SPRING_LEN;
      const fx = (dx / dist) * stretch * SPRING;
      const fy = (dy / dist) * stretch * SPRING;
      velocities[e.from].vx += fx; velocities[e.from].vy += fy;
      velocities[e.to].vx -= fx; velocities[e.to].vy -= fy;
    });

    // Gravity toward center.
    const cx = WIDTH() / 2, cy = HEIGHT() / 2;
    visibleNodes.forEach(n => {
      const p = positions[n.id];
      if (!p) return;
      velocities[n.id].vx += (cx - p.x) * 0.003;
      velocities[n.id].vy += (cy - p.y) * 0.003;
    });

    // Integrate.
    visibleNodes.forEach(n => {
      const p = positions[n.id], v = velocities[n.id];
      if (!p || !v) return;
      v.vx *= DAMPING; v.vy *= DAMPING;
      p.x += v.vx; p.y += v.vy;
      p.x = Math.max(20, Math.min(WIDTH() - 20, p.x));
      p.y = Math.max(20, Math.min(HEIGHT() - 20, p.y));
    });

    render();
    animId = requestAnimationFrame(simulate);
  }

  function render() {
    const idSet = new Set(visibleNodes.map(n => n.id));

    // Build SVG content as a string.
    let lines = [
      '<defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">',
      '<path d="M0,0 L0,6 L6,3 z" fill="#555"/>',
      '</marker></defs>',
      '<g id="edges">',
    ];

    visibleEdges.forEach(e => {
      if (!idSet.has(e.from) || !idSet.has(e.to)) return;
      const pa = positions[e.from], pb = positions[e.to];
      if (!pa || !pb) return;
      const cls = e.reference_kind === "Strong" ? "strong" : "weak";
      lines.push(
        \`<line class="link \${cls}" x1="\${pa.x.toFixed(1)}" y1="\${pa.y.toFixed(1)}" \` +
        \`x2="\${pb.x.toFixed(1)}" y2="\${pb.y.toFixed(1)}" marker-end="url(#arrow)"/>\`
      );
    });

    lines.push('</g><g id="nodes">');

    visibleNodes.forEach(n => {
      const p = positions[n.id];
      if (!p) return;
      const r = NODE_RADIUS(n);
      const col = NODE_COLOR(n);
      const rootClass = n.is_root ? " root" : "";
      const strokeCol = n.is_root ? "#4a8fd4" : col;
      lines.push(
        \`<g class="node" data-id="\${n.id}">\` +
        \`<circle cx="\${p.x.toFixed(1)}" cy="\${p.y.toFixed(1)}" r="\${r}" \` +
        \`fill="\${col}" fill-opacity="0.7" stroke="\${strokeCol}" class="\${rootClass}"/>\` +
        \`<text x="\${p.x.toFixed(1)}" y="\${(p.y + r + 10).toFixed(1)}" style="font-size:9px">\` +
        escHtml(n.display_name.substring(0, 16)) +
        \`</text></g>\`
      );
    });

    lines.push('</g>');
    svg.innerHTML = lines.join("\\n");

    // Re-attach event listeners.
    svg.querySelectorAll(".node").forEach(el => {
      el.addEventListener("mouseenter", onNodeHover);
      el.addEventListener("mouseleave", onNodeLeave);
    });
  }

  function escHtml(s) {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function onNodeHover(evt) {
    const id = evt.currentTarget.dataset.id;
    const node = allNodes.find(n => n.id === id);
    if (!node) return;
    tooltip.style.display = "block";
    tooltip.innerHTML =
      \`<div class="name">\${escHtml(node.type_name)}</div>\` +
      \`<div>Address: <code>\${escHtml(node.id)}</code></div>\` +
      \`<div>Size: \${formatBytes(node.size_bytes)}</div>\` +
      \`<div>Retained: \${formatBytes(node.retained_size_bytes)}</div>\` +
      \`<div>Instances: \${node.instance_count}</div>\` +
      \`<div>Depth: \${node.depth}</div>\` +
      (node.is_root ? \`<div>GC Root: \${escHtml(node.root_kind || "unknown")}</div>\` : "");
    positionTooltip(evt);
  }

  function onNodeLeave() {
    tooltip.style.display = "none";
  }

  function positionTooltip(evt) {
    const rect = svg.getBoundingClientRect();
    let x = evt.clientX - rect.left + 12;
    let y = evt.clientY - rect.top + 12;
    if (x + 330 > WIDTH()) x -= 340;
    if (y + 160 > HEIGHT()) y -= 170;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }

  function formatBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  function applyFilter(text) {
    if (animId !== null) { cancelAnimationFrame(animId); animId = null; }
    const lower = text.toLowerCase().trim();
    if (lower === "") {
      visibleNodes = allNodes.slice();
      visibleEdges = allEdges.slice();
    } else {
      const matchedIds = new Set(allNodes.filter(n => n.type_name.toLowerCase().includes(lower)).map(n => n.id));
      visibleNodes = allNodes.filter(n => matchedIds.has(n.id));
      visibleEdges = allEdges.filter(e => matchedIds.has(e.from) && matchedIds.has(e.to));
    }
    render();
  }

  filterInput.addEventListener("input", () => applyFilter(filterInput.value));

  // Depth slider: hide nodes deeper than the selected depth.
  const depthSlider = document.getElementById("depth-slider");
  const depthValue = document.getElementById("depth-value");
  if (depthSlider && depthValue) {
    depthSlider.addEventListener("input", function() {
      const maxD = parseInt(this.value, 10);
      depthValue.textContent = String(maxD);
      if (animId !== null) { cancelAnimationFrame(animId); animId = null; }
      const lower = filterInput.value.toLowerCase().trim();
      const filtered = allNodes.filter(n => n.depth <= maxD);
      const filteredIds = new Set(filtered.map(n => n.id));
      if (lower !== "") {
        visibleNodes = filtered.filter(n => n.type_name.toLowerCase().includes(lower));
      } else {
        visibleNodes = filtered;
      }
      const visIds = new Set(visibleNodes.map(n => n.id));
      visibleEdges = allEdges.filter(e => visIds.has(e.from) && visIds.has(e.to) && filteredIds.has(e.from) && filteredIds.has(e.to));
      render();
    });
  }

  // Export SVG button.
  const exportBtn = document.getElementById("export-svg-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", function() {
      const svgEl = document.getElementById("graph-svg");
      if (!svgEl) return;
      const svgClone = svgEl.cloneNode(true);
      svgClone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svgClone.setAttribute("width", String(WIDTH()));
      svgClone.setAttribute("height", String(HEIGHT()));
      const blob = new Blob([new XMLSerializer().serializeToString(svgClone)], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "object-graph.svg";
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  // Start simulation.
  initPositions(visibleNodes);
  simulate();
})();
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
