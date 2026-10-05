// Shared wire types from [PROFILER-GRAPH-DATA], moved from the panel.
export interface ObjectGraphNode {
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

export interface ObjectGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly field_name: string;
  readonly reference_kind: 'Strong' | 'Weak';
}

export interface ObjectGraphStats {
  readonly total_nodes_traversed: number;
  readonly total_edges_traversed: number;
  readonly max_depth_reached: number;
  readonly truncated: boolean;
}

export interface ObjectGraphResult {
  readonly nodes: ObjectGraphNode[];
  readonly edges: ObjectGraphEdge[];
  readonly stats: ObjectGraphStats;
}

export function graphSummary(result: ObjectGraphResult, root: string): string {
  const { stats } = result;
  return [
    `Root: ${root}`,
    `Nodes: ${String(stats.total_nodes_traversed)}, Edges: ${String(stats.total_edges_traversed)}, Max depth: ${String(stats.max_depth_reached)}`,
    stats.truncated ? 'WARNING: graph truncated' : '',
    ...result.nodes.map((n) => `${n.display_name} (${n.type_name}) depth=${String(n.depth)}`),
  ].join('\n');
}
