// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]: Basilisk's profiler-webviews suite
// on SharpLsp's live extension.
//
// Hardening and honesty of every profiler results panel (CPU results, memory
// dashboard, retention graph): a Content-Security-Policy, profiled-program data
// that cannot close the inline <script>, theme-following colours, the flame
// graph hero and its fallbacks, and a message handler bound once however often
// the panel re-renders, the last on a real live webview panel.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { delay } from '@nimblesite/lsp-profiler-ui/out/src/timeouts';
import {
  buildWebviewDocument,
  embedJson,
  SingletonWebviewPanel,
  type WebviewMessage,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-webview';
import {
  buildMemoryDashboardHtml,
  type MemoryDashboardSnapshot,
  type MemoryDiffData,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import { buildRefGraphHtml } from '@nimblesite/lsp-profiler-ui/out/src/memory-ref-graph';
import {
  buildFlamegraphHtml,
  loadFlamegraphSvgDataUri,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-flamegraph-html';
import type { ProfileResult } from '@nimblesite/lsp-profiler-ui/out/src/profiler-decorations';
import { stringField } from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';
import {
  assertHardened,
  assertHtml,
  closeAllEditors,
  pollUntilResult,
  profileResult as baseResult,
  removeTestDir,
} from './profiler-ui-helpers';

/** A payload that closes the surrounding <script> if embedding is unescaped. */
const HOSTILE = '</script><img src=x onerror=alert(1)>';
const SOURCE = '/app/Program.cs';

function dashboardSnapshot(
  overrides: Partial<MemoryDashboardSnapshot> = {},
): MemoryDashboardSnapshot {
  return {
    memorySessionId: 'mem-1',
    snapshotId: 'snap-1',
    currentMemory: 1_048_576,
    peakMemory: 2_097_152,
    gcObjects: 1200,
    gcCounts: [700, 12, 3],
    topAllocations: [{ file: SOURCE, line: 10, size: 4096, count: 8 }],
    timeline: [],
    heapProfilePath: '',
    ...overrides,
  };
}

function profileResult(overrides: Partial<ProfileResult> = {}): ProfileResult {
  return baseResult({
    hotFunctions: [
      { name: 'Hot', file: SOURCE, line: 3, samples: 200, percentage: 80, selfPercentage: 75 },
    ],
    hotLines: [{ file: SOURCE, line: 5, samples: 180, percentage: 72 }],
    ...overrides,
  });
}

suite('Profiler webviews — shared host hardening', () => {
  test('memory dashboard HTML is CSP-locked and hostile allocation data cannot escape the script', () => {
    const diff: MemoryDiffData = {
      totalGrowth: 2048,
      totalFreed: 0,
      netGrowth: 2048,
      suspectedLeaks: [
        {
          file: HOSTILE,
          line: 1,
          sizeGrowth: 2048,
          countGrowth: 2,
          currentSize: 4096,
          currentCount: 4,
          confidence: 'high',
          reason: HOSTILE,
        },
      ],
      grownAllocations: [],
    };
    const html = buildMemoryDashboardHtml(
      dashboardSnapshot({ topAllocations: [{ file: HOSTILE, line: 1, size: 1024, count: 2 }] }),
      diff,
    );
    assertHardened(html, 'the memory dashboard');
    assertHtml(html, {
      'escapeHtml(basename(a.file))': 'allocation paths must be escaped before innerHTML',
      'escapeHtml(lk.reason)': 'leak reasons must be escaped before innerHTML',
    });
  });

  test('the dashboard offers the raw heap profile via a button only when one exists', () => {
    const buttons = {
      'Open Heap Profile in VS Code Viewer': 'the native .heapprofile viewer button',
      'Open in Speedscope (external)': 'the speedscope deep-link button',
    };
    const withTrace = buildMemoryDashboardHtml(
      dashboardSnapshot({ heapProfilePath: '/tmp/sharplsp-mem-1.heapprofile' }),
    );
    assertHtml(withTrace, {
      ...buttons,
      openHeapProfile: 'the heap-profile button must post a message the extension handles',
      openSpeedscope: 'the speedscope button must post a message the extension handles',
    });
    // The action script references the ids defensively; only the BUTTONS are absent.
    assertHtml(buildMemoryDashboardHtml(dashboardSnapshot()), buttons, false);
  });

  test('retention graph HTML is CSP-locked and hostile type names/reprs cannot escape', () => {
    const html = buildRefGraphHtml({
      targetType: HOSTILE,
      maxDepth: 5,
      maxNodes: 200,
      script: '',
      graph: {
        nodes: [{ id: 1, type: HOSTILE, size: 64, repr: HOSTILE, depth: 0, isTarget: true }],
        edges: [{ from: 1, to: 1, label: HOSTILE }],
        cycles: [],
        retentionPath: [HOSTILE],
      },
    });
    assertHardened(html, 'the retention graph');
    assertHtml(html, { '&lt;/script&gt;': 'the target type in the heading must be HTML-escaped' });
  });

  test('retention graph renders an honest empty state when the walk found nothing', () => {
    const html = buildRefGraphHtml({
      targetType: 'Widget',
      maxDepth: 5,
      maxNodes: 200,
      script: '',
    });
    assertHtml(html, {
      'No reference graph data available': 'an empty walk must say so, never a blank canvas',
    });
  });

  test('profiler webviews follow the editor theme instead of hardcoding a dark palette', () => {
    const surfaces = [
      buildMemoryDashboardHtml(dashboardSnapshot()),
      buildRefGraphHtml({ targetType: 'W', maxDepth: 5, maxNodes: 200, script: '' }),
      buildFlamegraphHtml(profileResult()),
    ];
    for (const html of surfaces) {
      assertHtml(html, {
        'var(--vscode-editor-background': 'panel background must track the active VS Code theme',
        'var(--vscode-editor-foreground': 'panel text must track the active VS Code theme',
      });
    }
  });

  test('embedJson keeps a </script> payload inert inside an inline script', () => {
    const embedded = embedJson({ name: HOSTILE });
    assertHtml(
      embedded,
      { '</script>': 'embedJson must escape < so the script cannot close' },
      false,
    );
    const roundTripped: unknown = JSON.parse(embedded);
    assert.equal(
      stringField(roundTripped, 'name'),
      HOSTILE,
      'escaping must not corrupt the payload',
    );
  });
});

suite('Profiler webviews — flame graph hero', () => {
  let tmpDir = '';

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-flame-hero-'));
  });

  suiteTeardown(() => {
    removeTestDir(tmpDir);
  });

  function writeSvg(name: string, contents: string): string {
    const svgPath = path.join(tmpDir, name);
    fs.writeFileSync(svgPath, contents);
    return svgPath;
  }

  test('the results panel embeds the LSP-exported flame graph SVG as its hero', () => {
    const svgPath = writeSvg(
      'profile.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    );
    assertHtml(buildFlamegraphHtml(profileResult({ flamegraphPath: svgPath })), {
      'data:image/svg+xml;base64,': 'the flame graph SVG must be inlined as a data URI',
      'open-flame-svg': 'the hero must offer opening the interactive SVG externally',
      openFlamegraphSvg: 'the open action must post a message the extension handles',
    });
  });

  test('the results panel offers the raw trace via an "Open Trace in VS Code Viewer" button', () => {
    const trace = '/tmp/sharplsp-s-1.cpuprofile';
    assertHtml(buildFlamegraphHtml(profileResult({ cpuProfilePath: trace })), {
      'Open Trace in VS Code Viewer': 'the panel must offer opening the native .cpuprofile viewer',
      openCpuProfile: 'the trace button must post a message the extension handles',
    });
    assertHtml(
      buildFlamegraphHtml(profileResult()),
      { [trace]: 'no stale trace path may be embedded when no .cpuprofile was produced' },
      false,
    );
  });

  test('a missing or unreadable SVG degrades to the tables, never a broken image', () => {
    const deadPath = path.join(tmpDir, 'nope.svg');
    for (const result of [profileResult(), profileResult({ flamegraphPath: deadPath })]) {
      const html = buildFlamegraphHtml(result);
      assertHtml(
        html,
        { 'data:image/svg+xml': 'no hero image without a readable SVG', '<img': 'no broken <img>' },
        false,
      );
      assertHtml(html, { 'fn-body': 'the hot-functions table must still render' });
    }
  });

  test('loadFlamegraphSvgDataUri refuses empty and oversized artifacts', () => {
    assert.equal(loadFlamegraphSvgDataUri(undefined), undefined);
    assert.equal(loadFlamegraphSvgDataUri(''), undefined);
    const empty = writeSvg('empty.svg', '');
    assert.equal(
      loadFlamegraphSvgDataUri(empty),
      undefined,
      'an empty artifact is not a flame graph',
    );
    const oversized = writeSvg('huge.svg', `<svg>${'x'.repeat(5 * 1024 * 1024)}</svg>`);
    assert.equal(
      loadFlamegraphSvgDataUri(oversized),
      undefined,
      'an oversized artifact is not inlined',
    );
  });
});

suite('Profiler webviews — singleton panel message handler', () => {
  teardown(async () => {
    await closeAllEditors();
  });

  test('re-opening a panel re-renders but never stacks a second message handler', async function () {
    this.timeout(30_000);
    const received: WebviewMessage[] = [];
    const panel = new SingletonWebviewPanel(
      () => 'sharplsp.test.handlerOnce',
      (msg) => {
        received.push(msg);
      },
    );
    // Each render posts exactly one 'ready'; a handler re-registered per open
    // would deliver the second render's post TWICE.
    function doc(marker: string): string {
      return buildWebviewDocument({
        title: 'handler-once probe',
        css: '',
        body: `<p>${marker}</p>`,
        script: `acquireVsCodeApi().postMessage({ type: 'ready', file: '${marker}' });`,
      });
    }
    try {
      for (const [index, marker] of ['first', 'second'].entries()) {
        panel.show('probe', doc(marker));
        await pollUntilResult(
          () => received.length,
          (count) => count >= index + 1,
        );
      }
      await delay(1_000);
      assert.equal(
        received.length,
        2,
        `each render delivers once, got ${received.map((m) => m.file ?? '?').join(', ')}`,
      );
      assert.ok(panel.isOpen(), 'the singleton panel must stay open across re-renders');
    } finally {
      panel.dispose();
    }
    assert.ok(!panel.isOpen(), 'dispose must settle the panel closed');
  });
});
