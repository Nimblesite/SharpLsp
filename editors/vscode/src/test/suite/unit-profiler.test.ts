// Pure-logic unit tests for the Profiler module's own formatting + tree-node
// builders. These mirror (but are SEPARATE copies from) profiler-diff.ts; they
// assert profiler.ts's OWN bodies. No LSP server, no commands, no webview host —
// only the exported pure functions are exercised directly.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import {
  formatBytes,
  formatDuration,
  formatCounterValue,
  escapeHtml,
  buildCounterHtml,
  buildSessionNode,
  buildProcessNode,
  ProfilerTreeItem,
  ProfilerTreeProvider,
  ProfilerStatusBar,
  type CounterValue,
  type SessionInfo,
  type DotNetProcess,
} from '../../profiler.js';

// ── formatBytes ───────────────────────────────────────────────────

suite('Profiler — formatBytes()', () => {
  test('zero bytes renders in the byte tier', () => {
    assert.strictEqual(formatBytes(0), '0 B');
  });

  test('small positive byte counts stay in the byte tier', () => {
    assert.strictEqual(formatBytes(1), '1 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1000), '1000 B');
  });

  test('1023 is the last value in the byte tier', () => {
    assert.strictEqual(formatBytes(1023), '1023 B');
  });

  test('exactly 1024 crosses into the KB tier at 1.0 KB', () => {
    assert.strictEqual(formatBytes(1024), '1.0 KB');
  });

  test('KB tier uses one decimal place', () => {
    assert.strictEqual(formatBytes(1536), '1.5 KB');
    assert.strictEqual(formatBytes(2048), '2.0 KB');
  });

  test('KB tier rounds to one decimal', () => {
    // 1124 / 1024 = 1.0976... → "1.1 KB"
    assert.strictEqual(formatBytes(1124), '1.1 KB');
  });

  test('just below 1 MB stays in the KB tier', () => {
    // 1024 * 1023 = 1047552 bytes => kb = 1023.0 < 1024 => KB tier
    assert.strictEqual(formatBytes(1024 * 1023), '1023.0 KB');
  });

  test('exactly 1 MiB crosses into the MB tier', () => {
    assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
  });

  test('MB tier uses one decimal place', () => {
    assert.strictEqual(formatBytes(1024 * 1024 * 5), '5.0 MB');
    assert.strictEqual(formatBytes(Math.round(1024 * 1024 * 2.5)), '2.5 MB');
  });

  test('large multi-gigabyte values still render as MB', () => {
    // The implementation has no GB tier — everything >= 1 MiB is "MB".
    const tenGib = 1024 * 1024 * 1024 * 10;
    assert.strictEqual(formatBytes(tenGib), '10240.0 MB');
  });

  test('negative bytes fall through the byte tier (no abs handling)', () => {
    assert.strictEqual(formatBytes(-1), '-1 B');
    assert.strictEqual(formatBytes(-1024), '-1024 B');
  });
});

// ── formatDuration ────────────────────────────────────────────────

suite('Profiler — formatDuration()', () => {
  test('zero ms renders in the millisecond tier', () => {
    assert.strictEqual(formatDuration(0), '0ms');
  });

  test('sub-second values stay in milliseconds', () => {
    assert.strictEqual(formatDuration(1), '1ms');
    assert.strictEqual(formatDuration(500), '500ms');
    assert.strictEqual(formatDuration(999), '999ms');
  });

  test('exactly 1000ms crosses into the seconds tier', () => {
    assert.strictEqual(formatDuration(1000), '1.0s');
  });

  test('seconds tier uses one decimal place', () => {
    assert.strictEqual(formatDuration(1500), '1.5s');
    assert.strictEqual(formatDuration(2500), '2.5s');
  });

  test('seconds tier rounds to one decimal', () => {
    // 1234 / 1000 = 1.234 → "1.2s"
    assert.strictEqual(formatDuration(1234), '1.2s');
  });

  test('just below one minute stays in the seconds tier', () => {
    // 59000ms => 59.0s
    assert.strictEqual(formatDuration(59_000), '59.0s');
    // 59999ms => 59.999s < 60 => "60.0s" after toFixed(1) rounding
    assert.strictEqual(formatDuration(59_999), '60.0s');
  });

  test('exactly 60 seconds crosses into the minutes tier', () => {
    assert.strictEqual(formatDuration(60_000), '1m 0s');
  });

  test('minutes tier renders whole minutes plus rounded remainder seconds', () => {
    assert.strictEqual(formatDuration(90_000), '1m 30s');
    assert.strictEqual(formatDuration(125_000), '2m 5s');
  });

  test('minutes tier rounds the remainder seconds to whole seconds', () => {
    // 90500ms => 90.5s => minutes=1, remaining=30.5 => toFixed(0) => "30" (banker-free round half up)
    assert.strictEqual(formatDuration(90_500), '1m 31s');
  });

  test('exact multiples of a minute show zero remainder seconds', () => {
    assert.strictEqual(formatDuration(120_000), '2m 0s');
    assert.strictEqual(formatDuration(600_000), '10m 0s');
  });
});

// ── formatCounterValue ────────────────────────────────────────────

suite('Profiler — formatCounterValue()', () => {
  test('unit "bytes" delegates to formatBytes', () => {
    assert.strictEqual(formatCounterValue(0, 'bytes'), '0 B');
    assert.strictEqual(formatCounterValue(2048, 'bytes'), '2.0 KB');
    assert.strictEqual(formatCounterValue(1024 * 1024, 'bytes'), '1.0 MB');
  });

  test('unit casing is normalized before matching bytes', () => {
    assert.strictEqual(formatCounterValue(1024, 'BYTES'), '1.0 KB');
    assert.strictEqual(formatCounterValue(1024, 'Bytes'), '1.0 KB');
  });

  test('any unit containing the substring "byte" is treated as bytes', () => {
    assert.strictEqual(formatCounterValue(1024, 'megabytes'), '1.0 KB');
    assert.strictEqual(formatCounterValue(512, 'kilobyte'), '512 B');
    assert.strictEqual(formatCounterValue(2048, 'byte-count'), '2.0 KB');
  });

  test('integer non-byte values use locale grouping', () => {
    assert.strictEqual(formatCounterValue(1000, 'count'), (1000).toLocaleString());
    assert.strictEqual(formatCounterValue(1234567, 'requests'), (1234567).toLocaleString());
  });

  test('zero integer non-byte value renders as "0"', () => {
    assert.strictEqual(formatCounterValue(0, 'count'), (0).toLocaleString());
    assert.strictEqual(formatCounterValue(0, 'count'), '0');
  });

  test('fractional non-byte values use two decimals', () => {
    assert.strictEqual(formatCounterValue(3.14159, 'ratio'), '3.14');
    assert.strictEqual(formatCounterValue(0.5, '%'), '0.50');
    assert.strictEqual(formatCounterValue(99.999, 'ms'), '100.00');
  });

  test('negative fractional non-byte value uses two decimals', () => {
    assert.strictEqual(formatCounterValue(-1.5, 'delta'), '-1.50');
  });

  test('negative integer non-byte value uses locale grouping', () => {
    assert.strictEqual(formatCounterValue(-2000, 'delta'), (-2000).toLocaleString());
  });

  test('empty unit string with integer value uses locale grouping', () => {
    assert.strictEqual(formatCounterValue(42, ''), (42).toLocaleString());
  });

  test('empty unit string with fractional value uses two decimals', () => {
    assert.strictEqual(formatCounterValue(1.25, ''), '1.25');
  });
});

// ── escapeHtml ────────────────────────────────────────────────────

suite('Profiler — escapeHtml()', () => {
  test('plain text passes through unchanged', () => {
    assert.strictEqual(escapeHtml('hello world'), 'hello world');
  });

  test('empty string returns empty string', () => {
    assert.strictEqual(escapeHtml(''), '');
  });

  test('ampersand is escaped', () => {
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
  });

  test('less-than is escaped', () => {
    assert.strictEqual(escapeHtml('a < b'), 'a &lt; b');
  });

  test('greater-than is escaped', () => {
    assert.strictEqual(escapeHtml('a > b'), 'a &gt; b');
  });

  test('double quote is escaped', () => {
    assert.strictEqual(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  });

  test('single quote (apostrophe) is NOT escaped', () => {
    assert.strictEqual(escapeHtml("it's fine"), "it's fine");
  });

  test('all four escaped entities together, in source order', () => {
    assert.strictEqual(
      escapeHtml('<a href="x">&</a>'),
      '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;',
    );
  });

  test('ampersand is escaped first so existing entities double-escape', () => {
    // & is replaced before <, so an input "&lt;" becomes "&amp;lt;".
    assert.strictEqual(escapeHtml('&lt;'), '&amp;lt;');
    assert.strictEqual(escapeHtml('&amp;'), '&amp;amp;');
  });

  test('multiple occurrences are all replaced', () => {
    assert.strictEqual(escapeHtml('<<>>'), '&lt;&lt;&gt;&gt;');
    assert.strictEqual(escapeHtml('&&&'), '&amp;&amp;&amp;');
  });

  test('a script-injection payload is fully neutralized', () => {
    assert.strictEqual(
      escapeHtml('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  test('unicode and emoji content survives escaping unchanged', () => {
    assert.strictEqual(escapeHtml('café 日本語 🚀'), 'café 日本語 🚀');
  });
});

// ── buildCounterHtml ──────────────────────────────────────────────

function counter(overrides: Partial<CounterValue>): CounterValue {
  return {
    provider: 'System.Runtime',
    name: 'cpu-usage',
    display_name: 'CPU Usage',
    value: 12,
    unit: '%',
    ...overrides,
  };
}

suite('Profiler — buildCounterHtml()', () => {
  test('empty list shows the waiting placeholder, not a data row', () => {
    const html = buildCounterHtml([]);
    assert.ok(html.includes('Waiting for counter data'));
    assert.ok(html.includes('colspan="4"'));
    assert.ok(!html.includes('<td class="provider">'));
  });

  test('output is a full HTML document with the expected scaffolding', () => {
    const html = buildCounterHtml([]);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>Live Counters</title>'));
    assert.ok(html.includes('Live .NET Performance Counters'));
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes('<th>Provider</th><th>Counter</th><th>Value</th><th>Unit</th>'));
    assert.ok(html.trimEnd().endsWith('</html>'));
  });

  test('a single counter renders one data row with all four cells', () => {
    const html = buildCounterHtml([
      counter({ provider: 'P', display_name: 'D', value: 7, unit: 'x' }),
    ]);
    assert.ok(html.includes('<td class="provider">P</td>'));
    assert.ok(html.includes('<td class="name">D</td>'));
    assert.ok(html.includes('<td class="value">7</td>'));
    assert.ok(html.includes('<td class="unit">x</td>'));
    assert.ok(!html.includes('Waiting for counter data'));
  });

  test('blank display_name falls back to the raw counter name', () => {
    const html = buildCounterHtml([counter({ name: 'gc-heap-size', display_name: '' })]);
    assert.ok(html.includes('<td class="name">gc-heap-size</td>'));
  });

  test('non-blank display_name is preferred over the raw name', () => {
    const html = buildCounterHtml([
      counter({ name: 'gc-heap-size', display_name: 'GC Heap Size' }),
    ]);
    assert.ok(html.includes('<td class="name">GC Heap Size</td>'));
    assert.ok(!html.includes('>gc-heap-size<'));
  });

  test('byte-unit counter values are byte-formatted in the value cell', () => {
    const html = buildCounterHtml([counter({ value: 2048, unit: 'bytes' })]);
    assert.ok(html.includes('<td class="value">2.0 KB</td>'));
    assert.ok(html.includes('<td class="unit">bytes</td>'));
  });

  test('integer non-byte value uses locale grouping in the value cell', () => {
    const html = buildCounterHtml([counter({ value: 1000, unit: 'count' })]);
    assert.ok(html.includes(`<td class="value">${(1000).toLocaleString()}</td>`));
  });

  test('fractional non-byte value uses two decimals in the value cell', () => {
    const html = buildCounterHtml([counter({ value: 3.14159, unit: 'ratio' })]);
    assert.ok(html.includes('<td class="value">3.14</td>'));
  });

  test('provider, name, value and unit cells are all HTML-escaped', () => {
    const html = buildCounterHtml([
      counter({
        provider: 'A&B',
        name: '<n>',
        display_name: '<n>',
        value: 5,
        unit: '<u>',
      }),
    ]);
    assert.ok(html.includes('<td class="provider">A&amp;B</td>'));
    assert.ok(html.includes('<td class="name">&lt;n&gt;</td>'));
    assert.ok(html.includes('<td class="unit">&lt;u&gt;</td>'));
    // Raw, unescaped malicious markup must NOT appear.
    assert.ok(!html.includes('<td class="provider">A&B</td>'));
  });

  test('multiple counters are sorted by "provider/name" ascending', () => {
    const html = buildCounterHtml([
      counter({ provider: 'Zeta', name: 'a', display_name: 'Za', value: 1, unit: 'x' }),
      counter({ provider: 'Alpha', name: 'b', display_name: 'Ab', value: 2, unit: 'x' }),
      counter({ provider: 'Alpha', name: 'a', display_name: 'Aa', value: 3, unit: 'x' }),
    ]);
    const idxAa = html.indexOf('>Aa<');
    const idxAb = html.indexOf('>Ab<');
    const idxZa = html.indexOf('>Za<');
    assert.ok(idxAa !== -1 && idxAb !== -1 && idxZa !== -1, 'all rows present');
    assert.ok(idxAa < idxAb, 'Alpha/a before Alpha/b');
    assert.ok(idxAb < idxZa, 'Alpha/b before Zeta/a');
  });

  test('renders exactly one data row per counter', () => {
    const html = buildCounterHtml([
      counter({ provider: 'P1', name: 'n1', display_name: 'one', value: 1, unit: 'u' }),
      counter({ provider: 'P2', name: 'n2', display_name: 'two', value: 2, unit: 'u' }),
    ]);
    const rowCount = html.split('<td class="provider">').length - 1;
    assert.strictEqual(rowCount, 2);
  });
});

// ── buildSessionNode ──────────────────────────────────────────────

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'sess-1',
    kind: 'Trace',
    pid: 4242,
    processName: 'MyApp',
    outputPath: '/tmp/trace.nettrace',
    startedAt: Date.now(),
    ...overrides,
  };
}

suite('Profiler — buildSessionNode()', () => {
  test('returns a ProfilerTreeItem with nodeKind "session"', () => {
    const node = buildSessionNode(session({}));
    assert.ok(node instanceof ProfilerTreeItem);
    assert.strictEqual(node.nodeKind, 'session');
  });

  test('Trace session with a process name renders name + PID in the label', () => {
    const node = buildSessionNode(session({ kind: 'Trace', processName: 'MyApp', pid: 4242 }));
    assert.strictEqual(node.label, 'Trace: MyApp (PID 4242)');
  });

  test('session without a process name renders kind + PID only', () => {
    const node = buildSessionNode(session({ kind: 'Trace', processName: undefined, pid: 7 }));
    assert.strictEqual(node.label, 'Trace: PID 7');
  });

  test('empty-string process name is treated as no name', () => {
    const node = buildSessionNode(session({ kind: 'Counters', processName: '', pid: 9 }));
    assert.strictEqual(node.label, 'Counters: PID 9');
  });

  test('contextValue is profiler-session-<lowercased kind>', () => {
    assert.strictEqual(
      buildSessionNode(session({ kind: 'Trace' })).contextValue,
      'profiler-session-trace',
    );
    assert.strictEqual(
      buildSessionNode(session({ kind: 'Counters' })).contextValue,
      'profiler-session-counters',
    );
  });

  test('sessionId is propagated onto the node', () => {
    const node = buildSessionNode(session({ id: 'abc-123' }));
    assert.strictEqual(node.sessionId, 'abc-123');
  });

  test('defined outputPath is propagated onto the node', () => {
    const node = buildSessionNode(session({ outputPath: '/tmp/x.nettrace' }));
    assert.strictEqual(node.outputPath, '/tmp/x.nettrace');
  });

  test('undefined outputPath leaves node.outputPath undefined', () => {
    const node = buildSessionNode(session({ outputPath: undefined }));
    assert.strictEqual(node.outputPath, undefined);
  });

  test('collapsibleState is None (sessions are leaf nodes)', () => {
    const node = buildSessionNode(session({}));
    assert.strictEqual(node.collapsibleState, vscode.TreeItemCollapsibleState.None);
  });

  test('Trace session description reads "recording · <n>s"', () => {
    const node = buildSessionNode(session({ kind: 'Trace', startedAt: Date.now() }));
    assert.ok(typeof node.description === 'string');
    assert.ok(node.description.startsWith('recording · '));
    assert.ok(node.description.endsWith('s'));
  });

  test('Counters session description is exactly "streaming"', () => {
    const node = buildSessionNode(session({ kind: 'Counters' }));
    assert.strictEqual(node.description, 'streaming');
  });

  test('Trace session uses the "record" theme icon coloured charts.red', () => {
    const node = buildSessionNode(session({ kind: 'Trace' }));
    const icon = node.iconPath as vscode.ThemeIcon;
    assert.strictEqual(icon.id, 'record');
    assert.strictEqual(icon.color!.id, 'charts.red');
  });

  test('Counters session uses the "pulse" theme icon coloured charts.red', () => {
    const node = buildSessionNode(session({ kind: 'Counters' }));
    const icon = node.iconPath as vscode.ThemeIcon;
    assert.strictEqual(icon.id, 'pulse');
    assert.strictEqual(icon.color!.id, 'charts.red');
  });

  test('tooltip is a MarkdownString listing process, PID and session id', () => {
    const node = buildSessionNode(
      session({ kind: 'Trace', processName: 'MyApp', pid: 4242, id: 'sess-1' }),
    );
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip instanceof vscode.MarkdownString);
    assert.ok(tooltip.value.includes('**Trace session**'));
    assert.ok(tooltip.value.includes('- Process: `MyApp`'));
    assert.ok(tooltip.value.includes('- PID: `4242`'));
    assert.ok(tooltip.value.includes('- Session ID: `sess-1`'));
    assert.ok(tooltip.value.includes('- Output: `/tmp/trace.nettrace`'));
  });

  test('tooltip omits the Process line when there is no process name', () => {
    const node = buildSessionNode(session({ processName: undefined }));
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(!tooltip.value.includes('- Process:'));
  });

  test('tooltip omits the Output line when there is no output path', () => {
    const node = buildSessionNode(session({ outputPath: undefined }));
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(!tooltip.value.includes('- Output:'));
  });

  test('Trace tooltip prompts stop & open; Counters tooltip prompts show panel', () => {
    const trace = buildSessionNode(session({ kind: 'Trace' })).tooltip as vscode.MarkdownString;
    const counters = buildSessionNode(session({ kind: 'Counters' }))
      .tooltip as vscode.MarkdownString;
    assert.ok(trace.value.includes('Click to **stop & open** the trace.'));
    assert.ok(counters.value.includes('Click to **show the live counters panel**.'));
  });

  test('default command targets the stop-session command with the node as arg', () => {
    const node = buildSessionNode(session({ kind: 'Trace' }));
    assert.ok(node.command !== undefined);
    assert.strictEqual(node.command.command, 'sharplsp.profiler.stopSession');
    assert.strictEqual(node.command.title, 'Stop Trace');
    assert.deepStrictEqual(node.command.arguments, [node]);
  });

  test('Counters session command title is "Show Counters"', () => {
    const node = buildSessionNode(session({ kind: 'Counters' }));
    assert.strictEqual(node.command?.title, 'Show Counters');
    assert.strictEqual(node.command?.command, 'sharplsp.profiler.stopSession');
  });

  test('session node carries no process pid or process name', () => {
    const node = buildSessionNode(session({}));
    assert.strictEqual(node.processPid, undefined);
    assert.strictEqual(node.processName, undefined);
  });
});

