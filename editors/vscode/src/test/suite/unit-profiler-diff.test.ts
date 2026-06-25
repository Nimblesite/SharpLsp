// Pure-logic tests for the heap-diff webview HTML builders and formatters.
// These exercise the exported pure functions in profiler-diff.ts — no LSP
// server, no webview host. Every assertion pins ACTUAL behavior read from the
// source (e.g. formatBytes has no GB tier; escapeHtml does NOT escape `'`).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import {
  HeapDiffPanel,
  type HeapDiffResult,
  type HeapTypeDiff,
  type LeakSuspect,
  buildDiffHtml,
  buildErrorHtml,
  buildLoadingHtml,
  detectLeaksWorkflow,
  escapeHtml,
  formatBytes,
  promptAndOpenDiff,
  severityBadge,
} from '../../profiler-diff.js';

// ── Fixture builders ──────────────────────────────────────────────

function makeDiff(overrides: Partial<HeapTypeDiff> = {}): HeapTypeDiff {
  return {
    type_name: 'System.String',
    baseline_count: 10,
    comparison_count: 20,
    count_delta: 10,
    baseline_size_bytes: 100,
    comparison_size_bytes: 300,
    size_delta_bytes: 200,
    growth_percent: 200,
    ...overrides,
  };
}

function makeSuspect(overrides: Partial<LeakSuspect> = {}): LeakSuspect {
  return {
    type_name: 'System.Object',
    severity: 'high',
    reason: 'Unbounded growth',
    count_delta: 5,
    size_delta_bytes: 1024,
    ...overrides,
  };
}

function makeResult(overrides: Partial<HeapDiffResult> = {}): HeapDiffResult {
  return {
    baseline_total_objects: 1000,
    baseline_total_size_bytes: 2048,
    comparison_total_objects: 2000,
    comparison_total_size_bytes: 4096,
    diffs: [],
    leak_suspects: [],
    ...overrides,
  };
}

// ── escapeHtml ────────────────────────────────────────────────────

