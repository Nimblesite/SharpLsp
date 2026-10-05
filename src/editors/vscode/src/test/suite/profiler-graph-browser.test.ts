// Implements [PROFILER-GRAPH-WEBVIEW-FEATURES] through the bundled browser code.
import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { chromium, type Browser, type Page } from 'playwright';
import { buildGraphHtml } from '../../profiler-graph-html.js';
import { mergeGraph } from '../../profiler-graph.js';
import { joinPath } from '../../paths.js';
import { EXTENSION_ID } from './test-helpers';
import { graphFixture } from './profiler-graph-test-kit';
import { parseGraphMessage, readGraphMessage } from '../../profiler-graph-message.js';
import { COMMAND_MS } from './test-timeouts';

declare global {
  interface Window {
    graphMessages: Record<string, unknown>[];
  }
}

async function assertGraphCounts(page: Page, nodes: number, edges: number): Promise<void> {
  assert.equal(await page.locator('.node').count(), nodes);
  assert.equal(await page.locator('.edge').count(), edges);
}

async function assertGraphSearch(page: Page, query: string, address: string): Promise<void> {
  await page.getByLabel('Search address').fill(query);
  assert.equal(await page.locator('.node').count(), 1);
  assert.equal(await page.locator('.node').getAttribute('data-id'), address);
  await page.getByLabel('Search address').fill('');
}