// ── buildSessionNode() — remaining outputPath / processName branches ──

suite('Profiler — buildSessionNode() edge branches', () => {
  test('empty-string outputPath is !== undefined so it IS propagated and listed in the tooltip', () => {
    const node = buildSessionNode(session({ outputPath: '' }));
    assert.strictEqual(node.outputPath, '');
    const tooltip = node.tooltip as vscode.MarkdownString;
    // The builder's `outputPath !== undefined` check is true for '' → an Output line renders.
    assert.ok(tooltip.value.includes('- Output: ``'));
  });

  test('empty-string processName omits both the label name and the tooltip Process line', () => {
    const node = buildSessionNode(session({ kind: 'Trace', processName: '', pid: 3 }));
    assert.strictEqual(node.label, 'Trace: PID 3');
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(!tooltip.value.includes('- Process:'));
    assert.ok(tooltip.value.includes('- PID: `3`'));
  });

  test('mixed-case kind lowercases only the contextValue, preserving the label casing', () => {
    const node = buildSessionNode(session({ kind: 'TRACE', processName: 'App', pid: 1 }));
    assert.strictEqual(node.contextValue, 'profiler-session-trace');
    assert.strictEqual(node.label, 'TRACE: App (PID 1)');
    // A non-'Trace' kind string takes the Counters branch for description/icon/command.
    assert.strictEqual(node.description, 'streaming');
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, 'pulse');
    assert.strictEqual(node.command?.title, 'Show Counters');
  });

  test('a non-Trace, non-Counters kind falls through to the Counters-style branches', () => {
    const node = buildSessionNode(session({ kind: 'GcDump', processName: undefined, pid: 8 }));
    assert.strictEqual(node.contextValue, 'profiler-session-gcdump');
    assert.strictEqual(node.label, 'GcDump: PID 8');
    assert.strictEqual(node.description, 'streaming');
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, 'pulse');
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip.value.includes('**GcDump session**'));
    assert.ok(tooltip.value.includes('Click to **show the live counters panel**.'));
  });

  test('session node always reports nodeKind "session" and None collapsibility regardless of kind', () => {
    for (const kind of ['Trace', 'Counters', 'Other']) {
      const node = buildSessionNode(session({ kind }));
      assert.strictEqual(node.nodeKind, 'session');
      assert.strictEqual(node.collapsibleState, vscode.TreeItemCollapsibleState.None);
    }
  });
});

