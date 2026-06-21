// Pure-logic unit tests for the Profiler module's own formatting + tree-node
// builders. These mirror (but are SEPARATE copies from) profiler-diff.ts; they
// assert profiler.ts's OWN bodies. No LSP server, no commands, no webview host —
// only the exported pure functions are exercised directly.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  formatBytes,
  formatDuration,
  formatCounterValue,
  escapeHtml,
  buildCounterHtml,
  buildSessionNode,
  buildProcessNode,
  ProfilerTreeItem,
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
