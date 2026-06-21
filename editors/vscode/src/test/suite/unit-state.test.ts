// Pure-logic tests for the centralized reactive state module (`src/state.ts`).
// These exercise the SortOrder cycle, the exported signals, and the
// loadSolution/clear/refresh state-machine transitions
// ('empty' -> 'loading'(implicit) -> 'loaded'/'error') WITHOUT a running LSP
// server: the `client` signal is stubbed with a fake LanguageClient.
import * as assert from 'node:assert/strict';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import {
  SortOrder,
  SORT_CYCLE,
  cycleSortOrder,
  client,
  solutionPath,
  sortOrder,
  symbolsState,
  loadSolution,
  clear,
  refresh,
  type WorkspaceSymbolsResponse,
  type SymbolsState,
  type ProjectNode,
  type SymbolNode,
} from '../../state.js';

// ── Test fixtures ───────────────────────────────────────────────

const SOLUTION = '/tmp/Demo.sln';

function symbol(name: string, kind: string, children: SymbolNode[] = []): SymbolNode {
  return {
    name,
    kind,
    detail: null,
    access: null,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    children,
  };
}

function project(name: string, symbols: SymbolNode[]): ProjectNode {
  return {
    name,
    path: `/tmp/${name}/${name}.csproj`,
    symbols: [{ file: `${name}.cs`, symbols }],
  };
}

function response(projects: ProjectNode[]): WorkspaceSymbolsResponse {
  return { projects };
}

/**
 * Build a fake LanguageClient stub. Only the `state` field and `sendRequest`
 * method are touched by `state.ts`, so the rest is cast away — exactly the
 * convention used by coverage-extension-workflows.test.ts.
 */
function fakeClient(
  state: State,
  sendRequest: (method: string, payload: unknown) => Promise<unknown>,
): LanguageClient {
  return { state, sendRequest } as unknown as LanguageClient;
}

/** A client that always resolves the given workspace-symbols response. */
function resolvingClient(resp: WorkspaceSymbolsResponse): LanguageClient {
  return fakeClient(State.Running, () => Promise.resolve(resp));
}

/** Reset every exported signal to its construction-time default. */
function resetSignals(): void {
  client.value = undefined;
  solutionPath.value = undefined;
  sortOrder.value = SortOrder.Alphabetical;
  symbolsState.value = { kind: 'empty' };
}

// ── SortOrder enum + SORT_CYCLE map ─────────────────────────────

suite('state — SortOrder enum & SORT_CYCLE map', () => {
  test('enum members carry their wire string values', () => {
    assert.strictEqual(SortOrder.Natural, 'natural');
    assert.strictEqual(SortOrder.Alphabetical, 'alphabetical');
    assert.strictEqual(SortOrder.Accessibility, 'accessibility');
  });

  test('there are exactly three sort orders', () => {
    const values = Object.values(SortOrder) as string[];
    assert.strictEqual(values.length, 3);
    assert.ok(values.includes('natural'));
    assert.ok(values.includes('alphabetical'));
    assert.ok(values.includes('accessibility'));
  });

  test('SORT_CYCLE maps each order to its successor', () => {
    assert.strictEqual(SORT_CYCLE[SortOrder.Natural], SortOrder.Alphabetical);
    assert.strictEqual(SORT_CYCLE[SortOrder.Alphabetical], SortOrder.Accessibility);
    assert.strictEqual(SORT_CYCLE[SortOrder.Accessibility], SortOrder.Natural);
  });

  test('SORT_CYCLE has an entry for every enum member', () => {
    assert.strictEqual(Object.keys(SORT_CYCLE).length, 3);
    for (const order of Object.values(SortOrder)) {
      assert.ok(order in SORT_CYCLE, `missing cycle entry for ${order}`);
    }
  });

  test('following SORT_CYCLE three times returns to the start (no orphans)', () => {
    const start = SortOrder.Natural;
    const one = SORT_CYCLE[start];
    const two = SORT_CYCLE[one];
    const three = SORT_CYCLE[two];
    assert.strictEqual(three, start);
    // The intermediate hops are all distinct — it is a true 3-cycle.
    assert.notStrictEqual(one, start);
    assert.notStrictEqual(two, start);
    assert.notStrictEqual(one, two);
  });
});

// ── cycleSortOrder() action ─────────────────────────────────────