// ── buildProcessNode ──────────────────────────────────────────────

function proc(overrides: Partial<DotNetProcess>): DotNetProcess {
  return {
    pid: 1234,
    name: 'dotnet',
    command_line: 'dotnet run --project App',
    runtime_version: '10.0.0',
    ...overrides,
  };
}

suite('Profiler — buildProcessNode()', () => {
  test('returns a ProfilerTreeItem with nodeKind "process"', () => {
    const node = buildProcessNode(proc({}));
    assert.ok(node instanceof ProfilerTreeItem);
    assert.strictEqual(node.nodeKind, 'process');
  });

  test('label is "<name> (PID <pid>)"', () => {
    const node = buildProcessNode(proc({ name: 'WebApi', pid: 555 }));
    assert.strictEqual(node.label, 'WebApi (PID 555)');
  });

  test('contextValue is "profiler-process"', () => {
    assert.strictEqual(buildProcessNode(proc({})).contextValue, 'profiler-process');
  });

  test('pid and processName are propagated onto the node', () => {
    const node = buildProcessNode(proc({ name: 'Worker', pid: 99 }));
    assert.strictEqual(node.processPid, 99);
    assert.strictEqual(node.processName, 'Worker');
  });

  test('collapsibleState is None (processes are leaf nodes)', () => {
    const node = buildProcessNode(proc({}));
    assert.strictEqual(node.collapsibleState, vscode.TreeItemCollapsibleState.None);
  });

  test('description shows known runtime version and command line', () => {
    const node = buildProcessNode(
      proc({ runtime_version: '10.0.0', command_line: 'dotnet run --project App' }),
    );
    assert.strictEqual(node.description, '.NET 10.0.0 · dotnet run --project App');
  });

  test('null runtime version renders ".NET (version unknown)"', () => {
    const node = buildProcessNode(proc({ runtime_version: null, command_line: 'app.dll' }));
    assert.strictEqual(node.description, '.NET (version unknown) · app.dll');
  });

  test('empty-string runtime version renders ".NET (version unknown)"', () => {
    const node = buildProcessNode(proc({ runtime_version: '', command_line: 'app.dll' }));
    assert.strictEqual(node.description, '.NET (version unknown) · app.dll');
  });

  test('process node uses the "terminal" theme icon (uncoloured)', () => {
    const node = buildProcessNode(proc({}));
    const icon = node.iconPath as vscode.ThemeIcon;
    assert.strictEqual(icon.id, 'terminal');
    assert.strictEqual(icon.color, undefined);
  });

  test('tooltip is a MarkdownString with name, PID, runtime and command line', () => {
    const node = buildProcessNode(
      proc({ name: 'Svc', pid: 321, runtime_version: '10.0.0', command_line: 'svc --port 80' }),
    );
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip instanceof vscode.MarkdownString);
    assert.ok(tooltip.value.includes('**Svc** · PID `321`'));
    assert.ok(tooltip.value.includes('Runtime: .NET 10.0.0'));
    assert.ok(tooltip.value.includes('`svc --port 80`'));
    assert.ok(tooltip.value.includes('Right-click for: trace, counters, dump, copy PID, kill.'));
  });

  test('tooltip reflects unknown runtime version', () => {
    const node = buildProcessNode(proc({ runtime_version: null }));
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip.value.includes('Runtime: .NET (version unknown)'));
  });

  test('default command starts a trace on this process with the node as arg', () => {
    const node = buildProcessNode(proc({ pid: 1234 }));
    assert.ok(node.command !== undefined);
    assert.strictEqual(node.command.command, 'sharplsp.profiler.traceProcess');
    assert.strictEqual(node.command.title, 'Start Trace');
    assert.deepStrictEqual(node.command.arguments, [node]);
  });

  test('process node carries no sessionId or outputPath', () => {
    const node = buildProcessNode(proc({}));
    assert.strictEqual(node.sessionId, undefined);
    assert.strictEqual(node.outputPath, undefined);
  });
});

