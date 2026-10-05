/// <reference lib="dom" />
// Implements [PROFILER-GRAPH-WEBVIEW-FEATURES] and [PROFILER-GRAPH-RETENTION].
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { Signal, effect } from './signals.js';
import {
  graphSummary,
  type ObjectGraphNode,
  type ObjectGraphResult,
} from './profiler-graph-types.js';
import { parseGraphMessage, readGraphMessage } from './profiler-graph-message.js';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
type GraphNode = ObjectGraphNode & SimulationNodeDatum;
type Link = SimulationLinkDatum<GraphNode> & { label: string; weak: boolean; highlighted: boolean };
const api = acquireVsCodeApi();
const initial = parseGraphMessage(document.getElementById('graph-data')?.textContent ?? '{}');
const graph = new Signal(
  initial.result ?? {
    nodes: [],
    edges: [],
    stats: {
      total_nodes_traversed: 0,
      total_edges_traversed: 0,
      max_depth_reached: 0,
      truncated: false,
    },
  },
);
const comparison = new Signal(initial.comparison);
const filter = new Signal('');
const search = new Signal('');
const selected = new Signal('');
const collapsed = new Signal<ReadonlySet<string>>(new Set());
const status = new Signal(initial.error ?? '');
const svg = document.querySelector<SVGSVGElement>('#graph');
let stopSimulation: (() => void) | undefined;

function element<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function hiddenNodes(data: ObjectGraphResult): Set<string> {
  const hidden = new Set<string>();
  const visited = new Set<string>();
  const depths = new Map(data.nodes.map((node) => [node.id, node.depth]));
  const pending = [...collapsed.value];
  while (pending.length > 0) {
    const id = pending.shift();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    for (const edge of data.edges.filter(
      (candidate) =>
        candidate.from === id && (depths.get(candidate.to) ?? 0) > (depths.get(id) ?? 0),
    )) {
      hidden.add(edge.to);
      pending.push(edge.to);
    }
  }
  return hidden;
}

function rootPath(data: ObjectGraphResult): ReadonlySet<string> {
  const queue = [[selected.value]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift();
    const id = path?.[0];
    if (path === undefined || id === undefined || visited.has(id)) continue;
    if (data.nodes.some((node) => node.id === id && node.is_root)) return new Set(path);
    visited.add(id);
    for (const edge of data.edges.filter((candidate) => candidate.to === id))
      queue.push([edge.from, ...path]);
  }
  return new Set();
}

function visibleNodes(data: ObjectGraphResult): GraphNode[] {
  const hidden = hiddenNodes(data);
  return data.nodes
    .filter(
      (node) =>
        !hidden.has(node.id) &&
        node.type_name.toLowerCase().includes(filter.value.toLowerCase()) &&
        (node.id.toLowerCase().includes(search.value.toLowerCase()) ||
          node.type_name.toLowerCase().includes(search.value.toLowerCase())),
    )
    .map((node, index) => ({ ...node, x: 120 + node.depth * 180, y: 100 + (index % 6) * 90 }));
}

function nodeColor(node: ObjectGraphNode): string {
  const suspect = comparison.value?.leak_suspects.some(
    (candidate) => candidate.type_name === node.type_name && candidate.severity === 'high',
  );
  return suspect === true
    ? '#e5534b'
    : node.retained_size_bytes > 1_048_576
      ? '#e49b36'
      : node.is_root
        ? '#3899ec'
        : '#8a929a';
}

function nodeTitle(node: ObjectGraphNode): string {
  const delta = comparison.value?.diffs.find((diff) => diff.type_name === node.type_name);
  const growth =
    delta !== undefined
      ? `\n↑ ${String(delta.size_delta_bytes)} bytes (${String(delta.count_delta)} instances)`
      : '';
  return `${node.type_name}\nAddress: ${node.id}\nSize: ${String(node.size_bytes)} bytes\nRetained: ${String(node.retained_size_bytes)} bytes\nInstances: ${String(node.instance_count)}\n${node.root_kind ?? ''}${growth}`;
}