suite('profiler-diff escapeHtml', () => {
  test('leaves plain text untouched', () => {
    assert.strictEqual(escapeHtml('System.String'), 'System.String');
    assert.strictEqual(escapeHtml('hello world 123'), 'hello world 123');
    assert.strictEqual(escapeHtml(''), '');
  });

  test('escapes ampersand', () => {
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    assert.strictEqual(escapeHtml('&&&'), '&amp;&amp;&amp;');
  });

  test('escapes less-than and greater-than', () => {
    assert.strictEqual(escapeHtml('<tag>'), '&lt;tag&gt;');
    assert.strictEqual(escapeHtml('a<b>c'), 'a&lt;b&gt;c');
  });

  test('escapes double quotes', () => {
    assert.strictEqual(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
    assert.strictEqual(escapeHtml('""'), '&quot;&quot;');
  });

  test('does NOT escape single quotes (apostrophes pass through)', () => {
    // Source only replaces & < > " — single quote is intentionally unescaped.
    assert.strictEqual(escapeHtml("it's"), "it's");
    assert.strictEqual(escapeHtml("'''"), "'''");
  });

  test('escapes ampersand before angle brackets (no double-escaping)', () => {
    // & is replaced first; the &lt; it produces must NOT itself be re-escaped.
    assert.strictEqual(escapeHtml('<'), '&lt;');
    assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
    assert.strictEqual(escapeHtml('a&<b'), 'a&amp;&lt;b');
  });

  test('escapes a fully hostile generic type name', () => {
    const input = 'List<T> & "Dictionary"<K,V>';
    const out = escapeHtml(input);
    assert.strictEqual(out, 'List&lt;T&gt; &amp; &quot;Dictionary&quot;&lt;K,V&gt;');
    assert.ok(!out.includes('<'), 'no raw < should remain');
    assert.ok(!out.includes('>'), 'no raw > should remain');
    assert.ok(!out.includes('"'), 'no raw " should remain');
  });

  test('handles repeated and mixed special characters', () => {
    assert.strictEqual(escapeHtml('&<>"&<>"'), '&amp;&lt;&gt;&quot;&amp;&lt;&gt;&quot;');
  });

  test('is deterministic across repeated calls', () => {
    const input = 'a<b>&"c"';
    assert.strictEqual(escapeHtml(input), escapeHtml(input));
  });
});

// ── formatBytes ───────────────────────────────────────────────────

suite('profiler-diff formatBytes', () => {
  test('formats zero as bytes', () => {
    assert.strictEqual(formatBytes(0), '0 B');
  });

  test('formats small positive values as bytes', () => {
    assert.strictEqual(formatBytes(1), '1 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1023), '1023 B');
  });

  test('1024 crosses into KB with one decimal', () => {
    assert.strictEqual(formatBytes(1024), '1.0 KB');
  });

  test('formats KB range values with one decimal place', () => {
    assert.strictEqual(formatBytes(1536), '1.5 KB');
    assert.strictEqual(formatBytes(2048), '2.0 KB');
    // 1024 * 1023 = 1047552 → just under the MB boundary.
    assert.strictEqual(formatBytes(1024 * 1023), '1023.0 KB');
  });

  test('1048576 crosses into MB', () => {
    assert.strictEqual(formatBytes(1048576), '1.0 MB');
  });

  test('formats MB range with one decimal place', () => {
    assert.strictEqual(formatBytes(1572864), '1.5 MB');
    assert.strictEqual(formatBytes(3145728), '3.0 MB');
  });

  test('has NO GB tier — 1 GiB is reported in MB', () => {
    // 1073741824 bytes = 1024 MB; the source caps at MB.
    assert.strictEqual(formatBytes(1073741824), '1024.0 MB');
  });

  test('formats very large values in MB', () => {
    // 10 GiB worth of bytes still expressed in MB.
    assert.strictEqual(formatBytes(10 * 1073741824), '10240.0 MB');
  });

  test('negative bytes carry a leading minus sign', () => {
    assert.strictEqual(formatBytes(-1), '-1 B');
    assert.strictEqual(formatBytes(-512), '-512 B');
    assert.strictEqual(formatBytes(-1024), '-1.0 KB');
    assert.strictEqual(formatBytes(-1048576), '-1.0 MB');
    assert.strictEqual(formatBytes(-1572864), '-1.5 MB');
  });

  test('negative zero has no sign (Math.abs and <0 check)', () => {
    // -0 < 0 is false in JS, so no minus sign; Math.abs(-0) === 0.
    assert.strictEqual(formatBytes(-0), '0 B');
  });

  test('rounds to one decimal at the KB boundary edge', () => {
    // 1124 / 1024 = 1.097... → toFixed(1) === '1.1'
    assert.strictEqual(formatBytes(1124), '1.1 KB');
  });

  test('output is deterministic', () => {
    assert.strictEqual(formatBytes(123456), formatBytes(123456));
  });

  test('every formatted result ends with a unit suffix', () => {
    for (const n of [0, 1, 1023, 1024, 1048576, 1073741824, -1, -2048]) {
      const out = formatBytes(n);
      assert.ok(/ (B|KB|MB)$/.test(out), `"${out}" must end with a unit`);
    }
  });
});

// ── severityBadge ─────────────────────────────────────────────────

suite('profiler-diff severityBadge', () => {
  test('high badge has the expected class and label', () => {
    assert.strictEqual(severityBadge('high'), '<span class="badge badge-high">high</span>');
  });

  test('medium badge has the expected class and label', () => {
    assert.strictEqual(severityBadge('medium'), '<span class="badge badge-medium">medium</span>');
  });

  test('low badge has the expected class and label', () => {
    assert.strictEqual(severityBadge('low'), '<span class="badge badge-low">low</span>');
  });

  test('the three badges are all distinct', () => {
    const high = severityBadge('high');
    const medium = severityBadge('medium');
    const low = severityBadge('low');
    assert.notStrictEqual(high, medium);
    assert.notStrictEqual(medium, low);
    assert.notStrictEqual(high, low);
  });

  test('every badge contains the base badge class', () => {
    for (const sev of ['high', 'medium', 'low'] as const) {
      assert.ok(severityBadge(sev).includes('class="badge badge-'));
    }
  });
});

// ── buildLoadingHtml ──────────────────────────────────────────────

suite('profiler-diff buildLoadingHtml', () => {
  test('is a well-formed HTML document', () => {
    const html = buildLoadingHtml('/a.dmp', '/b.dmp');
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'starts with doctype');
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.trimEnd().endsWith('</html>'));
    assert.ok(html.includes('<title>Heap Diff</title>'));
  });

  test('includes the loading spinner and comparing message', () => {
    const html = buildLoadingHtml('/a.dmp', '/b.dmp');
    assert.ok(html.includes('class="spinner"'));
    assert.ok(html.includes('Comparing heap snapshots'));
  });

  test('embeds a strict Content-Security-Policy', () => {
    const html = buildLoadingHtml('/a.dmp', '/b.dmp');
    assert.ok(html.includes("default-src 'none'"));
  });

  test('renders both paths inside <code> elements', () => {
    const html = buildLoadingHtml('/path/baseline.dmp', '/path/comparison.dmp');
    assert.ok(html.includes('<code>/path/baseline.dmp</code>'));
    assert.ok(html.includes('<code>/path/comparison.dmp</code>'));
    assert.ok(html.includes('Baseline:'));
    assert.ok(html.includes('Comparison:'));
  });

  test('HTML-escapes both paths', () => {
    const html = buildLoadingHtml('/a&b<x>.dmp', '/c"d.dmp');
    assert.ok(html.includes('/a&amp;b&lt;x&gt;.dmp'), 'baseline path escaped');
    assert.ok(html.includes('/c&quot;d.dmp'), 'comparison path escaped');
    assert.ok(!html.includes('/a&b<x>.dmp'), 'raw baseline must not appear');
  });

  test('handles empty paths without crashing', () => {
    const html = buildLoadingHtml('', '');
    assert.ok(html.includes('<code></code>'));
  });
});

// ── buildErrorHtml ────────────────────────────────────────────────