// ── buildProcessNode() — exhaustive branch coverage ───────────────
//
// These drive the runtime_version nullish-coalescing (present / null /
// undefined / empty) AND the tooltip + description string assembly across
// special-char names and empty / very-long command lines, asserting every
// field of the produced ProfilerTreeItem.

suite('Profiler — buildProcessNode() runtime_version branches', () => {
  test('absent runtime_version field (undefined) renders ".NET (version unknown)"', () => {
    // Build a process with NO runtime_version key at all — distinct from null.
    const bare: DotNetProcess = {
      pid: 808,
      name: 'NoRuntime',
      command_line: 'noruntime.dll',
    };
    assert.strictEqual(bare.runtime_version, undefined);
    const node = buildProcessNode(bare);
    assert.strictEqual(node.description, '.NET (version unknown) · noruntime.dll');
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip.value.includes('Runtime: .NET (version unknown)'));
    assert.ok(tooltip.value.includes('**NoRuntime** · PID `808`'));
    assert.ok(tooltip.value.includes('`noruntime.dll`'));
  });

  test('present non-empty runtime_version takes the ".NET <v>" branch in description AND tooltip', () => {
    const node = buildProcessNode(
      proc({ runtime_version: '8.0.11', command_line: 'svc.dll', name: 'Svc', pid: 11 }),
    );
    assert.strictEqual(node.description, '.NET 8.0.11 · svc.dll');
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip.value.includes('Runtime: .NET 8.0.11'));
    assert.ok(tooltip.value.includes('**Svc** · PID `11`'));
  });

  test('null and absent (undefined) runtime_version produce identical descriptions', () => {
    const nullNode = buildProcessNode(proc({ runtime_version: null, command_line: 'x.dll' }));
    // An ABSENT runtime_version key flows through the same `?? ''` nullish branch.
    const absentNode = buildProcessNode({ pid: 1, name: 'dotnet', command_line: 'x.dll' });
    assert.strictEqual(nullNode.description, absentNode.description);
    assert.strictEqual(absentNode.description, '.NET (version unknown) · x.dll');
  });

  test('empty-string runtime_version is treated as unknown in tooltip too', () => {
    const node = buildProcessNode(proc({ runtime_version: '', command_line: 'empty.dll' }));
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip.value.includes('Runtime: .NET (version unknown)'));
    assert.ok(!tooltip.value.includes('Runtime: .NET  '));
  });
});