suite('state — cycleSortOrder()', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('advances Alphabetical -> Accessibility', () => {
    sortOrder.value = SortOrder.Alphabetical;
    cycleSortOrder();
    assert.strictEqual(sortOrder.value, SortOrder.Accessibility);
  });

  test('advances Accessibility -> Natural', () => {
    sortOrder.value = SortOrder.Accessibility;
    cycleSortOrder();
    assert.strictEqual(sortOrder.value, SortOrder.Natural);
  });

  test('advances Natural -> Alphabetical', () => {
    sortOrder.value = SortOrder.Natural;
    cycleSortOrder();
    assert.strictEqual(sortOrder.value, SortOrder.Alphabetical);
  });

  test('three cycles return to the original value', () => {
    sortOrder.value = SortOrder.Natural;
    cycleSortOrder();
    cycleSortOrder();
    cycleSortOrder();
    assert.strictEqual(sortOrder.value, SortOrder.Natural);
  });

  test('cycling notifies signal subscribers with the next value', () => {
    sortOrder.value = SortOrder.Natural;
    const seen: SortOrder[] = [];
    const unsub = sortOrder.subscribe((v) => seen.push(v));
    try {
      cycleSortOrder();
      cycleSortOrder();
    } finally {
      unsub();
    }
    assert.deepStrictEqual(seen, [SortOrder.Alphabetical, SortOrder.Accessibility]);
  });

  test('cycling never lands on a value outside the enum', () => {
    sortOrder.value = SortOrder.Natural;
    const valid = new Set<string>(Object.values(SortOrder));
    for (let i = 0; i < 9; i++) {
      cycleSortOrder();
      assert.ok(valid.has(sortOrder.value), `escaped enum at step ${String(i)}`);
    }
  });
});

// ── Signal defaults & set/get ───────────────────────────────────

suite('state — exported signals', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('client defaults to undefined and round-trips a stub', () => {
    assert.strictEqual(client.value, undefined);
    const stub = resolvingClient(response([]));
    client.value = stub;
    assert.strictEqual(client.value, stub);
  });

  test('solutionPath defaults to undefined and round-trips a path', () => {
    assert.strictEqual(solutionPath.value, undefined);
    solutionPath.value = SOLUTION;
    assert.strictEqual(solutionPath.value, SOLUTION);
  });

  test('sortOrder defaults to Alphabetical', () => {
    assert.strictEqual(sortOrder.value, SortOrder.Alphabetical);
  });

  test('symbolsState defaults to the empty discriminant', () => {
    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });

  test('symbolsState round-trips a loaded discriminant', () => {
    const resp = response([project('A', [symbol('Foo', 'class')])]);
    symbolsState.value = { kind: 'loaded', response: resp };
    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'loaded');
    if (current.kind === 'loaded') {
      assert.strictEqual(current.response, resp);
      assert.strictEqual(current.response.projects.length, 1);
    }
  });

  test('symbolsState round-trips an error discriminant', () => {
    symbolsState.value = { kind: 'error', message: 'kaboom' };
    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'error');
    if (current.kind === 'error') {
      assert.strictEqual(current.message, 'kaboom');
    }
  });

  test('setting symbolsState to a new object reference notifies subscribers', () => {
    let notified = 0;
    const unsub = symbolsState.subscribe(() => {
      notified += 1;
    });
    try {
      symbolsState.value = { kind: 'error', message: 'one' };
      symbolsState.value = { kind: 'empty' };
    } finally {
      unsub();
    }
    assert.strictEqual(notified, 2);
  });

  test('setting solutionPath to the identical primitive does NOT re-notify (Object.is)', () => {
    solutionPath.value = SOLUTION;
    let notified = 0;
    const unsub = solutionPath.subscribe(() => {
      notified += 1;
    });
    try {
      solutionPath.value = SOLUTION; // identical string => no-op
    } finally {
      unsub();
    }
    assert.strictEqual(notified, 0);
  });
});

// ── clear() ─────────────────────────────────────────────────────

suite('state — clear()', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('resets solutionPath to undefined', () => {
    solutionPath.value = SOLUTION;
    clear();
    assert.strictEqual(solutionPath.value, undefined);
  });

  test('resets symbolsState to empty', () => {
    symbolsState.value = { kind: 'error', message: 'stale' };
    clear();
    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });

  test('does not touch the client signal', () => {
    const stub = resolvingClient(response([]));
    client.value = stub;
    clear();
    assert.strictEqual(client.value, stub);
  });

  test('does not touch the sortOrder signal', () => {
    sortOrder.value = SortOrder.Accessibility;
    clear();
    assert.strictEqual(sortOrder.value, SortOrder.Accessibility);
  });

  test('is idempotent — calling twice keeps state empty', () => {
    solutionPath.value = SOLUTION;
    clear();
    clear();
    assert.strictEqual(solutionPath.value, undefined);
    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });
});

// ── refresh() — guard branch (no client / no solution) ──────────