// [PROFILER-GRAPH-DIFF-OVERLAY] Preserve the snapshot comparison on lazy expansion.
function nodeCircle(
  node: ObjectGraphNode,
  radius: number,
  path: ReadonlySet<string>,
): SVGCircleElement {
  const delta = comparison.value?.diffs.find((diff) => diff.type_name === node.type_name);
  const growing = delta !== undefined && delta.count_delta > 0;
  const pulse =
    delta !== undefined && delta.baseline_count > 0 && delta.count_delta > delta.baseline_count;
  const circle = element('circle', {
    r: String(radius),
    fill: nodeColor(node),
    stroke: pulse ? '#e5534b' : growing ? '#e49b36' : path.has(node.id) ? '#f5d76e' : '#ddd',
    'stroke-width': growing || path.has(node.id) ? '4' : '1',
    'stroke-dasharray': delta?.baseline_count === 0 ? '5 3' : '',
  });
  if (pulse)
    circle.append(
      element('animate', {
        attributeName: 'stroke-opacity',
        values: '1;0.3;1',
        dur: '1.5s',
        repeatCount: 'indefinite',
      }),
    );
  return circle;
}

function expand(node: ObjectGraphNode): void {
  selected.value = node.id;
  status.value = 'Loading object references…';
  api.postMessage({ command: 'expand', address: node.id, depth: depth() });
}

function nodeView(node: GraphNode, path: ReadonlySet<string>): SVGGElement {
  const group = element('g', {
    class: 'node',
    'data-id': node.id,
    tabindex: '0',
    role: 'button',
    'aria-label': node.type_name,
  });
  const radius = Math.max(9, Math.min(48, Math.sqrt(node.retained_size_bytes) / 80));
  group.append(nodeCircle(node, radius, path));
  const title = element('title', {});
  title.textContent = nodeTitle(node);
  group.append(title);
  const label = element('text', {
    x: String(radius + 5),
    y: '4',
    fill: 'currentColor',
    'font-size': '12',
  });
  label.textContent = node.display_name;
  group.append(label);
  wireNode(group, node);
  return group;
}

function wireNode(group: SVGGElement, node: GraphNode): void {
  let click: ReturnType<typeof setTimeout> | undefined;
  group.addEventListener('click', () => {
    clearTimeout(click);
    click = setTimeout(() => {
      expand(node);
    }, 200);
  });
  group.addEventListener('dblclick', () => {
    clearTimeout(click);
    const next = new Set(collapsed.value);
    if (next.has(node.id)) next.delete(node.id);
    else next.add(node.id);
    collapsed.value = next;
  });
  group.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.postMessage({ command: 'inspect', address: node.id });
  });
  group.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') expand(node);
  });
}

function edgeView(link: Link): SVGGElement {
  const group = element('g', { class: 'edge' });
  group.append(
    element('line', {
      stroke: link.highlighted ? '#f5d76e' : '#777',
      'stroke-width': link.highlighted ? '3' : '1',
      'stroke-dasharray': link.weak ? '4 4' : '',
      'marker-end': 'url(#arrow)',
    }),
  );
  const label = element('text', { fill: 'currentColor' });
  label.textContent = link.label;
  group.append(label);
  return group;
}

function positionEdge(view: SVGGElement, link: Link): void {
  if (typeof link.source !== 'object' || typeof link.target !== 'object') return;
  const { x: x1 = 0, y: y1 = 0 } = link.source;
  const { x: x2 = 0, y: y2 = 0 } = link.target;
  for (const [key, value] of Object.entries({ x1, y1, x2, y2 }))
    view.firstElementChild?.setAttribute(key, String(value));
  view.lastElementChild?.setAttribute('x', String((x1 + x2) / 2));
  view.lastElementChild?.setAttribute('y', String((y1 + y2) / 2 - 5));
}

function linksFor(data: ObjectGraphResult, nodes: GraphNode[], path: ReadonlySet<string>): Link[] {
  const ids = new Set(nodes.map((node) => node.id));
  return data.edges
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    .map((edge) => ({
      source: edge.from,
      target: edge.to,
      label: edge.field_name,
      weak: edge.reference_kind === 'Weak',
      highlighted: path.has(edge.from) && path.has(edge.to),
    }));
}