suite('Profiler — buildProcessNode() name / command-line assembly', () => {
  test('special-character process name is preserved verbatim in label, tooltip and command', () => {
    const node = buildProcessNode(
      proc({ name: 'My.App<Worker> & "Co"', pid: 42, command_line: 'm.dll' }),
    );
    assert.strictEqual(node.label, 'My.App<Worker> & "Co" (PID 42)');
    assert.strictEqual(node.processName, 'My.App<Worker> & "Co"');
    const tooltip = node.tooltip as vscode.MarkdownString;
    // The tooltip is a MarkdownString; the builder does NOT HTML-escape names.
    assert.ok(tooltip.value.includes('**My.App<Worker> & "Co"** · PID `42`'));
    assert.ok(node.command !== undefined);
    assert.deepStrictEqual(node.command.arguments, [node]);
  });

  test('empty command_line still produces a well-formed description and tooltip', () => {
    const node = buildProcessNode(proc({ command_line: '', runtime_version: '10.0.0' }));
    assert.strictEqual(node.description, '.NET 10.0.0 · ');
    const tooltip = node.tooltip as vscode.MarkdownString;
    // Empty command line renders as an empty backtick span on its own line.
    assert.ok(tooltip.value.includes('``'));
    assert.ok(tooltip.value.includes('Runtime: .NET 10.0.0'));
  });

  test('a very long command_line is carried through unchanged into description and tooltip', () => {
    const longCmd = `dotnet ${'--flag '.repeat(60)}App.dll`.trim();
    const node = buildProcessNode(proc({ command_line: longCmd, runtime_version: '10.0.0' }));
    assert.strictEqual(node.description, `.NET 10.0.0 · ${longCmd}`);
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip.value.includes(`\`${longCmd}\``));
  });

  test('label embeds the numeric PID via String()', () => {
    assert.strictEqual(buildProcessNode(proc({ pid: 0 })).label, 'dotnet (PID 0)');
    assert.strictEqual(
      buildProcessNode(proc({ pid: 2147483647 })).label,
      'dotnet (PID 2147483647)',
    );
  });

  test('tooltip always closes with the right-click action hint and a click-to-act line', () => {
    const node = buildProcessNode(proc({}));
    const tooltip = node.tooltip as vscode.MarkdownString;
    assert.ok(tooltip instanceof vscode.MarkdownString);
    assert.ok(
      tooltip.value.includes(
        'Click to choose an action. Right-click for: trace, counters, dump, copy PID, kill.',
      ),
    );
  });

  test('every produced process node is a None-collapsible terminal-icon leaf with the trace command', () => {
    const node = buildProcessNode(proc({ name: 'Leaf', pid: 5, runtime_version: null }));
    assert.strictEqual(node.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(node.contextValue, 'profiler-process');
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).id, 'terminal');
    assert.strictEqual((node.iconPath as vscode.ThemeIcon).color, undefined);
    assert.strictEqual(node.command?.command, 'sharplsp.profiler.traceProcess');
    assert.strictEqual(node.command?.title, 'Start Trace');
    assert.strictEqual(node.sessionId, undefined);
    assert.strictEqual(node.outputPath, undefined);
  });
});

// ── ProfilerTreeItem constructor ──────────────────────────────────

