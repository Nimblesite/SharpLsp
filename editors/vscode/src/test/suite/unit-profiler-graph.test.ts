// Pure-logic tests for the object retention graph webview (profiler-graph.ts).
//
// The HTML-building logic lives in the module-private `renderGraphSummary`
// function. It is reachable only through `ObjectGraphPanel.open()`, which:
//   1. constructs a real webview panel (works in the extension host),
//   2. calls `client.sendRequest('sharplsp/profiler/getObjectGraph', …)`,
//   3. on success sets `webview.html = renderGraphSummary(result, root)`,
//   4. on failure sets `webview.html = "…Error: <message>…"`.
//
// We drive `open()` with a FAKE LanguageClient (no LSP server required) and a
// FAKE ExtensionContext, then capture the created `WebviewPanel` by spying on
// `vscode.window.createWebviewPanel` so we can read back the rendered HTML.
// These tests pin EXACTLY what the renderer emits — including the fact that it
// performs NO HTML-escaping — so they assert real behavior, not guesses.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { ObjectGraphPanel } from '../../profiler-graph.js';

// ── Test data shapes (mirror the private interfaces in profiler-graph.ts) ──

interface TestNode {
  id: string;
  type_name: string;
  display_name: string;
  size_bytes: number;
  retained_size_bytes: number;
  instance_count: number;
  is_root: boolean;
  root_kind?: string;
  depth: number;
}

interface TestEdge {
  from: string;
  to: string;
  field_name: string;
  reference_kind: 'Strong' | 'Weak';
}

interface TestStats {
  total_nodes_traversed: number;
  total_edges_traversed: number;
  max_depth_reached: number;
  truncated: boolean;
}

interface TestGraph {
  nodes: TestNode[];
  edges: TestEdge[];
  stats: TestStats;
}

// ── Fakes ──────────────────────────────────────────────────────────

function makeNode(overrides: Partial<TestNode>): TestNode {
  return {
    id: '0x1',
    type_name: 'System.Object',
    display_name: 'obj',
    size_bytes: 24,
    retained_size_bytes: 24,
    instance_count: 1,
    is_root: false,
    depth: 0,
    ...overrides,
  };
}

function makeStats(overrides: Partial<TestStats>): TestStats {
  return {
    total_nodes_traversed: 0,
    total_edges_traversed: 0,
    max_depth_reached: 0,
    truncated: false,
    ...overrides,
  };
}

function makeGraph(overrides: Partial<TestGraph>): TestGraph {
  return {
    nodes: [],
    edges: [],
    stats: makeStats({}),
    ...overrides,
  };
}

/** A LanguageClient stub whose sendRequest resolves with the given graph. */
function resolvingClient(graph: TestGraph): LanguageClient {
  return {
    sendRequest: async (_method: string, _payload: unknown): Promise<unknown> => graph,
  } as unknown as LanguageClient;
}

/** A LanguageClient stub whose sendRequest rejects with the given error. */
function rejectingClient(error: unknown): LanguageClient {
  return {
    sendRequest: async (_method: string, _payload: unknown): Promise<unknown> => {
      throw error;
    },
  } as unknown as LanguageClient;
}

/** A minimal ExtensionContext with a disposable subscriptions array. */
function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

/**
 * Drive `ObjectGraphPanel.open()` and return the HTML the panel ended up with.
 *
 * We spy on `vscode.window.createWebviewPanel` so we can capture the real
 * panel the SUT creates, read its final `webview.html`, and dispose it. The
 * original factory is always restored.
 */
async function renderViaPanel(
  client: LanguageClient,
  dumpPath: string,
  rootAddress: string,
): Promise<string> {
  const original = vscode.window.createWebviewPanel;
  const created: vscode.WebviewPanel[] = [];
  (vscode.window as any).createWebviewPanel = (...args: any[]): vscode.WebviewPanel => {
    const panel = (original as any).apply(vscode.window, args) as vscode.WebviewPanel;
    created.push(panel);
    return panel;
  };

  try {
    await ObjectGraphPanel.open(dumpPath, rootAddress, fakeContext(), client);
    assert.strictEqual(created.length, 1, 'open() must create exactly one webview panel');
    const html = created[0]!.webview.html;
    return html;
  } finally {
    for (const panel of created) {
      try {
        panel.dispose();
      } catch {
        // best-effort cleanup
      }
    }
    (vscode.window as any).createWebviewPanel = original;
  }
}