function arrowDefinition(): SVGDefsElement {
  const defs = element('defs', {});
  const marker = element('marker', {
    id: 'arrow',
    viewBox: '0 0 10 10',
    refX: '20',
    refY: '5',
    markerWidth: '7',
    markerHeight: '7',
    orient: 'auto-start-reverse',
  });
  marker.append(element('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#aaa' }));
  defs.append(marker);
  return defs;
}

function render(): void {
  if (svg === null) return;
  const summary = document.getElementById('graph-summary');
  if (summary !== null) summary.textContent = graphSummary(graph.value, initial.root ?? '');
  stopSimulation?.();
  const data = graph.value,
    nodes = visibleNodes(data),
    path = rootPath(data);
  const links = linksFor(data, nodes, path);
  const edges = links.map(edgeView),
    views = nodes.map((node) => nodeView(node, path));
  svg.replaceChildren(arrowDefinition(), ...edges, ...views);
  const simulation = forceSimulation(nodes)
    .force('charge', forceManyBody().strength(-260))
    .force(
      'links',
      forceLink<GraphNode, Link>(links)
        .id((node) => node.id)
        .distance(150),
    )
    .force('x', forceX<GraphNode>((node) => 150 + Math.min(node.depth, 5) * 150).strength(0.2))
    .force('y', forceY(350).strength(0.05));
  simulation.on('tick', () => {
    nodes.forEach((node, index) =>
      views[index]?.setAttribute(
        'transform',
        `translate(${String(node.x ?? 0)},${String(node.y ?? 0)})`,
      ),
    );
    links.forEach((link, index) => {
      const view = edges[index];
      if (view !== undefined) positionEdge(view, link);
    });
  });
  stopSimulation = (): void => {
    simulation.stop();
  };
}

function depth(): number {
  return Number(document.querySelector<HTMLInputElement>('#depth')?.value ?? 3);
}

function exportSvg(): string {
  if (svg === null) return '';
  const copy = svg.cloneNode(true);
  if (!(copy instanceof SVGSVGElement)) return '';
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', '1100');
  copy.setAttribute('height', '700');
  copy.setAttribute('color', getComputedStyle(svg).color);
  copy.prepend(
    element('rect', {
      width: '1100',
      height: '700',
      fill: getComputedStyle(document.body).backgroundColor,
    }),
  );
  return new XMLSerializer().serializeToString(copy);
}

function exportPng(): void {
  const source = URL.createObjectURL(new Blob([exportSvg()], { type: 'image/svg+xml' }));
  const image = new Image();
  image.onload = (): void => {
    const canvas = document.createElement('canvas');
    canvas.width = 1100;
    canvas.height = 700;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    api.postMessage({
      command: 'export',
      format: 'png',
      content: canvas.toDataURL('image/png').split(',')[1],
    });
    URL.revokeObjectURL(source);
  };
  image.onerror = (): void => {
    status.value = 'PNG export failed';
    URL.revokeObjectURL(source);
  };
  image.src = source;
}

function wireControls(): void {
  document.querySelector<HTMLInputElement>('#filter')?.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement) filter.value = event.target.value;
  });
  document.querySelector<HTMLInputElement>('#search')?.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement) search.value = event.target.value;
  });
  document.getElementById('depth')?.addEventListener('change', () => {
    const output = document.getElementById('depth-value');
    if (output !== null) output.textContent = String(depth());
    status.value = 'Updating traversal depth…';
    api.postMessage({ command: 'depth', depth: depth() });
  });
  document.getElementById('svg-export')?.addEventListener('click', () => {
    api.postMessage({ command: 'export', format: 'svg', content: exportSvg() });
  });
  document.getElementById('png-export')?.addEventListener('click', exportPng);
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = readGraphMessage(event.data);
    if (message.result !== undefined) graph.value = message.result;
    if (message.comparison !== undefined) comparison.value = message.comparison;
    status.value = message.error ?? '';
  });
}

wireControls();
const disposeGraph = effect(render);
const disposeStatus = effect(() => {
  const label = document.getElementById('status');
  if (label !== null) label.textContent = status.value;
});
window.addEventListener('unload', () => {
  disposeGraph();
  disposeStatus();
  stopSimulation?.();
});