suite('Profiler — ProfilerTreeItem constructor', () => {
  test('bare construction defaults all optional members to undefined', () => {
    const item = new ProfilerTreeItem('Label', 'header', vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(item.label, 'Label');
    assert.strictEqual(item.nodeKind, 'header');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(item.processPid, undefined);
    assert.strictEqual(item.processName, undefined);
    assert.strictEqual(item.sessionId, undefined);
    assert.strictEqual(item.outputPath, undefined);
    assert.strictEqual(item.contextValue, undefined);
  });

  test('options populate the matching public members', () => {
    const item = new ProfilerTreeItem('L', 'process', vscode.TreeItemCollapsibleState.Collapsed, {
      pid: 7,
      processName: 'n',
      sessionId: 's',
      outputPath: '/p',
      contextValue: 'ctx',
    });
    assert.strictEqual(item.processPid, 7);
    assert.strictEqual(item.processName, 'n');
    assert.strictEqual(item.sessionId, 's');
    assert.strictEqual(item.outputPath, '/p');
    assert.strictEqual(item.contextValue, 'ctx');
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  });

  test('contextValue stays undefined when omitted from options', () => {
    const item = new ProfilerTreeItem('L', 'process', vscode.TreeItemCollapsibleState.None, {
      pid: 1,
    });
    assert.strictEqual(item.contextValue, undefined);
    assert.strictEqual(item.processPid, 1);
  });
});

// ── ProfilerTreeProvider ──────────────────────────────────────────
//
// The provider is a TreeDataProvider whose `getChildren()`/`getTreeItem()` and
// session/process mutators are all directly callable. `refresh()` talks to a
// LanguageClient via `sendRequest('sharplsp/profiler/listProcesses')`; we drive
// it with stub clients that resolve/reject so no LSP server is needed.

/** A LanguageClient stub whose sendRequest resolves with the given process list. */
function processListClient(processes: DotNetProcess[]): LanguageClient {
  return {
    sendRequest: async (_method: string, _payload: unknown): Promise<unknown> => processes,
  } as unknown as LanguageClient;
}

/** A LanguageClient stub whose sendRequest rejects with the given error. */
function failingListClient(error: unknown): LanguageClient {
  return {
    sendRequest: async (_method: string, _payload: unknown): Promise<unknown> => {
      throw error;
    },
  } as unknown as LanguageClient;
}

const PROC_A: DotNetProcess = {
  pid: 100,
  name: 'AppA',
  command_line: 'dotnet AppA.dll',
  runtime_version: '10.0.0',
};
const PROC_B: DotNetProcess = {
  pid: 200,
  name: 'AppB',
  command_line: 'dotnet AppB.dll',
  runtime_version: null,
};

suite('Profiler — ProfilerTreeProvider getChildren() / getTreeItem()', () => {
  test('fresh provider with no sessions and no processes shows the empty node', () => {
    const provider = new ProfilerTreeProvider();
    const nodes = provider.getChildren();
    assert.strictEqual(nodes.length, 1);
    const empty = nodes[0]!;
    assert.strictEqual(empty.label, 'No .NET processes found');
    assert.strictEqual(empty.nodeKind, 'header');
    assert.strictEqual(empty.description, 'Click the refresh icon to scan again');
    const icon = empty.iconPath as vscode.ThemeIcon;
    assert.strictEqual(icon.id, 'info');
    assert.strictEqual(empty.collapsibleState, vscode.TreeItemCollapsibleState.None);
  });

  test('getChildren(element) always returns no children (flat tree)', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('s1', 'Trace', 1);
    const root = provider.getChildren();
    assert.ok(root.length > 0);
    // Passing any node back in yields an empty array — every node is a leaf.
    for (const node of root) {
      assert.deepStrictEqual(provider.getChildren(node), []);
    }
  });

  test('getTreeItem returns the element it is handed unchanged', () => {
    const provider = new ProfilerTreeProvider();
    const item = new ProfilerTreeItem('X', 'header', vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(provider.getTreeItem(item), item);
  });

  test('a single session yields a header plus one session node, no process header', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('sess-1', 'Trace', 4242, '/tmp/t.nettrace', 'MyApp');
    const nodes = provider.getChildren();
    assert.strictEqual(nodes.length, 2);

    const header = nodes[0]!;
    assert.strictEqual(header.label, 'Active Sessions (1)');
    assert.strictEqual(header.nodeKind, 'header');
    assert.strictEqual(header.contextValue, 'profiler-header-sessions');
    assert.strictEqual((header.iconPath as vscode.ThemeIcon).id, 'pulse');
    assert.strictEqual(header.collapsibleState, vscode.TreeItemCollapsibleState.None);

    const session = nodes[1]!;
    assert.strictEqual(session.nodeKind, 'session');
    assert.strictEqual(session.label, 'Trace: MyApp (PID 4242)');
    assert.strictEqual(session.sessionId, 'sess-1');
    assert.strictEqual(session.outputPath, '/tmp/t.nettrace');
    assert.strictEqual(session.contextValue, 'profiler-session-trace');

    // No process header should appear.
    assert.ok(!nodes.some((n) => n.contextValue === 'profiler-header-processes'));
  });

  test('session header pluralizes the count as sessions are added', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('a', 'Trace', 1);
    provider.addSession('b', 'Counters', 2);
    provider.addSession('c', 'Trace', 3);
    const header = provider.getChildren()[0]!;
    assert.strictEqual(header.label, 'Active Sessions (3)');
    assert.strictEqual(provider.sessionCount, 3);
  });

  test('sessions appear in insertion order beneath the header', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('first', 'Trace', 1, undefined, 'First');
    provider.addSession('second', 'Counters', 2, undefined, 'Second');
    const nodes = provider.getChildren();
    // [header, first, second]
    assert.strictEqual(nodes[1]!.sessionId, 'first');
    assert.strictEqual(nodes[2]!.sessionId, 'second');
    assert.strictEqual(nodes[1]!.label, 'Trace: First (PID 1)');
    assert.strictEqual(nodes[2]!.label, 'Counters: Second (PID 2)');
  });

  test('Trace and Counters sessions get distinct context values and icons', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('t', 'Trace', 1);
    provider.addSession('c', 'Counters', 2);
    const nodes = provider.getChildren();
    const trace = nodes.find((n) => n.sessionId === 't')!;
    const counters = nodes.find((n) => n.sessionId === 'c')!;
    assert.strictEqual(trace.contextValue, 'profiler-session-trace');
    assert.strictEqual(counters.contextValue, 'profiler-session-counters');
    assert.strictEqual((trace.iconPath as vscode.ThemeIcon).id, 'record');
    assert.strictEqual((counters.iconPath as vscode.ThemeIcon).id, 'pulse');
    assert.ok(
      typeof trace.description === 'string' && trace.description.startsWith('recording · '),
    );
    assert.strictEqual(counters.description, 'streaming');
  });

  test('after refresh() with processes, a process header plus process nodes appear', async () => {
    const provider = new ProfilerTreeProvider();
    provider.setClient(processListClient([PROC_A, PROC_B]));
    await provider.refresh();
    const nodes = provider.getChildren();
    // [process header, procA, procB]
    assert.strictEqual(nodes.length, 3);

    const header = nodes[0]!;
    assert.strictEqual(header.label, '.NET Processes (2)');
    assert.strictEqual(header.contextValue, 'profiler-header-processes');
    assert.strictEqual((header.iconPath as vscode.ThemeIcon).id, 'server-process');

    const procA = nodes[1]!;
    assert.strictEqual(procA.nodeKind, 'process');
    assert.strictEqual(procA.label, 'AppA (PID 100)');
    assert.strictEqual(procA.processPid, 100);
    assert.strictEqual(procA.processName, 'AppA');
    assert.strictEqual(procA.contextValue, 'profiler-process');
    assert.strictEqual(procA.description, '.NET 10.0.0 · dotnet AppA.dll');

    const procB = nodes[2]!;
    assert.strictEqual(procB.label, 'AppB (PID 200)');
    assert.strictEqual(procB.description, '.NET (version unknown) · dotnet AppB.dll');
  });

  test('with both sessions and processes, both headers and all nodes render in order', async () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('sess', 'Trace', 1, undefined, 'Sess');
    provider.setClient(processListClient([PROC_A]));
    await provider.refresh();
    const nodes = provider.getChildren();
    // [sessions header, session, processes header, process]
    assert.strictEqual(nodes.length, 4);
    assert.strictEqual(nodes[0]!.contextValue, 'profiler-header-sessions');
    assert.strictEqual(nodes[1]!.nodeKind, 'session');
    assert.strictEqual(nodes[2]!.contextValue, 'profiler-header-processes');
    assert.strictEqual(nodes[3]!.nodeKind, 'process');
    // The empty placeholder must NOT appear when real nodes exist.
    assert.ok(!nodes.some((n) => n.label === 'No .NET processes found'));
  });
});