suite('state — refresh() guards', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('with no client and no solution sets empty', async () => {
    symbolsState.value = { kind: 'error', message: 'stale' };
    await refresh();
    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });

  test('with a client but no solution sets empty', async () => {
    client.value = resolvingClient(response([project('A', [])]));
    solutionPath.value = undefined;
    symbolsState.value = { kind: 'error', message: 'stale' };
    await refresh();
    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });

  test('with a solution but no client sets empty', async () => {
    client.value = undefined;
    solutionPath.value = SOLUTION;
    symbolsState.value = { kind: 'error', message: 'stale' };
    await refresh();
    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });

  test('guard branch never invokes sendRequest', async () => {
    let called = false;
    client.value = fakeClient(State.Running, () => {
      called = true;
      return Promise.resolve(response([]));
    });
    solutionPath.value = undefined; // missing solution trips the guard
    await refresh();
    assert.strictEqual(called, false);
  });
});

// ── refresh() — happy path (loaded) ─────────────────────────────

suite('state — refresh() loaded path', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('a running client resolving symbols sets loaded with that response', async () => {
    const resp = response([
      project('Core', [symbol('Widget', 'class'), symbol('IGadget', 'interface')]),
    ]);
    client.value = resolvingClient(resp);
    solutionPath.value = SOLUTION;

    await refresh();

    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'loaded');
    if (current.kind === 'loaded') {
      assert.strictEqual(current.response, resp);
      assert.strictEqual(current.response.projects.length, 1);
      assert.strictEqual(current.response.projects[0]?.name, 'Core');
      assert.strictEqual(current.response.projects[0]?.symbols[0]?.symbols.length, 2);
    }
  });

  test('forwards the solution path in the request payload to the correct method', async () => {
    let seenMethod: string | undefined;
    let seenPayload: unknown;
    client.value = fakeClient(State.Running, (method, payload) => {
      seenMethod = method;
      seenPayload = payload;
      return Promise.resolve(response([]));
    });
    solutionPath.value = SOLUTION;

    await refresh();

    assert.strictEqual(seenMethod, 'sharplsp/workspaceSymbols');
    assert.deepStrictEqual(seenPayload, { solution: SOLUTION });
  });

  test('an empty projects array still loads (zero symbols logged)', async () => {
    client.value = resolvingClient(response([]));
    solutionPath.value = SOLUTION;

    await refresh();

    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'loaded');
    if (current.kind === 'loaded') {
      assert.strictEqual(current.response.projects.length, 0);
    }
  });

  test('logSymbolCounts traverses nested files and children without throwing', async () => {
    const resp = response([
      project('A', [symbol('Outer', 'class', [symbol('Inner', 'method')])]),
      project('B', [symbol('Other', 'enum')]),
    ]);
    client.value = resolvingClient(resp);
    solutionPath.value = SOLUTION;

    await refresh();

    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'loaded');
    if (current.kind === 'loaded') {
      assert.strictEqual(current.response.projects.length, 2);
    }
  });

  test('refresh overwrites a prior error state with loaded', async () => {
    symbolsState.value = { kind: 'error', message: 'previous failure' };
    client.value = resolvingClient(response([project('Z', [])]));
    solutionPath.value = SOLUTION;

    await refresh();

    assert.strictEqual(symbolsState.value.kind, 'loaded');
  });

  test('subscribers observe the transition into the loaded state', async () => {
    const transitions: SymbolsState['kind'][] = [];
    const unsub = symbolsState.subscribe((s) => transitions.push(s.kind));
    client.value = resolvingClient(response([]));
    solutionPath.value = SOLUTION;
    try {
      await refresh();
    } finally {
      unsub();
    }
    assert.ok(transitions.includes('loaded'));
  });
});

// ── refresh() — error path (non-transient) ──────────────────────

suite('state — refresh() error path', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('a thrown Error becomes an error state carrying its message', async () => {
    client.value = fakeClient(State.Running, () => Promise.reject(new Error('roslyn exploded')));
    solutionPath.value = SOLUTION;

    await refresh();

    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'error');
    if (current.kind === 'error') {
      assert.strictEqual(current.message, 'roslyn exploded');
    }
  });

  test('a non-Error rejection is stringified into the error message', async () => {
    client.value = fakeClient(State.Running, () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentional non-Error rejection: this test pins getErrorMessage's handling of non-Error throwables
      Promise.reject('plain string failure'),
    );
    solutionPath.value = SOLUTION;

    await refresh();

    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'error');
    if (current.kind === 'error') {
      assert.strictEqual(current.message, 'plain string failure');
    }
  });

  test('a non-transient error does NOT retry (sendRequest called exactly once)', async () => {
    let calls = 0;
    client.value = fakeClient(State.Running, () => {
      calls += 1;
      return Promise.reject(new Error('hard failure'));
    });
    solutionPath.value = SOLUTION;

    await refresh();

    assert.strictEqual(calls, 1);
    assert.strictEqual(symbolsState.value.kind, 'error');
  });

  test('error message containing "<&>" special chars is preserved verbatim', async () => {
    const raw = 'bad <tag> & "quote" failed';
    client.value = fakeClient(State.Running, () => Promise.reject(new Error(raw)));
    solutionPath.value = SOLUTION;

    await refresh();

    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'error');
    if (current.kind === 'error') {
      assert.strictEqual(current.message, raw);
    }
  });

  test('subscribers observe the transition into the error state', async () => {
    const transitions: SymbolsState['kind'][] = [];
    const unsub = symbolsState.subscribe((s) => transitions.push(s.kind));
    client.value = fakeClient(State.Running, () => Promise.reject(new Error('nope')));
    solutionPath.value = SOLUTION;
    try {
      await refresh();
    } finally {
      unsub();
    }
    assert.ok(transitions.includes('error'));
  });
});

