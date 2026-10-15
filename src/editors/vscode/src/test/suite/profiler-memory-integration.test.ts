// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]: Basilisk's profiler-memory-integration
// suite on SharpLsp's live extension and server.
//
// Lifecycle refusals over the real wire, the memory commands' registration and
// manifest entries, status bar and configuration contracts, the decoration
// ledgers on a real editor, and coexistence with the rest of the language
// server. Basilisk's hollow cases (`assert.ok(true)` after a swallowed error,
// type literals read back) assert what the user sees instead.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  applyProfileDecorations,
  appliedProfileDecorations,
  clearProfileDecorations,
  disposeProfileDecorations,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-decorations';
import {
  applyLeakDecorations,
  applyMemoryDecorations,
  appliedMemoryDecorations,
  clearMemoryDecorations,
  confidenceRank,
  disposeMemoryDecorations,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-decorations';
import { memoryDashboardState } from '@nimblesite/lsp-profiler-ui/out/src/memory-dashboard';
import { refGraphState } from '@nimblesite/lsp-profiler-ui/out/src/memory-ref-graph';
import { executeError } from './profiler-kit';
import {
  EXTENSION_ID,
  DECORATED_SOURCE,
  advertisedServerCommands,
  assertMentions,
  captureWarnings,
  getStore,
  isRegistered,
  memoryDiff,
  memorySnapshot,
  openSourceFile,
  pollUntilResult,
  profileResult,
  rejectionOf,
  runCommand,
  sessionsOf,
  suspectedLeak,
  useLspSuite,
} from './profiler-ui-helpers';
import {
  MEMORY_CLIENT_COMMANDS,
  PROFILER_CLIENT_COMMANDS,
  PROFILER_SERVER_COMMANDS,
} from './profiler-ui-constants';
import { manifestCommands, manifestConfigurationProperties } from './profiler-ui-manifest';

const CPU = (name: string): string => `sharplsp.lspProfiler.cpu.${name}`;
const UI = (name: string): string => `sharplsp.profiler.${name}`;
const PROCESS_NEEDLES = [
  'invalid pid',
  'not found',
  'Process',
  '-32001',
  'denied',
  'attach',
  'failed',
  'error',
];
const SESSION_NEEDLES = ['session', 'not found', 'No active'];

function clearDecorations(): void {
  clearProfileDecorations();
  clearMemoryDecorations();
}

async function listSessions(what: string): Promise<unknown[]> {
  return sessionsOf(await runCommand(CPU('list')), what);
}

function assertClientRunning(why: string): void {
  const store = getStore();
  assert.ok(
    store.client.value?.isRunning() === true,
    `${why}, got: ${String(store.client.value?.state)}`,
  );
}

/** Open the decorated C# source and return its path. */
async function decoratedFile(dir: string, name: string): Promise<string> {
  return (await openSourceFile(dir, name, DECORATED_SOURCE)).uri.fsPath;
}

suite('Profiler — Start/Stop Lifecycle', () => {
  useLspSuite('profiler-lc-');

  test('profiler.start rejects invalid PID', async () => {
    assertMentions(await rejectionOf(CPU('start'), { pid: 0 }), PROCESS_NEEDLES, 'PID 0');
  });

  test('profiler.stop rejects unknown session ID', async () => {
    const message = await rejectionOf(CPU('stop'), { session_id: 'nonexistent-session-id' });
    assertMentions(message, SESSION_NEEDLES, 'unknown session');
  });

  test('profiler.snapshot rejects unknown session ID', async () => {
    const message = await rejectionOf(CPU('snapshot'), { session_id: 'nonexistent-session-id' });
    assertMentions(message, SESSION_NEEDLES, 'unknown session');
  });

  test('profiler.list returns array structure', async () => {
    await listSessions('Result should have sessions array');
  });

  test('profiler.start with no PID and no debug session gives clear error', async () => {
    assert.ok((await rejectionOf(CPU('start'), {})).length > 0, 'an error message, not empty');
  });

  test('profiler.stop with missing sessionId gives clear error', async () => {
    const message = await rejectionOf(CPU('stop'), {});
    assertMentions(message, ['session_id', 'session', 'required', 'missing'], 'missing session');
  });

  test('consecutive profiler.list calls return consistent empty results', async () => {
    const first = await listSessions('First call sessions should be array');
    const second = await listSessions('Second call sessions should be array');
    assert.equal(first.length, second.length, 'consecutive list calls return the same count');
  });
});

suite('Memory Profiler — Command Registration', () => {
  useLspSuite('memory-cmd-');

  test('all memory client commands are registered', () => {
    for (const cmd of MEMORY_CLIENT_COMMANDS) {
      assert.ok(isRegistered(cmd), `Memory command "${cmd}" must be registered after activation`);
    }
  });

  test('memory commands appear in package.json commands section', () => {
    const ids = manifestCommands().map((c) => c.command);
    for (const cmd of MEMORY_CLIENT_COMMANDS) {
      assert.ok(ids.includes(cmd), `"${cmd}" must be in contributes.commands`);
    }
  });

  test('memory commands have titles and categories', () => {
    for (const cmd of MEMORY_CLIENT_COMMANDS) {
      const entry = manifestCommands().find((c) => c.command === cmd);
      assert.ok(entry && entry.title.length > 0, `"${cmd}" must have a non-empty title`);
      assert.equal(entry.category, 'SharpLsp', `"${cmd}" must have category "SharpLsp"`);
    }
  });

  test('memory and profiler commands do not overlap', () => {
    const memory = new Set<string>(MEMORY_CLIENT_COMMANDS);
    assert.deepEqual(
      PROFILER_CLIENT_COMMANDS.filter((cmd) => memory.has(cmd)),
      [],
      'no command is both a profiler and a memory command',
    );
  });

  test('all profiler and memory commands are distinct from each other', () => {
    const all = [
      ...PROFILER_CLIENT_COMMANDS,
      ...MEMORY_CLIENT_COMMANDS,
      ...PROFILER_SERVER_COMMANDS,
    ];
    assert.equal(new Set(all).size, all.length, 'every profiler and memory command is unique');
  });
});

suite('Profiler — Lifecycle Interaction', () => {
  useLspSuite('profiler-lifecycle-');

  test('profiler.start with PID 0 returns error with actionable info', async () => {
    const message = await rejectionOf(CPU('start'), { pid: 0 });
    assert.ok(message.length > 10, `the error must be descriptive: "${message}"`);
    assert.ok(!message.includes('at Object.'), `not a stack trace: ${message}`);
  });

  test('profiler.start with negative PID returns error', async () => {
    const message = await rejectionOf(CPU('start'), { pid: -1 });
    assert.ok(message.length > 0 && !message.startsWith('undefined'), `a real message: ${message}`);
  });

  test('profiler.start with extremely large PID returns error', async () => {
    assertMentions(
      await rejectionOf(CPU('start'), { pid: 999_999_999 }),
      PROCESS_NEEDLES,
      'huge PID',
    );
  });

  test('profiler.stop without active session returns clear error', async () => {
    const message = await rejectionOf(CPU('stop'), {
      session_id: 'definitely-not-a-real-session-id-abc123',
    });
    assertMentions(message, SESSION_NEEDLES, 'stop without a session');
  });

  test('profiler.snapshot without active session returns clear error', async () => {
    const message = await rejectionOf(CPU('snapshot'), {
      session_id: 'no-such-snapshot-session-xyz789',
    });
    assertMentions(message, SESSION_NEEDLES, 'snapshot without a session');
    assert.ok(!message.includes('Cannot read properties of'), 'not a null-pointer error');
  });

  test('profiler.list returns empty array when nothing is running', async () => {
    assert.equal((await listSessions('sessions should be an array')).length, 0);
  });
});

suite('Profiler — Lifecycle Interaction (Continued)', () => {
  useLspSuite('profiler-lifecycle2-');

  test('error messages from profiler do not contain raw stack traces', async () => {
    const messages = [
      await rejectionOf(CPU('start'), { pid: 0 }),
      await rejectionOf(CPU('stop'), { session_id: 'fake' }),
      await rejectionOf(CPU('snapshot'), { session_id: 'fake' }),
    ];
    for (const message of messages) {
      const frames = message.split('\n').filter((line) => line.trim().startsWith('at ')).length;
      assert.ok(frames < 3, `no full stack traces: ${message.slice(0, 200)}`);
    }
  });

  test('multiple rapid profiler.list calls do not crash or diverge', async () => {
    const results = await Promise.all([1, 2, 3].map(async () => listSessions('sessions array')));
    assert.deepEqual(
      results.map((sessions) => sessions.length),
      [0, 0, 0],
      'every parallel list call returns no sessions',
    );
  });
});

suite('Profiler — Status Bar Behavior', () => {
  useLspSuite('profiler-sb2-');

  test('status bar item exists after extension activation', () => {
    assertClientRunning('the language client must be running');
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
  });

  test('profiler status bar stop command is declared in package.json', () => {
    const stop = manifestCommands().find((c) => c.command === UI('profileStop'));
    assert.ok(stop && stop.title.length > 0, 'profileStop must be declared with a title');
  });

  test('profiler status bar priority is declared correctly for ordering', () => {
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
    assert.ok(getStore().client.value !== undefined, 'the status bars bind to a live client');
  });
});

suite('Profiler — Configuration Interaction', () => {
  useLspSuite('profiler-cfgi-');

  function presetEnum(): string[] {
    const preset = manifestConfigurationProperties()['sharplsp.profiler.preset'] as
      { enum?: string[]; type?: string } | undefined;
    assert.ok(preset && Array.isArray(preset.enum), 'the preset setting declares its enum');
    assert.equal(preset.type, 'string', 'preset is a string setting');
    return preset.enum;
  }

  test('changing sampleRate config is reflected in workspace config', async () => {
    const config = (): vscode.WorkspaceConfiguration =>
      vscode.workspace.getConfiguration('sharplsp.profiler');
    assert.equal(config().get<number>('sampleRate'), 100, 'default sampleRate is 100');
    await config().update('sampleRate', 50, vscode.ConfigurationTarget.Workspace);
    assert.equal(config().get<number>('sampleRate'), 50, 'sampleRate updates to 50');
    await config().update('sampleRate', undefined, vscode.ConfigurationTarget.Workspace);
    assert.equal(config().get<number>('sampleRate'), 100, 'sampleRate restores to 100');
  });

  test('quick preset is offered for short burst profiling', () => {
    assert.ok(presetEnum().includes('quick'), 'quick must be a valid preset');
  });

  test('detailed preset is offered and includeNative defaults off', () => {
    assert.ok(presetEnum().includes('detailed'), 'detailed must be a valid preset');
    assert.equal(
      vscode.workspace.getConfiguration('sharplsp.profiler').get<boolean>('includeNative'),
      false,
    );
  });

  test('all 4 presets are exactly the ones the server parses', () => {
    assert.deepEqual(
      [...presetEnum()].sort(),
      ['default', 'detailed', 'longRunning', 'quick'],
      'advertised presets must match the server parser exactly',
    );
  });

  test('numeric settings have reasonable bounds in config declarations', () => {
    const properties = manifestConfigurationProperties();
    for (const key of ['sampleRate', 'lineThreshold', 'maxDiagnosticsPerFile']) {
      const fallback = properties[`sharplsp.profiler.${key}`]?.default;
      assert.ok(typeof fallback === 'number' && fallback > 0, `${key} has a positive default`);
    }
  });
});

suite('Memory Profiler — Extended', () => {
  const tmpDir = useLspSuite('memory-ext-', clearMemoryDecorations);

  test('memoryStart command is callable and returns without crash', async () => {
    const warnings = await captureWarnings(async () =>
      vscode.commands.executeCommand(UI('memoryStart')),
    );
    assert.equal(getStore().profiler.value.memory, 'idle', 'no target, so nothing is tracked');
    assert.ok(
      warnings.some((warning) => warning.includes('Pick a process')),
      `with no target the user is told how to pick one: ${JSON.stringify(warnings)}`,
    );
  });

  test('memorySnapshot without active session warns gracefully', async () => {
    const dashboard = memoryDashboardState();
    await vscode.commands.executeCommand(UI('memorySnapshot'));
    assert.equal(getStore().profiler.value.memory, 'idle');
    assert.deepEqual(memoryDashboardState(), dashboard, 'no dashboard opens without a session');
  });

  test('memoryReferences command is callable', async () => {
    const graph = refGraphState();
    await vscode.commands.executeCommand(UI('memoryReferences'));
    assert.deepEqual(refGraphState(), graph, 'no retention graph opens without a session');
    assertClientRunning('the client survives the call');
  });

  test('MemoryAllocation type enforces required fields', async () => {
    const file = await decoratedFile(tmpDir(), 'Allocator.cs');
    applyMemoryDecorations(
      memorySnapshot({ topAllocations: [{ file, line: 5, size: 52_428_800, count: 10_000 }] }),
    );
    const [painted] = appliedMemoryDecorations();
    assert.equal(painted?.line, 5, 'the allocation lands on its line');
    assert.ok(
      painted.contentText.includes('50.0 MB allocated (10000 objects)'),
      painted.contentText,
    );
  });

  test('leak confidence levels map to correct severity ordering', () => {
    const ranks = (['LOW', 'MEDIUM', 'HIGH', 'DEFINITE'] as const).map(confidenceRank);
    assert.deepEqual(
      ranks,
      [...ranks].sort((a, b) => a - b),
      'LOW < MEDIUM < HIGH < DEFINITE',
    );
    assert.equal(new Set(ranks).size, 4, 'four distinct severities');
  });

  test('SuspectedLeak type has all required fields', async () => {
    const file = await decoratedFile(tmpDir(), 'Leaky.cs');
    applyLeakDecorations(
      memoryDiff([suspectedLeak(file, 7, { sizeGrowth: 1_048_576, countGrowth: 500 })]),
    );
    const [painted] = appliedMemoryDecorations();
    assert.equal(painted?.line, 7);
    assert.ok(painted.contentText.includes('HIGH +1.0 MB leak (500 objects)'), painted.contentText);
  });
});

suite('Memory Profiler — Types and Decorations', () => {
  const tmpDir = useLspSuite('memory-ext2-', clearMemoryDecorations);

  test('MemoryDiffResult type has all required fields', async () => {
    const file = await decoratedFile(tmpDir(), 'Data.cs');
    applyLeakDecorations(memoryDiff([suspectedLeak(file, 10, { confidence: 'DEFINITE' })]));
    const [painted] = appliedMemoryDecorations();
    assert.equal(painted?.color, '#ef4444', 'a definite leak is red');
    assert.ok(painted.contentText.includes('DEFINITE'), painted.contentText);
  });

  test('applyMemoryDecorations with populated allocations does not throw', async () => {
    const file = await decoratedFile(tmpDir(), 'MemAlloc.cs');
    applyMemoryDecorations(
      memorySnapshot({
        topAllocations: [
          { file, line: 1, size: 52_428_800, count: 5000 },
          { file: '/nonexistent/B.cs', line: 15, size: 10_485_760, count: 1000 },
          { file, line: 3, size: 1_048_576, count: 100 },
        ],
      }),
    );
    assert.deepEqual(
      appliedMemoryDecorations().map((entry) => [entry.line, entry.color]),
      [
        [1, '#a78bfa'],
        [3, '#8b5cf6'],
      ],
      'only the open file is painted, coloured by size',
    );
  });

  test('applyLeakDecorations with suspected leaks does not throw', async () => {
    const file = await decoratedFile(tmpDir(), 'LeakTest.cs');
    applyLeakDecorations(
      memoryDiff([suspectedLeak(file, 3), suspectedLeak('/nonexistent/Leaky.cs', 3)]),
    );
    assert.deepEqual(
      appliedMemoryDecorations().map((entry) => [entry.line, entry.color]),
      [[3, '#f87171']],
      'the open file wears the HIGH leak badge; the missing one paints nothing',
    );
  });
});

suite('Profiler — Error Handling', () => {
  useLspSuite('profiler-err-');

  test('profiler.start with invalid params returns error code or message', async () => {
    const message = await rejectionOf(CPU('start'), { pid: 0, sample_rate: -1 });
    assert.ok(!message.includes('command not found'), `about the params: ${message}`);
    assert.ok(!message.includes('is not registered'), `about the params: ${message}`);
  });

  test('profiler error codes are within expected range', async () => {
    const codes = [
      (await executeError('cpu.start', { pid: 999_999 }))?.code,
      (await executeError('cpu.start', { pid: process.pid }))?.code,
      (await executeError('cpu.stop', { session_id: 'nope' }))?.code,
    ];
    assert.deepEqual(codes, [-32001, -32002, -32000], 'not found, unsupported runtime, session');
    for (const code of codes) {
      assert.ok(code !== undefined && code <= -32000 && code >= -32099, `${code} is a server code`);
    }
  });

  test('profiler.stop with empty string sessionId returns descriptive error', async () => {
    const message = await rejectionOf(CPU('stop'), { session_id: '' });
    assert.ok(message.length > 0 && !/panic/i.test(message), `not a panic: ${message}`);
  });

  test('profiler.snapshot with null-like args returns error gracefully', async () => {
    const message = await rejectionOf(CPU('snapshot'), { session_id: null });
    assert.ok(message.length > 0 && !/segfault|SIGSEGV/.test(message), `not a crash: ${message}`);
  });

  test('connection errors are handled when LSP client is present', async () => {
    const message = await rejectionOf(CPU('start'), { pid: 2_147_483_647 });
    assert.ok(!/ECONNREFUSED|ECONNRESET/.test(message), `protocol-level, not network: ${message}`);
    assert.ok(!message.includes('undefined'), `no "undefined" in the message: ${message}`);
  });

  test('error messages are user-friendly strings, not JSON blobs', async () => {
    const message = await rejectionOf(CPU('stop'), { session_id: 'nonexistent-for-ux-check' });
    assert.ok(!message.trimStart().startsWith('{'), `human-readable: ${message.slice(0, 200)}`);
    assert.ok(message.length < 2000, 'not excessively long');
  });
});

suite('Profiler — Cross-Feature Integration', () => {
  const tmpDir = useLspSuite('profiler-xfeat-', clearDecorations);

  test('profiler commands do not interfere with document symbol provider', async function () {
    this.timeout(90_000);
    const { uri } = await openSourceFile(
      tmpDir(),
      'SymbolsTest.cs',
      'class Foo\n{\n    void Hello() { }\n}\n',
    );
    await listSessions('profiler.list should work');
    const symbols = await pollUntilResult({
      fn: async () =>
        vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
          'vscode.executeDocumentSymbolProvider',
          uri,
        ),
      until: (found) => (found?.length ?? 0) >= 1,
      timeoutMs: 80_000,
      description: 'document symbols of SymbolsTest.cs',
    });
    assert.equal(symbols?.[0]?.name, 'Foo', 'document symbols still work after profiler commands');
  });

  test('profiler.list is idempotent and does not corrupt LSP state', async () => {
    for (let iteration = 0; iteration < 5; iteration++) {
      await listSessions(`Iteration ${iteration}: sessions should be an array`);
    }
    assertClientRunning('the client survives repeated list calls');
  });

  test('multiple quick start/stop error cycles do not crash', async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      await rejectionOf(CPU('start'), { pid: 0 });
      await rejectionOf(CPU('stop'), { session_id: `fake-session-cycle-${cycle}` });
    }
    assertClientRunning('the client survives the error cycles');
    await listSessions('profiler.list still works after error cycles');
  });
});