suite('Profiler — ProfilerTreeProvider session mutation', () => {
  test('addSession then findSession returns the stored SessionInfo', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('id-1', 'Trace', 55, '/out.nettrace', 'Web');
    const found = provider.findSession('id-1');
    assert.ok(found !== undefined);
    assert.strictEqual(found.id, 'id-1');
    assert.strictEqual(found.kind, 'Trace');
    assert.strictEqual(found.pid, 55);
    assert.strictEqual(found.outputPath, '/out.nettrace');
    assert.strictEqual(found.processName, 'Web');
    assert.ok(typeof found.startedAt === 'number');
  });

  test('addSession with omitted outputPath and processName stores undefined for both', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('id-2', 'Counters', 77);
    const found = provider.findSession('id-2')!;
    assert.strictEqual(found.outputPath, undefined);
    assert.strictEqual(found.processName, undefined);
  });

  test('findSession returns undefined for an unknown id', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('present', 'Trace', 1);
    assert.strictEqual(provider.findSession('absent'), undefined);
  });

  test('removeSession drops the matching session and decrements the count', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('keep', 'Trace', 1);
    provider.addSession('drop', 'Counters', 2);
    assert.strictEqual(provider.sessionCount, 2);
    provider.removeSession('drop');
    assert.strictEqual(provider.sessionCount, 1);
    assert.strictEqual(provider.findSession('drop'), undefined);
    assert.ok(provider.findSession('keep') !== undefined);
  });

  test('removeSession with an unknown id is a no-op', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('only', 'Trace', 1);
    provider.removeSession('nope');
    assert.strictEqual(provider.sessionCount, 1);
    assert.ok(provider.findSession('only') !== undefined);
  });

  test('sessionCount starts at zero and tracks adds/removes', () => {
    const provider = new ProfilerTreeProvider();
    assert.strictEqual(provider.sessionCount, 0);
    provider.addSession('a', 'Trace', 1);
    provider.addSession('b', 'Trace', 2);
    assert.strictEqual(provider.sessionCount, 2);
    provider.removeSession('a');
    provider.removeSession('b');
    assert.strictEqual(provider.sessionCount, 0);
  });

  test('getActiveSessions filters by kind', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('t1', 'Trace', 1);
    provider.addSession('t2', 'Trace', 2);
    provider.addSession('c1', 'Counters', 3);
    const traces = provider.getActiveSessions('Trace');
    const counters = provider.getActiveSessions('Counters');
    assert.strictEqual(traces.length, 2);
    assert.deepStrictEqual(
      traces.map((s) => s.id),
      ['t1', 't2'],
    );
    assert.strictEqual(counters.length, 1);
    assert.strictEqual(counters[0]!.id, 'c1');
    assert.deepStrictEqual(provider.getActiveSessions('Unknown'), []);
  });
});

suite('Profiler — ProfilerTreeProvider refresh() and process cache', () => {
  test('refresh() without a client is a no-op (no processes, no throw)', async () => {
    const provider = new ProfilerTreeProvider();
    await provider.refresh();
    const nodes = provider.getChildren();
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0]!.label, 'No .NET processes found');
  });

  test('refresh() populates processNameFor() from the listed processes', async () => {
    const provider = new ProfilerTreeProvider();
    provider.setClient(processListClient([PROC_A, PROC_B]));
    await provider.refresh();
    assert.strictEqual(provider.processNameFor(100), 'AppA');
    assert.strictEqual(provider.processNameFor(200), 'AppB');
    assert.strictEqual(provider.processNameFor(999), undefined);
  });

  test('processNameFor() is undefined before any refresh', () => {
    const provider = new ProfilerTreeProvider();
    assert.strictEqual(provider.processNameFor(100), undefined);
  });

  test('refresh() failure clears the cached processes and does not throw', async () => {
    const provider = new ProfilerTreeProvider();
    provider.setClient(processListClient([PROC_A]));
    await provider.refresh();
    assert.strictEqual(provider.processNameFor(100), 'AppA');

    // Now swap in a failing client; refresh should swallow the error and reset.
    provider.setClient(failingListClient(new Error('listProcesses boom')));
    await provider.refresh();
    assert.strictEqual(provider.processNameFor(100), undefined);
    const nodes = provider.getChildren();
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0]!.label, 'No .NET processes found');
  });

  test('refresh() failure with a non-Error rejection still clears processes', async () => {
    const provider = new ProfilerTreeProvider();
    provider.setClient(processListClient([PROC_A, PROC_B]));
    await provider.refresh();
    assert.strictEqual(provider.processNameFor(200), 'AppB');

    provider.setClient(failingListClient('string failure'));
    await provider.refresh();
    assert.strictEqual(provider.processNameFor(200), undefined);
  });

  test('refresh() replaces a previously empty process list', async () => {
    const provider = new ProfilerTreeProvider();
    provider.setClient(processListClient([]));
    await provider.refresh();
    assert.strictEqual(provider.getChildren()[0]!.label, 'No .NET processes found');

    provider.setClient(processListClient([PROC_A]));
    await provider.refresh();
    const nodes = provider.getChildren();
    assert.strictEqual(nodes[0]!.label, '.NET Processes (1)');
  });
});