suite('Profiler interactive retention graph', function () {
  this.timeout(COMMAND_MS);
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  setup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const script = await readFile(
      joinPath(extension.extensionPath, 'dist', 'profiler-graph-webview.js'),
      'utf8',
    );
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    errors.length = 0;
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    await page.addInitScript(() => {
      window.graphMessages = [];
      Object.assign(window, {
        acquireVsCodeApi: () => ({
          postMessage: (message: Record<string, unknown>) => {
            window.graphMessages.push(message);
          },
        }),
      });
    });
    await page.route('https://graph.test/**', async (route) => {
      const isScript = route.request().url() === 'https://graph.test/graph.js';
      await route.fulfill({
        contentType: isScript ? 'text/javascript' : 'text/html',
        body: isScript ? script : buildGraphHtml(graphFixture(), '0x1', '/graph.js', "'self'"),
      });
    });
    await page.goto('https://graph.test/');
    await page.locator('.node').first().waitFor();
  });

  teardown(async () => {
    await browser.close();
    assert.deepEqual(errors, []);
  });

  test('rejects malformed graph updates and accepts the next valid update', async () => {
    await page.evaluate(() => {
      window.postMessage({ result: { nodes: null } }, '*');
    });
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent === 'Invalid graph data received',
    );
    await assertGraphCounts(page, 2, 1);
    assert.deepEqual(errors, []);
    await page.evaluate((result) => {
      window.postMessage({ result }, '*');
    }, graphFixture());
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '');
    await assertGraphCounts(page, 2, 1);
    assert.deepEqual(errors, []);
  });

  test('validates serialized graph shapes and rejects invalid fields', () => {
    const result = graphFixture();
    const expected = { error: 'Invalid graph data received' };
    assert.deepEqual(parseGraphMessage(JSON.stringify({ result, root: '0x1' })), {
      result,
      root: '0x1',
    });
    assert.deepEqual(parseGraphMessage('invalid JSON'), expected);
    for (const value of [
      null,
      { root: 1 },
      { error: 1 },
      { comparison: null },
      { result: { ...result, nodes: [null] } },
      { result: { ...result, nodes: [{ ...result.nodes[0], depth: NaN }] } },
      { result: { ...result, nodes: [{ ...result.nodes[0], root_kind: 1 }] } },
      { result: { ...result, edges: [null] } },
      { result: { ...result, stats: null } },
      { comparison: { diffs: [{}], leak_suspects: [] } },
      { comparison: { diffs: [], leak_suspects: [{}] } },
    ])
      assert.deepEqual(readGraphMessage(value), expected);
    assert.deepEqual(
      readGraphMessage({
        result: undefined,
        root: undefined,
        error: undefined,
        comparison: undefined,
      }),
      { result: undefined, root: undefined, error: undefined, comparison: undefined },
    );
  });

  test('renders retained sizes, filters reactively, and exports both formats', async () => {
    await assertGraphCounts(page, 2, 1);
    assert.equal(await page.locator('.edge text').textContent(), '_child');
    assert.equal(await page.locator('[data-id="0x1"] circle').getAttribute('fill'), '#3899ec');
    assert.equal(await page.locator('[data-id="0x2"] circle').getAttribute('fill'), '#e49b36');
    assert.ok(
      (await page.locator('[data-id="0x2"] title').textContent())?.includes(
        'Retained: 2097152 bytes',
      ),
    );
    const radii = await page
      .locator('.node circle')
      .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('r'))));
    assert.ok(radii[1]! > radii[0]!);
    await page.getByLabel('Filter by type').fill('child');
    await assertGraphCounts(page, 1, 0);
    assert.equal(await page.locator('.node').getAttribute('data-id'), '0x2');
    await page.getByLabel('Filter by type').fill('');
    await assertGraphSearch(page, '0x1', '0x1');
    await assertGraphSearch(page, 'Child', '0x2');
    await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
    await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
    await page.waitForFunction(() =>
      window.graphMessages.some((message) => message.format === 'png'),
    );
    const exports = await page.evaluate(() =>
      window.graphMessages.filter((message) => message.command === 'export'),
    );
    assert.equal(exports.length, 2);
    assert.ok(String(exports[0]?.content).includes('<svg'));
    assert.ok(String(exports[0]?.content).includes('_child'));
    assert.ok(
      Buffer.from(String(exports[1]?.content), 'base64').subarray(1, 4).equals(Buffer.from('PNG')),
    );
  });

  test('follows light and dark themes and preserves export contrast', async () => {
    for (const foreground of ['rgb(20, 20, 20)', 'rgb(235, 235, 235)']) {
      await page.evaluate((color) => {
        document.documentElement.style.setProperty('--vscode-foreground', color);
        document.documentElement.style.setProperty(
          '--vscode-editor-background',
          color === 'rgb(20, 20, 20)' ? '#fafafa' : '#202020',
        );
      }, foreground);
      assert.equal(
        await page
          .locator('.node text')
          .first()
          .evaluate((label) => getComputedStyle(label).fill),
        foreground,
      );
      assert.equal(
        await page.locator('.edge text').evaluate((label) => getComputedStyle(label).fill),
        foreground,
      );
      await page.getByRole('button', { name: 'Export SVG', exact: true }).click();
      const exported = await page.evaluate(() => {
        const data = window.graphMessages.filter((message) => message.format === 'svg').at(-1);
        const root = new DOMParser().parseFromString(
          String(data?.content),
          'image/svg+xml',
        ).documentElement;
        return {
          color: root.getAttribute('color'),
          background: root.firstElementChild?.getAttribute('fill'),
          expected: getComputedStyle(document.body).backgroundColor,
        };
      });
      assert.equal(exported.color, foreground);
      assert.equal(exported.background, exported.expected);
    }
  });

  test('expands, inspects, collapses, highlights root paths and changes traversal depth', async () => {
    await page.locator('[data-id="0x2"]').dispatchEvent('click');
    await page.waitForFunction(() =>
      window.graphMessages.some((message) => message.command === 'expand'),
    );
    assert.deepEqual(await page.evaluate(() => window.graphMessages[0]), {
      command: 'expand',
      address: '0x2',
      depth: 3,
    });
    assert.equal(await page.locator('.edge line').getAttribute('stroke'), '#f5d76e');
    assert.equal(await page.locator('.node circle[stroke="#f5d76e"]').count(), 2);
    await page.locator('[data-id="0x2"]').dispatchEvent('contextmenu');
    assert.deepEqual(await page.evaluate(() => window.graphMessages[1]), {
      command: 'inspect',
      address: '0x2',
    });
    await page.locator('[data-id="0x1"]').dispatchEvent('dblclick');
    await assertGraphCounts(page, 1, 0);
    await page.locator('[data-id="0x1"]').dispatchEvent('dblclick');
    assert.equal(await page.locator('.node').count(), 2);
    await page.getByLabel('Traversal depth').fill('7');
    await page.getByLabel('Traversal depth').dispatchEvent('change');
    assert.equal(await page.locator('#depth-value').textContent(), '7');
    assert.deepEqual(await page.evaluate(() => window.graphMessages.at(-1)), {
      command: 'depth',
      depth: 7,
    });
    const result = graphFixture();
    result.nodes.push({ ...result.nodes[1]!, id: '0x3', display_name: 'new child', depth: 2 });
    await page.evaluate((value) => {
      window.postMessage({ result: value }, '*');
    }, result);
    await page.locator('[data-id="0x3"]').waitFor();
    assert.equal(await page.locator('.node').count(), 3);
    assert.ok((await page.locator('pre').textContent())?.includes('new child'));
    assert.equal(await page.locator('#status').textContent(), '');
  });

  test('merges lazy results without duplicating nodes or labelled edges', () => {
    const initial = graphFixture();
    const expanded = graphFixture();
    expanded.nodes.push({ ...expanded.nodes[1]!, id: '0x3', depth: 2 });
    expanded.edges.push({ from: '0x2', to: '0x3', field_name: '_next', reference_kind: 'Weak' });
    const merged = mergeGraph(initial, expanded);
    assert.equal(merged.nodes.length, 3);
    assert.equal(merged.edges.length, 2);
    assert.equal(merged.stats.total_nodes_traversed, 3);
    assert.equal(merged.stats.total_edges_traversed, 2);
    assert.equal(merged.stats.max_depth_reached, 2);
    assert.equal(merged.stats.truncated, true);
    assert.deepEqual(mergeGraph(merged, expanded), merged);
    assert.equal(initial.nodes.length, 2);
    const childExpansion = {
      ...graphFixture(),
      nodes: [
        { ...initial.nodes[1]!, depth: 0 },
        { ...initial.nodes[1]!, id: '0x3', depth: 1 },
      ],
      edges: [{ from: '0x2', to: '0x3', field_name: '_next', reference_kind: 'Strong' as const }],
    };
    assert.equal(
      mergeGraph(initial, childExpansion).nodes.find((node) => node.id === '0x3')?.depth,
      2,
    );
  });

  test('collapsing an ancestor hides previously collapsed descendants', async () => {
    await page.locator('[data-id="0x2"]').dispatchEvent('dblclick');
    await assertGraphCounts(page, 2, 1);
    await page.locator('[data-id="0x1"]').dispatchEvent('dblclick');
    await assertGraphCounts(page, 1, 0);
    assert.equal(await page.locator('.node').getAttribute('data-id'), '0x1');
    await page.locator('[data-id="0x1"]').dispatchEvent('dblclick');
    await assertGraphCounts(page, 2, 1);
  });

  test('annotates comparison growth, high severity leaks and newly allocated types', async () => {
    const comparison = {
      diffs: [
        {
          type_name: 'Child',
          baseline_count: 1,
          comparison_count: 4,
          count_delta: 3,
          baseline_size_bytes: 8,
          comparison_size_bytes: 32,
          size_delta_bytes: 24,
          growth_percent: 300,
        },
      ],
      leak_suspects: [
        {
          type_name: 'Child',
          severity: 'high',
          reason: 'Retained event handler',
          count_delta: 3,
          size_delta_bytes: 24,
        },
      ],
    };
    assert.deepEqual(parseGraphMessage(JSON.stringify({ comparison })), { comparison });
    await page.evaluate((value) => {
      window.postMessage({ comparison: value }, '*');
    }, comparison);
    await page.waitForFunction(
      () => document.querySelector('[data-id="0x2"] circle')?.getAttribute('fill') === '#e5534b',
    );
    assert.equal(await page.locator('[data-id="0x2"] circle').getAttribute('stroke'), '#e5534b');
    assert.equal(await page.locator('[data-id="0x2"] animate').count(), 1);
    assert.ok((await page.locator('[data-id="0x2"] title').textContent())?.includes('↑ 24 bytes'));
    comparison.diffs[0]!.baseline_count = 0;
    await page.evaluate((value) => {
      window.postMessage({ comparison: value }, '*');
    }, comparison);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-id="0x2"] circle')?.getAttribute('stroke-dasharray') ===
        '5 3',
    );
    await assertGraphCounts(page, 2, 1);
    assert.equal(await page.locator('[data-id="0x1"] circle').getAttribute('fill'), '#3899ec');
  });
});