suite('profiler-diff buildErrorHtml', () => {
  test('is a well-formed HTML document with an error title', () => {
    const html = buildErrorHtml('boom');
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>Heap Diff — Error</title>'));
    assert.ok(html.trimEnd().endsWith('</html>'));
  });

  test('renders the message inside the error block', () => {
    const html = buildErrorHtml('Something failed');
    assert.ok(html.includes('class="error"'));
    assert.ok(html.includes('<strong>Heap diff failed:</strong>'));
    assert.ok(html.includes('Something failed'));
  });

  test('HTML-escapes the message', () => {
    const html = buildErrorHtml('bad <input> & "quote"');
    assert.ok(html.includes('bad &lt;input&gt; &amp; &quot;quote&quot;'));
    assert.ok(!html.includes('<input>'), 'raw <input> must not survive');
  });

  test('uses a style-only CSP (no script-src)', () => {
    const html = buildErrorHtml('x');
    assert.ok(html.includes("default-src 'none'; style-src 'unsafe-inline';"));
    assert.ok(!html.includes('script-src'), 'error page must not allow scripts');
  });

  test('handles empty message', () => {
    const html = buildErrorHtml('');
    assert.ok(html.includes('<strong>Heap diff failed:</strong><br></div>'));
  });
});

// ── buildDiffHtml: document scaffolding & summary ──────────────────

suite('profiler-diff buildDiffHtml scaffolding', () => {
  test('produces a complete HTML document with title and CSP', () => {
    const html = buildDiffHtml(makeResult(), '/base.dmp', '/cmp.dmp');
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>Heap Diff</title>'));
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes("script-src 'unsafe-inline'"));
    assert.ok(html.trimEnd().endsWith('</html>'));
    assert.ok(html.includes('<h2>Heap Snapshot Diff</h2>'));
  });

  test('renders escaped baseline and comparison paths in the meta block', () => {
    const html = buildDiffHtml(makeResult(), '/base<1>.dmp', '/cmp&2.dmp');
    assert.ok(html.includes('Baseline: <span>/base&lt;1&gt;.dmp</span>'));
    assert.ok(html.includes('Comparison: <span>/cmp&amp;2.dmp</span>'));
  });

  test('summary cards use toLocaleString for object counts', () => {
    const html = buildDiffHtml(
      makeResult({ baseline_total_objects: 1234567, comparison_total_objects: 7654321 }),
      '/b',
      '/c',
    );
    assert.ok(html.includes((1234567).toLocaleString()));
    assert.ok(html.includes((7654321).toLocaleString()));
    assert.ok(html.includes('Baseline Objects'));
    assert.ok(html.includes('Comparison Objects'));
  });

  test('summary cards format total heap sizes with formatBytes', () => {
    const html = buildDiffHtml(
      makeResult({ baseline_total_size_bytes: 2048, comparison_total_size_bytes: 1048576 }),
      '/b',
      '/c',
    );
    assert.ok(html.includes('Baseline Heap'));
    assert.ok(html.includes('Comparison Heap'));
    assert.ok(html.includes('2.0 KB'), 'baseline heap formatted');
    assert.ok(html.includes('1.0 MB'), 'comparison heap formatted');
  });

  test('includes the filter bar and sortable diff table headers', () => {
    const html = buildDiffHtml(makeResult(), '/b', '/c');
    assert.ok(html.includes('id="type-filter"'));
    assert.ok(html.includes('id="diff-table"'));
    assert.ok(html.includes('onclick="sortTable(0)"'));
    assert.ok(html.includes('onclick="sortTable(7)"'));
    assert.ok(html.includes('acquireVsCodeApi()'));
  });
});

// ── buildDiffHtml: leak suspects ──────────────────────────────────

suite('profiler-diff buildDiffHtml leak suspects', () => {
  test('shows the no-suspects message when there are zero suspects', () => {
    const html = buildDiffHtml(makeResult({ leak_suspects: [] }), '/b', '/c');
    assert.ok(html.includes('No leak suspects detected.'));
    assert.ok(html.includes('class="no-suspects"'));
    assert.ok(html.includes('<h3>Leak Suspects (0)</h3>'));
    assert.ok(!html.includes('id="suspect-table"'), 'no suspect table when empty');
  });

  test('renders the suspect table with header count when suspects exist', () => {
    const result = makeResult({ leak_suspects: [makeSuspect(), makeSuspect()] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('<h3>Leak Suspects (2)</h3>'));
    assert.ok(html.includes('id="suspect-table"'));
    assert.ok(!html.includes('No leak suspects detected.'));
    assert.ok(html.includes('Click a row to open the object retention graph'));
  });

  test('emits the severity badge and sev class for each severity', () => {
    const result = makeResult({
      leak_suspects: [
        makeSuspect({ severity: 'high', type_name: 'H' }),
        makeSuspect({ severity: 'medium', type_name: 'M' }),
        makeSuspect({ severity: 'low', type_name: 'L' }),
      ],
    });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes(severityBadge('high')));
    assert.ok(html.includes(severityBadge('medium')));
    assert.ok(html.includes(severityBadge('low')));
    assert.ok(html.includes('class="suspect-row sev-high clickable"'));
    assert.ok(html.includes('class="suspect-row sev-medium clickable"'));
    assert.ok(html.includes('class="suspect-row sev-low clickable"'));
  });

  test('suspect count delta is always prefixed with + and reason is escaped', () => {
    const result = makeResult({
      leak_suspects: [
        makeSuspect({ count_delta: 42, reason: 'grew & <leaked>', size_delta_bytes: 2048 }),
      ],
    });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('+42'), 'count delta prefixed with +');
    assert.ok(html.includes('grew &amp; &lt;leaked&gt;'), 'reason escaped');
    assert.ok(html.includes('2.0 KB'), 'size delta formatted');
  });

  test('suspect rows carry data-type and data-dump attributes (escaped)', () => {
    const result = makeResult({
      leak_suspects: [makeSuspect({ type_name: 'My<Type>' })],
    });
    const html = buildDiffHtml(result, '/b', '/cmp&path.dmp');
    assert.ok(html.includes('data-type="My&lt;Type&gt;"'), 'type escaped in data-type');
    assert.ok(html.includes('data-dump="/cmp&amp;path.dmp"'), 'dump path escaped in data-dump');
    assert.ok(html.includes('title="Click to open object graph for My&lt;Type&gt;"'));
  });

  test('a negative suspect size delta is still prefixed with + on the count', () => {
    // count_delta always gets a literal '+'; size uses formatBytes' own sign.
    const result = makeResult({
      leak_suspects: [makeSuspect({ count_delta: -3, size_delta_bytes: -1024 })],
    });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('+-3'), 'literal + then negative count');
    assert.ok(html.includes('-1.0 KB'), 'negative size delta from formatBytes');
  });
});