suite('Profiler — ProfilerTreeProvider onDidChangeTreeData', () => {
  test('addSession fires the change event with undefined (root refresh)', () => {
    const provider = new ProfilerTreeProvider();
    let fired = 0;
    let lastArg: ProfilerTreeItem | undefined = new ProfilerTreeItem(
      'x',
      'header',
      vscode.TreeItemCollapsibleState.None,
    );
    const sub = provider.onDidChangeTreeData((arg) => {
      fired += 1;
      lastArg = arg;
    });
    provider.addSession('s', 'Trace', 1);
    sub.dispose();
    assert.strictEqual(fired, 1);
    assert.strictEqual(lastArg, undefined);
  });

  test('removeSession fires the change event', () => {
    const provider = new ProfilerTreeProvider();
    provider.addSession('s', 'Trace', 1);
    let fired = 0;
    const sub = provider.onDidChangeTreeData(() => {
      fired += 1;
    });
    provider.removeSession('s');
    sub.dispose();
    assert.strictEqual(fired, 1);
  });

  test('refresh() fires the change event once it completes', async () => {
    const provider = new ProfilerTreeProvider();
    provider.setClient(processListClient([PROC_A]));
    let fired = 0;
    const sub = provider.onDidChangeTreeData(() => {
      fired += 1;
    });
    await provider.refresh();
    sub.dispose();
    assert.strictEqual(fired, 1);
  });

  test('a no-client refresh() does not fire the change event', async () => {
    const provider = new ProfilerTreeProvider();
    let fired = 0;
    const sub = provider.onDidChangeTreeData(() => {
      fired += 1;
    });
    await provider.refresh();
    sub.dispose();
    assert.strictEqual(fired, 0);
  });
});

// ── ProfilerStatusBar ─────────────────────────────────────────────
//
// The status bar wraps a real vscode StatusBarItem (the test host supports
// createStatusBarItem). We only need a context with a `subscriptions` array.

function statusBarContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as vscode.Disposable[],
  } as unknown as vscode.ExtensionContext;
}

suite('Profiler — ProfilerStatusBar', () => {
  test('construction registers the item as a context subscription', () => {
    const ctx = statusBarContext();
    const bar = new ProfilerStatusBar(ctx);
    assert.ok(bar instanceof ProfilerStatusBar);
    // The constructor pushes its StatusBarItem onto subscriptions.
    assert.strictEqual(ctx.subscriptions.length, 1);
    assert.ok(typeof ctx.subscriptions[0]!.dispose === 'function');
    ctx.subscriptions[0]!.dispose();
  });

  test('update(0) hides the item without throwing', () => {
    const ctx = statusBarContext();
    const bar = new ProfilerStatusBar(ctx);
    assert.doesNotThrow(() => {
      bar.update(0);
    });
    ctx.subscriptions[0]!.dispose();
  });

  test('update(n>0) shows a session count without throwing', () => {
    const ctx = statusBarContext();
    const bar = new ProfilerStatusBar(ctx);
    assert.doesNotThrow(() => {
      bar.update(1);
      bar.update(5);
    });
    ctx.subscriptions[0]!.dispose();
  });

  test('toggling between visible and hidden states is safe', () => {
    const ctx = statusBarContext();
    const bar = new ProfilerStatusBar(ctx);
    assert.doesNotThrow(() => {
      bar.update(3);
      bar.update(0);
      bar.update(7);
      bar.update(0);
    });
    ctx.subscriptions[0]!.dispose();
  });

  test('the registered subscription is the underlying StatusBarItem (text/show/hide visible)', () => {
    const ctx = statusBarContext();
    const bar = new ProfilerStatusBar(ctx);
    const item = ctx.subscriptions[0] as unknown as vscode.StatusBarItem;
    // The constructor wires command + tooltip onto the same item it subscribes.
    assert.strictEqual(item.command, 'sharplsp.profiler.listProcesses');
    assert.strictEqual(item.tooltip, 'Active profiling sessions — click to list processes');
    // update(n>0) takes the `text + show()` branch.
    bar.update(2);
    assert.strictEqual(item.text, '$(pulse) 2 profiling');
    bar.update(1);
    assert.strictEqual(item.text, '$(pulse) 1 profiling');
    bar.update(137);
    assert.strictEqual(item.text, '$(pulse) 137 profiling');
    // update(0) takes the `hide()` branch and leaves the previous text untouched.
    bar.update(0);
    assert.strictEqual(item.text, '$(pulse) 137 profiling');
    item.dispose();
  });

  test('construction starts in the hidden (count 0) branch via the constructor update(0)', () => {
    const ctx = statusBarContext();
    const bar = new ProfilerStatusBar(ctx);
    const item = ctx.subscriptions[0] as unknown as vscode.StatusBarItem;
    // Constructor calls update(0): the text-setting branch never ran, so text is the default ''.
    assert.strictEqual(item.text, '');
    // First positive update flips into the visible branch.
    bar.update(1);
    assert.strictEqual(item.text, '$(pulse) 1 profiling');
    item.dispose();
  });
});

// ── formatCounterValue() — remaining numeric branches ─────────────

suite('Profiler — formatCounterValue() extra numeric branches', () => {
  test('large integer non-byte values keep locale grouping (no byte tier)', () => {
    assert.strictEqual(
      formatCounterValue(1_000_000_000, 'requests'),
      (1_000_000_000).toLocaleString(),
    );
  });

  test('a unit whose substring "byte" appears mid-word still routes to formatBytes', () => {
    assert.strictEqual(formatCounterValue(1024 * 1024, 'total-bytes-allocated'), '1.0 MB');
  });

  test('NaN is not an integer so it takes the toFixed(2) branch', () => {
    assert.strictEqual(formatCounterValue(Number.NaN, 'ratio'), 'NaN');
  });

  test('whole-number float (e.g. 5.0) is an integer and uses locale grouping', () => {
    assert.strictEqual(formatCounterValue(5.0, 'count'), (5).toLocaleString());
  });
});
