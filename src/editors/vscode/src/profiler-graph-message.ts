// Implements [PROFILER-GRAPH-WEBVIEW-FEATURES]: validate both graph message boundaries.
import type { HeapDiffResult, HeapTypeDiff, LeakSuspect } from './profiler-diff.js';
import type {
  ObjectGraphEdge,
  ObjectGraphNode,
  ObjectGraphResult,
  ObjectGraphStats,
} from './profiler-graph-types.js';

export interface GraphMessage {
  root?: string;
  result?: ObjectGraphResult;
  comparison?: Pick<HeapDiffResult, 'diffs' | 'leak_suspects'>;
  error?: string;
}

function fields(value: object, kind: 'string' | 'number', names: readonly string[]): boolean {
  return names.every((name) => {
    const field: unknown = Reflect.get(value, name);
    return typeof field === kind && (typeof field !== 'number' || Number.isFinite(field));
  });
}

function graphNode(value: unknown): value is ObjectGraphNode {
  return (
    value instanceof Object &&
    fields(value, 'string', ['id', 'type_name', 'display_name']) &&
    fields(value, 'number', ['size_bytes', 'retained_size_bytes', 'instance_count', 'depth']) &&
    'is_root' in value &&
    typeof value.is_root === 'boolean' &&
    (!('root_kind' in value) ||
      value.root_kind === undefined ||
      typeof value.root_kind === 'string')
  );
}

function graphEdge(value: unknown): value is ObjectGraphEdge {
  return (
    value instanceof Object &&
    fields(value, 'string', ['from', 'to', 'field_name']) &&
    'reference_kind' in value &&
    (value.reference_kind === 'Strong' || value.reference_kind === 'Weak')
  );
}

function graphStats(value: unknown): value is ObjectGraphStats {
  return (
    value instanceof Object &&
    fields(value, 'number', [
      'total_nodes_traversed',
      'total_edges_traversed',
      'max_depth_reached',
    ]) &&
    'truncated' in value &&
    typeof value.truncated === 'boolean'
  );
}

function graphResult(value: unknown): value is ObjectGraphResult {
  return (
    value instanceof Object &&
    'nodes' in value &&
    Array.isArray(value.nodes) &&
    value.nodes.every(graphNode) &&
    'edges' in value &&
    Array.isArray(value.edges) &&
    value.edges.every(graphEdge) &&
    'stats' in value &&
    graphStats(value.stats)
  );
}

function heapDiff(value: unknown): value is HeapTypeDiff {
  return (
    value instanceof Object &&
    fields(value, 'string', ['type_name']) &&
    fields(value, 'number', [
      'baseline_count',
      'comparison_count',
      'count_delta',
      'baseline_size_bytes',
      'comparison_size_bytes',
      'size_delta_bytes',
      'growth_percent',
    ])
  );
}

function leakSuspect(value: unknown): value is LeakSuspect {
  return (
    value instanceof Object &&
    fields(value, 'string', ['type_name', 'reason']) &&
    fields(value, 'number', ['count_delta', 'size_delta_bytes']) &&
    'severity' in value &&
    (value.severity === 'high' || value.severity === 'medium' || value.severity === 'low')
  );
}

function comparison(value: unknown): value is GraphMessage['comparison'] {
  return (
    value instanceof Object &&
    'diffs' in value &&
    Array.isArray(value.diffs) &&
    value.diffs.every(heapDiff) &&
    'leak_suspects' in value &&
    Array.isArray(value.leak_suspects) &&
    value.leak_suspects.every(leakSuspect)
  );
}

function graphMessage(value: unknown): value is GraphMessage {
  return (
    value instanceof Object &&
    (!('root' in value) || value.root === undefined || typeof value.root === 'string') &&
    (!('error' in value) || value.error === undefined || typeof value.error === 'string') &&
    (!('result' in value) || value.result === undefined || graphResult(value.result)) &&
    (!('comparison' in value) || value.comparison === undefined || comparison(value.comparison))
  );
}

export function readGraphMessage(value: unknown): GraphMessage {
  return graphMessage(value) ? value : { error: 'Invalid graph data received' };
}

export function parseGraphMessage(source: string): GraphMessage {
  try {
    const value: unknown = JSON.parse(source);
    return readGraphMessage(value);
  } catch {
    return { error: 'Invalid graph data received' };
  }
}