// ════════════════════════════════════════════════════════════════════
suite('ObjectGraphPanel — successful render (renderGraphSummary)', () => {
  test('renders the document skeleton, root address, and stats line', async () => {
    const graph = makeGraph({
      nodes: [makeNode({ display_name: 'root', type_name: 'My.Type', depth: 0 })],
      stats: makeStats({
        total_nodes_traversed: 1,
        total_edges_traversed: 0,
        max_depth_reached: 0,
        truncated: false,
      }),
    });

    const html = await renderViaPanel(resolvingClient(graph), '/tmp/a.dmp', '00007ff8DEAD');

    assert.ok(html.startsWith('<!DOCTYPE html>'), 'must start with the doctype');
    assert.ok(html.includes('<html>'), 'must open <html>');
    assert.ok(html.includes('<body>'), 'must open <body>');
    assert.ok(html.includes('<pre>'), 'summary is wrapped in a <pre>');
    assert.ok(html.includes('</pre></body></html>'), 'must close pre/body/html');
    assert.ok(html.includes('Root: 00007ff8DEAD'), 'must echo the root address');
    assert.ok(
      html.includes('Nodes: 1, Edges: 0, Max depth: 0'),
      'stats line must render counts from stats, not from the node array',
    );
    // The node line text.
    assert.ok(html.includes('root (My.Type) depth=0'), 'node line must render display/type/depth');
  });

  test('stats numbers come from stats, decoupled from node-array length', async () => {
    // Only one node object, but stats claim a much larger traversal — the
    // renderer must print the STATS numbers verbatim.
    const graph = makeGraph({
      nodes: [makeNode({ display_name: 'sample', type_name: 'T', depth: 3 })],
      stats: makeStats({
        total_nodes_traversed: 4096,
        total_edges_traversed: 8191,
        max_depth_reached: 17,
      }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(html.includes('Nodes: 4096, Edges: 8191, Max depth: 17'));
    assert.ok(!html.includes('Nodes: 1,'), 'must not derive node count from array length');
    assert.ok(html.includes('sample (T) depth=3'));
  });

  test('renders every node on its own line in array order', async () => {
    const graph = makeGraph({
      nodes: [
        makeNode({ display_name: 'first', type_name: 'A', depth: 0 }),
        makeNode({ display_name: 'second', type_name: 'B', depth: 1 }),
        makeNode({ display_name: 'third', type_name: 'C', depth: 2 }),
      ],
      stats: makeStats({ total_nodes_traversed: 3, max_depth_reached: 2 }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(html.includes('first (A) depth=0'));
    assert.ok(html.includes('second (B) depth=1'));
    assert.ok(html.includes('third (C) depth=2'));

    // Order is preserved: first appears before second appears before third.
    const idxFirst = html.indexOf('first (A)');
    const idxSecond = html.indexOf('second (B)');
    const idxThird = html.indexOf('third (C)');
    assert.ok(idxFirst >= 0 && idxSecond >= 0 && idxThird >= 0);
    assert.ok(idxFirst < idxSecond, 'first must precede second');
    assert.ok(idxSecond < idxThird, 'second must precede third');

    // Each node is on its own line (joined with '\n').
    assert.ok(
      html.includes('first (A) depth=0\nsecond (B) depth=1\nthird (C) depth=2'),
      'nodes must be newline-joined in order',
    );
  });

  test('empty graph renders the skeleton with zeroed stats and no node lines', async () => {
    const graph = makeGraph({
      nodes: [],
      edges: [],
      stats: makeStats({}),
    });

    const html = await renderViaPanel(resolvingClient(graph), '/tmp/empty.dmp', 'ROOTADDR');

    assert.ok(html.includes('Root: ROOTADDR'));
    assert.ok(html.includes('Nodes: 0, Edges: 0, Max depth: 0'));
    assert.ok(html.includes('<pre>'));
    assert.ok(html.includes('</pre></body></html>'));
    assert.ok(!html.includes('depth='), 'empty node list must produce no "depth=" lines');
  });
});

// ════════════════════════════════════════════════════════════════════
suite('ObjectGraphPanel — truncation warning branch', () => {
  test('truncated=true emits the WARNING line', async () => {
    const graph = makeGraph({
      nodes: [makeNode({ display_name: 'x', type_name: 'T', depth: 0 })],
      stats: makeStats({
        total_nodes_traversed: 99999,
        total_edges_traversed: 99999,
        max_depth_reached: 64,
        truncated: true,
      }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(html.includes('WARNING: graph truncated'), 'truncated branch must warn');
    assert.ok(html.includes('Nodes: 99999, Edges: 99999, Max depth: 64'));
  });

  test('truncated=false omits the WARNING line entirely', async () => {
    const graph = makeGraph({
      nodes: [makeNode({ display_name: 'x', type_name: 'T', depth: 0 })],
      stats: makeStats({ truncated: false, total_nodes_traversed: 1 }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(
      !html.includes('WARNING'),
      'non-truncated graphs must not include any WARNING text',
    );
    assert.ok(!html.includes('graph truncated'));
  });
});

// ════════════════════════════════════════════════════════════════════
suite('ObjectGraphPanel — no HTML escaping (documents real behavior)', () => {
  test('angle brackets in type names pass through verbatim (NOT escaped)', async () => {
    // The renderer does no escaping — generic type names with <…> appear raw.
    const graph = makeGraph({
      nodes: [
        makeNode({
          display_name: 'list',
          type_name: 'System.Collections.Generic.List<System.String>',
          depth: 0,
        }),
      ],
      stats: makeStats({ total_nodes_traversed: 1 }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(
      html.includes('list (System.Collections.Generic.List<System.String>) depth=0'),
      'generic type name must appear with raw angle brackets',
    );
    assert.ok(
      !html.includes('&lt;System.String&gt;'),
      'renderer does NOT HTML-escape angle brackets',
    );
  });

  test('ampersands and quotes in names pass through verbatim', async () => {
    const graph = makeGraph({
      nodes: [
        makeNode({
          display_name: 'Tom & "Jerry"',
          type_name: 'Cartoon&Co',
          depth: 0,
        }),
      ],
      stats: makeStats({ total_nodes_traversed: 1 }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(html.includes('Tom & "Jerry" (Cartoon&Co) depth=0'));
    assert.ok(!html.includes('&amp;'), 'ampersands are not escaped');
    assert.ok(!html.includes('&quot;'), 'quotes are not escaped');
  });

  test('root address is echoed verbatim into the body', async () => {
    const graph = makeGraph({ stats: makeStats({}) });
    const html = await renderViaPanel(
      resolvingClient(graph),
      '/tmp/d.dmp',
      '0xCAFEBABE<script>',
    );
    assert.ok(html.includes('Root: 0xCAFEBABE<script>'), 'root echoed raw');
    assert.ok(!html.includes('&lt;script&gt;'), 'root not escaped (documents behavior)');
  });
});

// ════════════════════════════════════════════════════════════════════
suite('ObjectGraphPanel — numeric / depth boundary formatting', () => {
  test('depth and stats boundary numbers (0, 1, 1023, 1024) render exactly', async () => {
    const graph = makeGraph({
      nodes: [
        makeNode({ display_name: 'd0', type_name: 'T', depth: 0 }),
        makeNode({ display_name: 'd1', type_name: 'T', depth: 1 }),
        makeNode({ display_name: 'd1023', type_name: 'T', depth: 1023 }),
        makeNode({ display_name: 'd1024', type_name: 'T', depth: 1024 }),
      ],
      stats: makeStats({
        total_nodes_traversed: 1024,
        total_edges_traversed: 1023,
        max_depth_reached: 1024,
      }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(html.includes('d0 (T) depth=0'));
    assert.ok(html.includes('d1 (T) depth=1'));
    assert.ok(html.includes('d1023 (T) depth=1023'));
    assert.ok(html.includes('d1024 (T) depth=1024'));
    assert.ok(html.includes('Nodes: 1024, Edges: 1023, Max depth: 1024'));
  });

  test('negative depth values stringify with the minus sign', async () => {
    const graph = makeGraph({
      nodes: [makeNode({ display_name: 'neg', type_name: 'T', depth: -1 })],
      stats: makeStats({ total_nodes_traversed: 1, max_depth_reached: -1 }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(html.includes('neg (T) depth=-1'), 'negative depth keeps the sign');
    assert.ok(html.includes('Max depth: -1'));
  });

  test('huge stats numbers render without separators', async () => {
    const huge = 1234567890;
    const graph = makeGraph({
      stats: makeStats({
        total_nodes_traversed: huge,
        total_edges_traversed: huge,
        max_depth_reached: huge,
      }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(
      html.includes('Nodes: 1234567890, Edges: 1234567890, Max depth: 1234567890'),
      'large integers render as plain decimal strings',
    );
    assert.ok(!html.includes('1,234,567,890'), 'no thousands separators are added');
  });
});

// ════════════════════════════════════════════════════════════════════
suite('ObjectGraphPanel — large graph stress', () => {
  test('renders 500 nodes, all present and stats consistent', async () => {
    const count = 500;
    const nodes: TestNode[] = [];
    for (let i = 0; i < count; i++) {
      nodes.push(
        makeNode({
          id: `0x${i.toString(16)}`,
          display_name: `node${i.toString()}`,
          type_name: `Type${(i % 7).toString()}`,
          depth: i % 32,
        }),
      );
    }
    const graph = makeGraph({
      nodes,
      stats: makeStats({
        total_nodes_traversed: count,
        total_edges_traversed: count - 1,
        max_depth_reached: 31,
      }),
    });

    const html = await renderViaPanel(resolvingClient(graph), 'd', 'r');

    assert.ok(html.includes('node0 (Type0) depth=0'), 'first node present');
    // i=499: 499 % 7 = 2 → Type2 ; 499 % 32 = 19 → depth=19.
    assert.ok(html.includes('node499 (Type2) depth=19'), 'last node present');
    assert.ok(html.includes(`Nodes: ${count.toString()}, Edges: ${(count - 1).toString()}`));
    // One newline per node within the node list block.
    const nodeLineCount = (html.match(/depth=/g) ?? []).length;
    assert.strictEqual(nodeLineCount, count, 'one node line per node');
  });
});

// ════════════════════════════════════════════════════════════════════
suite('ObjectGraphPanel — error path', () => {
  test('sendRequest rejecting with an Error renders the message', async () => {
    const html = await renderViaPanel(
      rejectingClient(new Error('sidecar exploded')),
      '/tmp/x.dmp',
      'addr',
    );

    assert.ok(html.startsWith('<!DOCTYPE html>'), 'error page is a full document');
    assert.ok(html.includes('Error: sidecar exploded'), 'error message surfaced via getErrorMessage');
    assert.ok(!html.includes('<pre>'), 'error page does not use the summary <pre> layout');
    assert.ok(!html.includes('Nodes:'), 'error page does not render a stats line');
  });

  test('sendRequest rejecting with a non-Error stringifies it', async () => {
    const html = await renderViaPanel(rejectingClient('plain string failure'), 'd', 'r');
    assert.ok(
      html.includes('Error: plain string failure'),
      'non-Error rejection is coerced via String()',
    );
  });

  test('error page still emits a valid html/body wrapper', async () => {
    const html = await renderViaPanel(rejectingClient(new Error('boom')), 'd', 'r');
    assert.ok(html.includes('<html>'));
    assert.ok(html.includes('<body>'));
    assert.ok(html.includes('</body></html>'));
  });
});

// ════════════════════════════════════════════════════════════════════
suite('ObjectGraphPanel — webview construction', () => {
  test('open() titles the panel with the root address', async () => {
    const original = vscode.window.createWebviewPanel;
    const titles: string[] = [];
    const created: vscode.WebviewPanel[] = [];
    (vscode.window as any).createWebviewPanel = (...args: any[]): vscode.WebviewPanel => {
      // Signature: (viewType, title, showOptions, options)
      titles.push(String(args[1]));
      const panel = (original as any).apply(vscode.window, args) as vscode.WebviewPanel;
      created.push(panel);
      return panel;
    };

    try {
      await ObjectGraphPanel.open('/tmp/d.dmp', '00007ffTITLE', fakeContext(), resolvingClient(makeGraph({})));
      assert.ok(
        titles.some((t) => t.includes('Object Graph: 00007ffTITLE')),
        'panel title must embed the root address',
      );
    } finally {
      for (const panel of created) {
        try {
          panel.dispose();
        } catch {
          // ignore
        }
      }
      (vscode.window as any).createWebviewPanel = original;
    }
  });

  test('two opens create two distinct panels', async () => {
    const original = vscode.window.createWebviewPanel;
    const created: vscode.WebviewPanel[] = [];
    (vscode.window as any).createWebviewPanel = (...args: any[]): vscode.WebviewPanel => {
      const panel = (original as any).apply(vscode.window, args) as vscode.WebviewPanel;
      created.push(panel);
      return panel;
    };

    try {
      const client = resolvingClient(makeGraph({ stats: makeStats({ total_nodes_traversed: 2 }) }));
      await ObjectGraphPanel.open('/tmp/a.dmp', 'rootA', fakeContext(), client);
      await ObjectGraphPanel.open('/tmp/b.dmp', 'rootB', fakeContext(), client);

      assert.strictEqual(created.length, 2, 'each open() creates its own panel');
      assert.notStrictEqual(created[0], created[1], 'panels are distinct instances');
      assert.ok(created[0]!.webview.html.includes('Root: rootA'));
      assert.ok(created[1]!.webview.html.includes('Root: rootB'));
    } finally {
      for (const panel of created) {
        try {
          panel.dispose();
        } catch {
          // ignore
        }
      }
      (vscode.window as any).createWebviewPanel = original;
    }
  });

  test('module exports the ObjectGraphPanel class', () => {
    assert.strictEqual(typeof ObjectGraphPanel, 'function', 'ObjectGraphPanel must be a class');
    assert.strictEqual(typeof ObjectGraphPanel.open, 'function', 'static open() must exist');
  });
});