// ── refresh() — retry / transient behavior ──────────────────────
// These drive the retry loop (RETRY_DELAY_MS = 2000ms each). Bounded so the
// slowest case is a single delay window, comfortably under the 60s timeout.

suite('state — refresh() retry behavior', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('a transient "connection" error retries then succeeds on the next attempt', async function () {
    this.timeout(15_000);
    let calls = 0;
    const resp = response([project('Recovered', [])]);
    client.value = fakeClient(State.Running, () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error('lost connection to server'));
      }
      return Promise.resolve(resp);
    });
    solutionPath.value = SOLUTION;

    await refresh();

    assert.strictEqual(calls, 2, 'should retry exactly once after the transient failure');
    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'loaded');
    if (current.kind === 'loaded') {
      assert.strictEqual(current.response, resp);
    }
  });

  test('a transient "disposed" error also triggers a retry', async function () {
    this.timeout(15_000);
    let calls = 0;
    client.value = fakeClient(State.Running, () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error('client was disposed'));
      }
      return Promise.resolve(response([]));
    });
    solutionPath.value = SOLUTION;

    await refresh();

    assert.strictEqual(calls, 2);
    assert.strictEqual(symbolsState.value.kind, 'loaded');
  });
});

// ── loadSolution() ──────────────────────────────────────────────

suite('state — loadSolution()', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('stores the supplied path on the solutionPath signal', async () => {
    client.value = resolvingClient(response([]));
    await loadSolution(SOLUTION);
    assert.strictEqual(solutionPath.value, SOLUTION);
  });

  test('with a running client ends in the loaded state', async () => {
    const resp = response([project('Loaded', [symbol('Thing', 'struct')])]);
    client.value = resolvingClient(resp);

    await loadSolution(SOLUTION);

    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'loaded');
    if (current.kind === 'loaded') {
      assert.strictEqual(current.response.projects[0]?.name, 'Loaded');
    }
  });

  test('with no client falls through the refresh guard to empty', async () => {
    client.value = undefined;
    symbolsState.value = { kind: 'error', message: 'stale' };

    await loadSolution(SOLUTION);

    // The path is still recorded even though the refresh found no client.
    assert.strictEqual(solutionPath.value, SOLUTION);
    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });

  test('propagates a hard failure into the error state', async () => {
    client.value = fakeClient(State.Running, () => Promise.reject(new Error('load blew up')));

    await loadSolution(SOLUTION);

    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'error');
    if (current.kind === 'error') {
      assert.strictEqual(current.message, 'load blew up');
    }
  });

  test('loading a second solution overwrites the first path and re-fetches', async () => {
    const first = response([project('First', [])]);
    const second = response([project('Second', [])]);
    let target = first;
    client.value = fakeClient(State.Running, () => Promise.resolve(target));

    await loadSolution('/tmp/First.sln');
    assert.strictEqual(solutionPath.value, '/tmp/First.sln');

    target = second;
    await loadSolution('/tmp/Second.sln');
    assert.strictEqual(solutionPath.value, '/tmp/Second.sln');
    const current = symbolsState.value;
    assert.strictEqual(current.kind, 'loaded');
    if (current.kind === 'loaded') {
      assert.strictEqual(current.response.projects[0]?.name, 'Second');
    }
  });
});

// ── End-to-end signal lifecycle: load then clear ────────────────

suite('state — load then clear lifecycle', () => {
  setup(resetSignals);
  teardown(resetSignals);

  test('loaded state is wiped back to empty by clear()', async () => {
    client.value = resolvingClient(response([project('Live', [symbol('A', 'class')])]));
    await loadSolution(SOLUTION);
    assert.strictEqual(symbolsState.value.kind, 'loaded');

    clear();

    assert.strictEqual(solutionPath.value, undefined);
    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });

  test('after clear, refresh re-enters the guard and stays empty', async () => {
    client.value = resolvingClient(response([project('Live', [])]));
    await loadSolution(SOLUTION);
    clear();

    await refresh();

    assert.deepStrictEqual(symbolsState.value, { kind: 'empty' });
  });
});
