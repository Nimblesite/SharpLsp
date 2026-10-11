import type { ObjectGraphResult } from '../../profiler-graph-types.js';

// Shared fixture for [PROFILER-GRAPH-WEBVIEW-FEATURES].
export function graphFixture(): ObjectGraphResult {
  return {
    nodes: [
      {
        id: '0x1',
        type_name: 'My.Type',
        display_name: 'root',
        size_bytes: 24,
        retained_size_bytes: 24,
        instance_count: 1,
        is_root: true,
        depth: 0,
      },
      {
        id: '0x2',
        type_name: 'Child',
        display_name: 'leaf',
        size_bytes: 8,
        retained_size_bytes: 2_097_152,
        instance_count: 1,
        is_root: false,
        depth: 1,
      },
    ],
    edges: [{ from: '0x1', to: '0x2', field_name: '_child', reference_kind: 'Strong' }],
    stats: {
      total_nodes_traversed: 2,
      total_edges_traversed: 1,
      max_depth_reached: 1,
      truncated: true,
    },
  };
}