suite('Profiler — Coexistence and Disposal', () => {
  const tmpDir = useLspSuite('profiler-xfeat2-', clearDecorations);

  test('profiler decorations and memory decorations can coexist', async () => {
    const file = await decoratedFile(tmpDir(), 'Coexist.cs');
    applyProfileDecorations(
      profileResult({ hotLines: [{ file, line: 1, samples: 50, percentage: 50 }] }),
    );
    applyMemoryDecorations(
      memorySnapshot({ topAllocations: [{ file, line: 2, size: 524_288, count: 100 }] }),
    );
    assert.deepEqual(
      appliedProfileDecorations().map((entry) => entry.line),
      [1],
    );
    assert.deepEqual(
      appliedMemoryDecorations().map((entry) => entry.line),
      [2],
    );
    clearProfileDecorations();
    assert.deepEqual(
      appliedMemoryDecorations().map((entry) => entry.line),
      [2],
      'independent',
    );
    clearMemoryDecorations();
    assert.deepEqual(appliedMemoryDecorations(), []);
  });

  test('profiler commands exist alongside non-profiler commands', () => {
    const advertised = advertisedServerCommands();
    assert.ok(advertised.size > PROFILER_SERVER_COMMANDS.length, 'SharpLsp advertises its own too');
    for (const cmd of PROFILER_SERVER_COMMANDS) {
      assert.ok(advertised.has(cmd), `"${cmd}" is advertised beside the others`);
    }
  });

  test('dispose functions are idempotent and safe to call multiple times', async () => {
    disposeProfileDecorations();
    disposeProfileDecorations();
    disposeMemoryDecorations();
    disposeMemoryDecorations();
    const file = await decoratedFile(tmpDir(), 'Disposed.cs');
    applyProfileDecorations(
      profileResult({ hotLines: [{ file, line: 4, samples: 50, percentage: 50 }] }),
    );
    assert.deepEqual(
      appliedProfileDecorations().map((entry) => entry.line),
      [4],
      'the heat map still paints after repeated disposal',
    );
  });
});