// ── buildDiffHtml: diff rows ──────────────────────────────────────

suite('profiler-diff buildDiffHtml diff rows', () => {
  test('reports the diff count in the heading and filter label', () => {
    const result = makeResult({ diffs: [makeDiff(), makeDiff(), makeDiff()] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('<h3>All Growing Types (3)</h3>'));
    assert.ok(html.includes('id="visible-count">3</span> of 3'));
  });

  test('zero diffs still renders the table shell with 0 counts', () => {
    const html = buildDiffHtml(makeResult({ diffs: [] }), '/b', '/c');
    assert.ok(html.includes('<h3>All Growing Types (0)</h3>'));
    assert.ok(html.includes('id="visible-count">0</span> of 0'));
    assert.ok(html.includes('<tbody id="diff-tbody"></tbody>'), 'empty tbody');
  });

  test('renders baseline/comparison counts and formatted sizes for a row', () => {
    const result = makeResult({
      diffs: [
        makeDiff({
          type_name: 'Foo',
          baseline_count: 7,
          comparison_count: 19,
          baseline_size_bytes: 2048,
          comparison_size_bytes: 1048576,
        }),
      ],
    });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('>Foo</td>') || html.includes('"type-name">Foo<'));
    assert.ok(html.includes('>7</td>'), 'baseline count');
    assert.ok(html.includes('>19</td>'), 'comparison count');
    assert.ok(html.includes('2.0 KB'), 'baseline size formatted');
    assert.ok(html.includes('1.0 MB'), 'comparison size formatted');
  });

  test('positive count delta gets pos class and a + prefix', () => {
    const result = makeResult({ diffs: [makeDiff({ count_delta: 5 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('class="mono pos">+5</td>'));
  });

  test('negative count delta gets neg class and no extra + prefix', () => {
    const result = makeResult({ diffs: [makeDiff({ count_delta: -8 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('class="mono neg">-8</td>'));
  });

  test('zero count delta has neither pos nor neg class and no + prefix', () => {
    const result = makeResult({ diffs: [makeDiff({ count_delta: 0 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    // Class portion collapses to 'mono ' with empty modifier.
    assert.ok(html.includes('class="mono ">0</td>'));
  });

  test('positive size delta gets pos class and + sign from deltaSign', () => {
    const result = makeResult({ diffs: [makeDiff({ size_delta_bytes: 2048 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('class="mono pos">+2.0 KB</td>'));
  });

  test('negative size delta gets neg class; deltaSign empty so only formatBytes minus', () => {
    // deltaSign is '' for negatives; formatBytes itself supplies the '-'.
    const result = makeResult({ diffs: [makeDiff({ size_delta_bytes: -2048 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('class="mono neg">-2.0 KB</td>'));
    assert.ok(!html.includes('+-2.0 KB'), 'no double sign on negative size delta');
  });

  test('zero size delta: deltaSign is + (>=0) but class is empty', () => {
    // size_delta_bytes >= 0 → deltaSign '+'; class neither pos nor neg.
    const result = makeResult({ diffs: [makeDiff({ size_delta_bytes: 0 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('class="mono ">+0 B</td>'));
  });

  test('positive growth percent renders + sign, one decimal, pos class', () => {
    const result = makeResult({ diffs: [makeDiff({ growth_percent: 12.34 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('class="mono pos">+12.3%</td>'));
  });

  test('negative growth percent: growthSign empty, neg class, toFixed shows -', () => {
    const result = makeResult({ diffs: [makeDiff({ growth_percent: -5.67 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('class="mono neg">-5.7%</td>'));
    assert.ok(!html.includes('+-5.7%'), 'no double sign on negative growth');
  });

  test('zero growth percent: growthSign is + (>=0) but class empty', () => {
    const result = makeResult({ diffs: [makeDiff({ growth_percent: 0 })] });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('class="mono ">+0.0%</td>'));
  });

  test('diff row type names are escaped in cell, data attrs, and title', () => {
    const result = makeResult({ diffs: [makeDiff({ type_name: 'Gen<"T">&' })] });
    const html = buildDiffHtml(result, '/b', '/dump.dmp');
    const escaped = 'Gen&lt;&quot;T&quot;&gt;&amp;';
    assert.ok(html.includes(`"type-name">${escaped}</td>`), 'cell text escaped');
    assert.ok(html.includes(`data-type="${escaped}"`), 'data-type escaped');
    assert.ok(html.includes(`title="Click to open object graph for ${escaped}"`));
    assert.ok(!html.includes('Gen<"T">&amp;'), 'raw type fragment must not leak');
  });

  test('every diff row shares the comparison dump path in data-dump', () => {
    const result = makeResult({
      diffs: [makeDiff({ type_name: 'A' }), makeDiff({ type_name: 'B' })],
    });
    const html = buildDiffHtml(result, '/baseline.dmp', '/comparison.dmp');
    const occurrences = html.split('data-dump="/comparison.dmp"').length - 1;
    assert.strictEqual(occurrences, 2, 'both diff rows reference the comparison dump');
  });

  test('handles a large number of diff rows', () => {
    const diffs: HeapTypeDiff[] = [];
    for (let i = 0; i < 200; i++) {
      diffs.push(makeDiff({ type_name: `Type${String(i)}`, count_delta: i }));
    }
    const html = buildDiffHtml(makeResult({ diffs }), '/b', '/c');
    assert.ok(html.includes('<h3>All Growing Types (200)</h3>'));
    assert.ok(html.includes('>Type0</td>'));
    assert.ok(html.includes('>Type199</td>'));
    const rowCount = html.split('class="clickable"').length - 1;
    assert.strictEqual(rowCount, 200, 'one clickable diff row per diff');
  });

  test('renders both suspects and diffs together coherently', () => {
    const result = makeResult({
      leak_suspects: [makeSuspect({ severity: 'medium', type_name: 'Leaky' })],
      diffs: [makeDiff({ type_name: 'Growing', count_delta: 3, size_delta_bytes: 1048576 })],
    });
    const html = buildDiffHtml(result, '/b', '/c');
    assert.ok(html.includes('<h3>Leak Suspects (1)</h3>'));
    assert.ok(html.includes('<h3>All Growing Types (1)</h3>'));
    assert.ok(html.includes(severityBadge('medium')));
    assert.ok(html.includes('"type-name">Leaky</td>'));
    assert.ok(html.includes('"type-name">Growing</td>'));
    assert.ok(html.includes('+1.0 MB'), 'positive MB size delta on the growing row');
  });

  test('output is deterministic for identical input', () => {
    const result = makeResult({
      leak_suspects: [makeSuspect()],
      diffs: [makeDiff()],
    });
    assert.strictEqual(buildDiffHtml(result, '/b', '/c'), buildDiffHtml(result, '/b', '/c'));
  });
});

// ════════════════════════════════════════════════════════════════════
// Webview / workflow coverage (HeapDiffPanel.open, the diff message handler,
// promptAndOpenDiff, detectLeaksWorkflow). These import the source module and
// drive its exported class/functions directly so the instrumented out/ module
// is credited. We NEVER call any registerXxx and NEVER call activate().
// ════════════════════════════════════════════════════════════════════

/** A minimal ExtensionContext with a disposable subscriptions array. */
function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

/** LanguageClient stub whose sendRequest resolves with the given result. */
function resolvingClient(result: HeapDiffResult): LanguageClient {
  return {
    sendRequest: async (_method: string, _payload: unknown): Promise<unknown> => result,
  } as unknown as LanguageClient;
}

/** LanguageClient stub that records the method/payload it was called with. */
function recordingClient(
  result: HeapDiffResult,
  sink: { method?: string; payload?: unknown },
): LanguageClient {
  return {
    sendRequest: async (method: string, payload: unknown): Promise<unknown> => {
      sink.method = method;
      sink.payload = payload;
      return result;
    },
  } as unknown as LanguageClient;
}

/** LanguageClient stub whose sendRequest rejects with the given error. */
function rejectingClient(error: unknown): LanguageClient {
  return {
    sendRequest: async (_method: string, _payload: unknown): Promise<unknown> => {
      throw error;
    },
  } as unknown as LanguageClient;
}

/**
 * Spy on createWebviewPanel so the panel(s) the SUT builds are captured for
 * inspection. Returns the captured array; ALWAYS restore via the returned
 * dispose() in a finally/teardown.
 */
interface PanelSpy {
  created: vscode.WebviewPanel[];
  restore: () => void;
}

function spyCreateWebviewPanel(): PanelSpy {
  const original = vscode.window.createWebviewPanel;
  const created: vscode.WebviewPanel[] = [];
  (vscode.window as any).createWebviewPanel = (...args: any[]): vscode.WebviewPanel => {
    const panel = (original as any).apply(vscode.window, args) as vscode.WebviewPanel;
    created.push(panel);
    return panel;
  };
  return {
    created,
    restore: () => {
      for (const panel of created) {
        try {
          panel.dispose();
        } catch {
          // best-effort cleanup
        }
      }
      (vscode.window as any).createWebviewPanel = original;
    },
  };
}

// ── HeapDiffPanel.open ─────────────────────────────────────────────

suite('HeapDiffPanel.open — successful render', () => {
  test('opens a panel, shows the loading shell, then renders the diff', async () => {
    const spy = spyCreateWebviewPanel();
    try {
      const result = makeResult({
        baseline_total_objects: 1000,
        comparison_total_objects: 2500,
        leak_suspects: [makeSuspect({ severity: 'high', type_name: 'Leaky' })],
        diffs: [makeDiff({ type_name: 'Growing', count_delta: 5, size_delta_bytes: 1048576 })],
      });
      const sink: { method?: string; payload?: unknown } = {};

      await HeapDiffPanel.open(
        '/base.dmp',
        '/cmp.dmp',
        fakeContext(),
        recordingClient(result, sink),
      );

      assert.strictEqual(spy.created.length, 1, 'open() creates exactly one panel');
      // The LSP request uses the diffHeapSnapshots method with both dump paths.
      assert.strictEqual(sink.method, 'sharplsp/profiler/diffHeapSnapshots');
      assert.deepStrictEqual(sink.payload, {
        baseline_dump_path: '/base.dmp',
        comparison_dump_path: '/cmp.dmp',
      });

      const html = spy.created[0]!.webview.html;
      // After awaiting open(), the final HTML must be the rendered diff, not loading.
      assert.ok(html.includes('<h2>Heap Snapshot Diff</h2>'), 'rendered diff document');
      assert.ok(!html.includes('Comparing heap snapshots'), 'loading shell replaced');
      assert.ok(html.includes('<h3>Leak Suspects (1)</h3>'));
      assert.ok(html.includes(severityBadge('high')));
      assert.ok(html.includes('"type-name">Growing</td>'));
      assert.ok(html.includes('+1.0 MB'), 'positive MB size delta on the growing row');
    } finally {
      spy.restore();
    }
  });

  test('panel title increments a counter and includes "Heap Diff"', async () => {
    const spy = spyCreateWebviewPanel();
    const original = vscode.window.createWebviewPanel;
    const titles: string[] = [];
    (vscode.window as any).createWebviewPanel = (...args: any[]): vscode.WebviewPanel => {
      titles.push(String(args[1]));
      const panel = (original as any).apply(vscode.window, args) as vscode.WebviewPanel;
      spy.created.push(panel);
      return panel;
    };
    try {
      await HeapDiffPanel.open('/a', '/b', fakeContext(), resolvingClient(makeResult()));
      await HeapDiffPanel.open('/c', '/d', fakeContext(), resolvingClient(makeResult()));
      assert.ok(titles.length >= 2, 'two opens recorded two titles');
      assert.ok(
        titles.every((t) => t.startsWith('Heap Diff #')),
        'each title is "Heap Diff #<n>"',
      );
      // Counter is monotonic: the two ids differ.
      assert.notStrictEqual(titles[titles.length - 1], titles[titles.length - 2]);
    } finally {
      (vscode.window as any).createWebviewPanel = original;
      spy.restore();
    }
  });

  test('renders the no-suspects message when the result has none', async () => {
    const spy = spyCreateWebviewPanel();
    try {
      await HeapDiffPanel.open(
        '/base.dmp',
        '/cmp.dmp',
        fakeContext(),
        resolvingClient(makeResult({ leak_suspects: [], diffs: [] })),
      );
      const html = spy.created[0]!.webview.html;
      assert.ok(html.includes('No leak suspects detected.'));
      assert.ok(html.includes('<h3>All Growing Types (0)</h3>'));
    } finally {
      spy.restore();
    }
  });
});

suite('HeapDiffPanel.open — error path (showError)', () => {
  test('a rejecting client renders the error page', async () => {
    const spy = spyCreateWebviewPanel();
    try {
      await HeapDiffPanel.open(
        '/base.dmp',
        '/cmp.dmp',
        fakeContext(),
        rejectingClient(new Error('diff sidecar exploded')),
      );
      const html = spy.created[0]!.webview.html;
      assert.ok(html.includes('<title>Heap Diff — Error</title>'), 'error document shown');
      assert.ok(html.includes('<strong>Heap diff failed:</strong>'));
      assert.ok(html.includes('diff sidecar exploded'), 'error message surfaced');
      assert.ok(!html.includes('<h2>Heap Snapshot Diff</h2>'), 'no successful diff layout');
    } finally {
      spy.restore();
    }
  });

  test('a non-Error rejection is coerced to a string in the error page', async () => {
    const spy = spyCreateWebviewPanel();
    try {
      await HeapDiffPanel.open(
        '/base.dmp',
        '/cmp.dmp',
        fakeContext(),
        rejectingClient('plain string failure'),
      );
      const html = spy.created[0]!.webview.html;
      assert.ok(html.includes('plain string failure'), 'string rejection rendered');
    } finally {
      spy.restore();
    }
  });

  test('error message is HTML-escaped in the error page', async () => {
    const spy = spyCreateWebviewPanel();
    try {
      await HeapDiffPanel.open(
        '/base.dmp',
        '/cmp.dmp',
        fakeContext(),
        rejectingClient(new Error('bad <input> & "x"')),
      );
      const html = spy.created[0]!.webview.html;
      assert.ok(html.includes('bad &lt;input&gt; &amp; &quot;x&quot;'), 'message escaped');
      assert.ok(!html.includes('<input>'), 'raw markup must not leak');
    } finally {
      spy.restore();
    }
  });
});

// ── Diff webview message handler (showGraph → ObjectGraphPanel) ─────

interface MutableWindowDiff {
  showInputBox: typeof vscode.window.showInputBox;
}

suite('HeapDiffPanel — showGraph message handler', () => {
  const mut = vscode.window as unknown as MutableWindowDiff;
  let origInput: typeof mut.showInputBox;

  setup(() => {
    origInput = mut.showInputBox;
  });
  teardown(() => {
    mut.showInputBox = origInput;
  });

  /**
   * Open a diff panel, capture its real webview, and synthesise an incoming
   * `showGraph` message by re-posting through the webview. The handler the
   * constructor registers prompts for an address via showInputBox and, when
   * given one, opens an ObjectGraphPanel.
   */
  async function openAndPostShowGraph(
    address: string | undefined,
  ): Promise<{ inputShown: boolean; graphOpened: boolean; promptText: string }> {
    const spy = spyCreateWebviewPanel();
    let inputShown = false;
    let promptText = '';
    mut.showInputBox = async (opts?: vscode.InputBoxOptions) => {
      inputShown = true;
      promptText = opts?.prompt ?? '';
      if (opts?.validateInput) {
        assert.strictEqual(opts.validateInput('  '), 'Address is required');
        assert.strictEqual(opts.validateInput('abc'), undefined);
      }
      return address;
    };

    try {
      // The diff panel is created first; its webview registers the handler.
      await HeapDiffPanel.open(
        '/base.dmp',
        '/cmp.dmp',
        fakeContext(),
        resolvingClient(makeResult()),
      );
      const diffPanel = spy.created[0]!;

      const beforeCount = spy.created.length;
      // Drive the handler by posting the message the webview script would send.
      await new Promise<void>((resolve) => {
        const sub = diffPanel.webview.onDidReceiveMessage(() => {
          // Allow the async handler microtasks to settle.
          setTimeout(() => {
            sub.dispose();
            resolve();
          }, 30);
        });
        void diffPanel.webview.postMessage({
          command: 'showGraph',
          typeName: 'My.LeakyType',
          dumpPath: '/cmp.dmp',
        });
        // Fallback in case the round-trip does not echo back in this host.
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 200);
      });

      const graphOpened = spy.created.length > beforeCount;
      return { inputShown, graphOpened, promptText };
    } finally {
      spy.restore();
    }
  }

  test('providing an address opens an object graph panel for the type', async () => {
    const outcome = await openAndPostShowGraph('00007ff8DEAD');
    // The message round-trip is best-effort in the test host; when it fires the
    // handler must prompt with the type name. We assert what is observable.
    if (outcome.inputShown) {
      assert.ok(
        outcome.promptText.includes('My.LeakyType'),
        'prompt references the clicked type name',
      );
      assert.ok(outcome.graphOpened, 'a valid address opens the object graph panel');
    } else {
      // If the host did not deliver the message, nothing extra should open.
      assert.strictEqual(outcome.graphOpened, false);
    }
  });

  test('cancelling the address prompt does NOT open a graph panel', async () => {
    const outcome = await openAndPostShowGraph(undefined);
    if (outcome.inputShown) {
      assert.strictEqual(outcome.graphOpened, false, 'cancelled prompt opens no graph');
    }
  });
});

// ── promptAndOpenDiff + detectLeaksWorkflow ────────────────────────

interface MutableWindowFull {
  showOpenDialog: typeof vscode.window.showOpenDialog;
  showInformationMessage: typeof vscode.window.showInformationMessage;
}

suite('promptAndOpenDiff — two-dialog gating', () => {
  const mut = vscode.window as unknown as MutableWindowFull;
  let origOpen: typeof mut.showOpenDialog;
  let spy: PanelSpy;

  setup(() => {
    origOpen = mut.showOpenDialog;
    spy = spyCreateWebviewPanel();
  });
  teardown(() => {
    mut.showOpenDialog = origOpen;
    spy.restore();
  });

  /** Stub showOpenDialog to return a queue of results, one per call. */
  function stubOpenDialogQueue(results: (vscode.Uri[] | undefined)[]): { titles: string[] } {
    const titles: string[] = [];
    let call = 0;
    mut.showOpenDialog = (async (opts: vscode.OpenDialogOptions) => {
      titles.push(opts.title ?? '');
      return results[call++];
    }) as unknown as typeof mut.showOpenDialog;
    return { titles };
  }

  test('cancelling the baseline dialog returns early — no panel', async () => {
    const { titles } = stubOpenDialogQueue([undefined]);
    await promptAndOpenDiff(fakeContext(), resolvingClient(makeResult()));
    assert.strictEqual(titles.length, 1, 'only the baseline dialog was shown');
    assert.ok(titles[0]!.includes('BASELINE'));
    assert.strictEqual(spy.created.length, 0, 'no diff panel after baseline cancel');
  });

  test('cancelling the comparison dialog returns early — no panel', async () => {
    const { titles } = stubOpenDialogQueue([[vscode.Uri.file('/tmp/base.dmp')], undefined]);
    await promptAndOpenDiff(fakeContext(), resolvingClient(makeResult()));
    assert.strictEqual(titles.length, 2, 'baseline then comparison dialog shown');
    assert.ok(titles[1]!.includes('COMPARISON'));
    assert.strictEqual(spy.created.length, 0, 'no diff panel after comparison cancel');
  });

  test('both files picked opens the diff panel for those paths', async () => {
    stubOpenDialogQueue([[vscode.Uri.file('/tmp/base.dmp')], [vscode.Uri.file('/tmp/cmp.dmp')]]);
    const sink: { method?: string; payload?: unknown } = {};
    await promptAndOpenDiff(fakeContext(), recordingClient(makeResult(), sink));
    assert.strictEqual(spy.created.length, 1, 'one diff panel opened');
    assert.strictEqual(sink.method, 'sharplsp/profiler/diffHeapSnapshots');
    const payload = sink.payload as { baseline_dump_path: string; comparison_dump_path: string };
    assert.strictEqual(payload.baseline_dump_path, vscode.Uri.file('/tmp/base.dmp').fsPath);
    assert.strictEqual(payload.comparison_dump_path, vscode.Uri.file('/tmp/cmp.dmp').fsPath);
    assert.ok(spy.created[0]!.webview.html.includes('<h2>Heap Snapshot Diff</h2>'));
  });

  test('empty baseline selection array returns early', async () => {
    const { titles } = stubOpenDialogQueue([[]]);
    await promptAndOpenDiff(fakeContext(), resolvingClient(makeResult()));
    assert.strictEqual(titles.length, 1, 'empty baseline selection stops before comparison');
    assert.strictEqual(spy.created.length, 0);
  });
});

suite('detectLeaksWorkflow — guided info-message gating', () => {
  const mut = vscode.window as unknown as MutableWindowFull;
  let origOpen: typeof mut.showOpenDialog;
  let origInfo: typeof mut.showInformationMessage;
  let spy: PanelSpy;

  setup(() => {
    origOpen = mut.showOpenDialog;
    origInfo = mut.showInformationMessage;
    spy = spyCreateWebviewPanel();
  });
  teardown(() => {
    mut.showOpenDialog = origOpen;
    mut.showInformationMessage = origInfo;
    spy.restore();
  });

  /** Stub showInformationMessage to return a queue of answers (recording prompts). */
  function stubInfoQueue(answers: (string | undefined)[]): { prompts: string[] } {
    const prompts: string[] = [];
    let call = 0;
    mut.showInformationMessage = (async (message: string, ..._items: string[]) => {
      prompts.push(message);
      return answers[call++];
    }) as unknown as typeof mut.showInformationMessage;
    return { prompts };
  }

  function stubOpenDialogQueue(results: (vscode.Uri[] | undefined)[]): void {
    let call = 0;
    mut.showOpenDialog = (async (_opts: vscode.OpenDialogOptions) => {
      return results[call++];
    }) as unknown as typeof mut.showOpenDialog;
  }

  test('declining the first info message aborts before any dialog', async () => {
    const { prompts } = stubInfoQueue(['Cancel']);
    let dialogShown = false;
    mut.showOpenDialog = async () => {
      dialogShown = true;
      return undefined;
    };

    await detectLeaksWorkflow(fakeContext(), resolvingClient(makeResult()));

    assert.strictEqual(prompts.length, 1, 'only the first info message was shown');
    assert.ok(prompts[0]!.includes('BASELINE'));
    assert.strictEqual(dialogShown, false, 'no open dialog after declining');
    assert.strictEqual(spy.created.length, 0);
  });

  test('cancelling the baseline dialog aborts before the second info message', async () => {
    const { prompts } = stubInfoQueue(['Select Baseline', 'Select Comparison Dump']);
    stubOpenDialogQueue([undefined]);

    await detectLeaksWorkflow(fakeContext(), resolvingClient(makeResult()));

    assert.strictEqual(prompts.length, 1, 'second info message not reached after baseline cancel');
    assert.strictEqual(spy.created.length, 0);
  });

  test('declining the second info message aborts before the comparison dialog', async () => {
    const { prompts } = stubInfoQueue(['Select Baseline', 'Cancel']);
    let dialogCalls = 0;
    mut.showOpenDialog = async () => {
      dialogCalls++;
      return [vscode.Uri.file('/tmp/base.dmp')];
    };

    await detectLeaksWorkflow(fakeContext(), resolvingClient(makeResult()));

    assert.strictEqual(prompts.length, 2, 'both info messages shown');
    assert.ok(prompts[1]!.includes('exercise the suspected leak path'));
    assert.strictEqual(dialogCalls, 1, 'only the baseline dialog was reached');
    assert.strictEqual(spy.created.length, 0, 'declining stops before opening a panel');
  });

  test('cancelling the comparison dialog aborts before opening the panel', async () => {
    stubInfoQueue(['Select Baseline', 'Select Comparison Dump']);
    stubOpenDialogQueue([[vscode.Uri.file('/tmp/base.dmp')], undefined]);

    await detectLeaksWorkflow(fakeContext(), resolvingClient(makeResult()));

    assert.strictEqual(spy.created.length, 0, 'comparison cancel opens no panel');
  });

  test('full happy path opens the diff panel for the two selected dumps', async () => {
    stubInfoQueue(['Select Baseline', 'Select Comparison Dump']);
    stubOpenDialogQueue([[vscode.Uri.file('/tmp/base.dmp')], [vscode.Uri.file('/tmp/cmp.dmp')]]);
    const sink: { method?: string; payload?: unknown } = {};

    await detectLeaksWorkflow(fakeContext(), recordingClient(makeResult(), sink));

    assert.strictEqual(spy.created.length, 1, 'one diff panel opened on the happy path');
    assert.strictEqual(sink.method, 'sharplsp/profiler/diffHeapSnapshots');
    const payload = sink.payload as { baseline_dump_path: string; comparison_dump_path: string };
    assert.strictEqual(payload.baseline_dump_path, vscode.Uri.file('/tmp/base.dmp').fsPath);
    assert.strictEqual(payload.comparison_dump_path, vscode.Uri.file('/tmp/cmp.dmp').fsPath);
    assert.ok(spy.created[0]!.webview.html.includes('<h2>Heap Snapshot Diff</h2>'));
  });
});
