// Tests for [PROF-UI-PROCESSES]. See docs/specs/LSP-PROFILER-SPEC.md
//
// Component tests for the Processes panel (#62). Per CLAUDE.md these
// assert behavior through internal VSIX state — instantiate the provider, feed
// it a stubbed ProcessInfo[] via a fake LSP client, and assert getChildren()
// yields the expected sorted/grouped/filtered rows and that each row carries
// the PID a one-click profiling action needs. No getCommands()/whenCommandReady.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { type ProcessInfo } from '@nimblesite/lsp-profiler-ui/out/src/process-explorer';
import { memoryTrackRoute } from '@nimblesite/lsp-profiler-ui/out/src/process-launch';
import {
  MACHINERY,
  STUB_PROCESSES,
  type RecordedRequest,
  type Store,
  providerSlot,
  profilerStarts,
  recordedStore,
  runInlineProfile,
  runInlineTrackMemory,
  startPid,
  storeWith,
  withDecorations,
} from './process-explorer-kit';
import {
  captureWarnings,
  rowByPid,
  rowPid as pidOf,
  processFixture,
  seedSignal,
} from './profiler-ui-helpers';
import { numberField, recordArrayField } from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';

const MB = 1024 * 1024;

/** Read a group header's label (a plain string at runtime). */
function labelText(item: vscode.TreeItem): string {
  return typeof item.label === 'string' ? item.label : '';
}

// `process` and `members` are attached to the tree item by the provider under
// test and are not part of `vscode.TreeItem`. They are read back by name rather
// than asserted onto the item, so a provider that stops attaching one fails the
// assertion instead of handing the test an `undefined` it would compare away.

/** The PIDs of the members a group row carries. */
function memberPids(item: vscode.TreeItem): number[] {
  return recordArrayField(item, 'members')
    .map((member) => numberField(member, 'pid'))
    .filter((pid): pid is number => pid !== undefined);
}

// ── Display-cue helpers ([PROF-UI-PROCESSES]) ──────────────────────

/** The vscode.ThemeColor / ThemeIcon `id` a row or decoration resolves to. */
function colorId(value: { id?: string } | undefined): string | undefined {
  return value?.id;
}
function iconId(item: vscode.TreeItem): string | undefined {
  return item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : undefined;
}
function resourceUri(item: vscode.TreeItem): vscode.Uri | undefined {
  return item.resourceUri;
}
/** The row's tooltip narrowed to its string form (rowTooltip always returns one). */
function tooltipText(item: vscode.TreeItem): string {
  return typeof item.tooltip === 'string' ? item.tooltip : '';
}

/** Drop the pinned "Run & …(Current File)" launch-action rows from a root listing. */
function processRows(rows: vscode.TreeItem[]): vscode.TreeItem[] {
  return rows.filter((r) => r.contextValue !== 'launchAction');
}
/** Just the pinned launch-action rows. */
function actionRows(rows: vscode.TreeItem[]): vscode.TreeItem[] {
  return rows.filter((r) => r.contextValue === 'launchAction');
}

/** The group header labelled `version`, asserting it rendered. */
function groupOf(rows: readonly vscode.TreeItem[], version: string): vscode.TreeItem {
  const group = rows.find((g) => labelText(g) === version);
  assert.ok(group, `the ${version} group must exist`);
  return group;
}

suite('Processes Panel', () => {
  const slot = providerSlot();

  test('lists every process sorted by CPU descending by default', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    const rows = processRows(provider.getChildren());
    assert.deepStrictEqual(rows.map(pidOf), [200, 100, 300], 'CPU 42 > 5 > 1');
  });

  test('each row carries its PID so inline Profile starts with no input box', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    const rows = processRows(provider.getChildren());
    for (const row of rows) {
      assert.strictEqual(
        typeof pidOf(row),
        'number',
        'row must carry a numeric pid for the command arg',
      );
    }
    const worker = rowByPid(rows, 200, 'worker');
    assert.ok(
      String(worker.description).includes('PID 200'),
      `row description should surface the PID: ${String(worker.description)}`,
    );
  });

  test('rows needing elevation get a distinct contextValue for the lock affordance', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    const rows = provider.getChildren();
    const elevated = rowByPid(rows, 200, 'elevated');
    const normal = rowByPid(rows, 100, 'normal');
    assert.strictEqual(elevated.contextValue, 'processElevated');
    assert.strictEqual(normal.contextValue, 'process');
  });

  test('sort by memory orders rows by resident size descending', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    provider.cycleSortMode(); // cpu → memory
    const rows = processRows(provider.getChildren());
    assert.deepStrictEqual(rows.map(pidOf), [300, 100, 200], 'memory 99 > 50 > 10 MB');
  });

  test('group by runtime version buckets processes under collapsible headers', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    provider.cycleGroupMode(); // none → version
    const groups = processRows(provider.getChildren());
    assert.deepStrictEqual(
      groups.map(labelText),
      ['3.11.7', '3.12.1'],
      'groups are sorted by version label',
    );
    const twelve = groupOf(groups, '3.12.1');
    assert.strictEqual(String(twelve.description), '2', 'group shows its member count');

    const members = provider.getChildren(twelve);
    assert.deepStrictEqual(members.map(pidOf), [100, 300], 'both 3.12 processes, CPU-ordered');
  });

  test('filter narrows rows by name, script, or PID substring', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    provider.setFilter('worker');
    let rows = processRows(provider.getChildren());
    assert.deepStrictEqual(rows.map(pidOf), [200], 'only worker.py matches');

    provider.setFilter('300');
    rows = processRows(provider.getChildren());
    assert.deepStrictEqual(rows.map(pidOf), [300], 'PID substring matches');
  });

  // procexp-2: VS Code shows the "No processes running" welcome whenever
  // getChildren returns []. When a filter hides a NON-empty process list, the
  // tree must NOT be empty — it must say processes are running but filtered
  // (the pinned launch rows stay too).
  test("a filter that hides every running process shows an honest placeholder, not 'no processes' (procexp-2)", async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    provider.setFilter('nonexistent-zzz');
    const nonAction = processRows(provider.getChildren());
    assert.strictEqual(
      nonAction.length,
      1,
      'must return a placeholder row, not an empty list that triggers the welcome',
    );
    assert.strictEqual(
      nonAction[0]!.contextValue,
      'processesMessage',
      'the row is a non-process placeholder',
    );
    const label = labelText(nonAction[0]!);
    assert.ok(
      label.includes('nonexistent-zzz') && label.includes('3 running'),
      `the placeholder must explain the filter hid running processes: ${label}`,
    );
  });

  test('group members expose the full member set for the count badge', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    provider.cycleGroupMode();
    const eleven = groupOf(provider.getChildren(), '3.11.7');
    assert.deepStrictEqual(memberPids(eleven), [200]);
  });
});

// Tests for [PROF-UI-PROCESSES] issue #79: the inline flame/database
// buttons arrive with `item === undefined` at runtime and must still profile
// the row the user clicked instead of warning "Select a Python process".
suite('Processes Panel — inline launch actions (#79)', () => {
  const slot = providerSlot();

  test('rows keep a stable id across refreshes so inline buttons survive the auto-refresh', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    const beforeRow = rowByPid(provider.getChildren(), 200, 'before refresh');
    provider.refresh();
    const afterRow = rowByPid(provider.getChildren(), 200, 'after refresh');

    assert.ok(
      typeof beforeRow.id === 'string' && beforeRow.id.length > 0,
      'process rows must carry a stable TreeItem.id so VS Code can map an inline click ' +
        `back to the element after a 2s auto-refresh (#79); got: ${String(beforeRow.id)}`,
    );
    assert.strictEqual(beforeRow.id, afterRow.id, 'the id must be identical across refreshes');
  });

  test('inline Profile CPU invoked without an argument profiles the selected row', async () => {
    const { store, requests } = recordedStore();
    const provider = await slot.load(store);
    const selectedRow = rowByPid(provider.getChildren(), 200, 'PID 200');

    // VS Code passed no argument — the runtime shape of issue #79.
    await runInlineProfile(store, undefined, [selectedRow]);

    const fired = profilerStarts(requests);
    assert.strictEqual(
      fired.length,
      1,
      'clicking the inline flame button must start profiling (not warn) when a row is selected (#79)',
    );
    assert.strictEqual(startPid(fired[0]!), 200, "profiling must target the selected row's PID");
  });

  test('an explicitly passed row wins over a different selection', async () => {
    const { store, requests } = recordedStore();
    const provider = await slot.load(store);
    const rows = provider.getChildren();
    const clicked = rowByPid(rows, 300, 'clicked');
    const selected = rowByPid(rows, 200, 'selected');

    await runInlineProfile(store, clicked, [selected]);

    const fired = profilerStarts(requests);
    assert.strictEqual(fired.length, 1, 'the clicked row must be profiled');
    assert.strictEqual(startPid(fired[0]!), 300, 'the explicit item must win over the selection');
  });

  test('with no item and no selection, nothing is profiled', async () => {
    const { store, requests } = recordedStore();
    const provider = await slot.load(store);
    provider.getChildren();

    await runInlineProfile(store, undefined, []);

    assert.strictEqual(
      profilerStarts(requests).length,
      0,
      'without any resolvable target the action must not fire a profiler.start',
    );
  });
});

suite('Processes Panel — Track Memory routing', () => {
  // Tests for the memory leg of [PROF-UI-PROCESSES]: tracemalloc rides
  // the DAP courier, so the row action may only ever target the live debuggee.
  const slot = providerSlot();

  /** Drive the row's Track Memory action against PID 100 with the given session. */
  async function trackMemoryOnPid100(
    session: { id: string; type: string } | undefined,
    arrange: (store: Store) => void = () => undefined,
  ): Promise<{ requests: RecordedRequest[]; executed: string[] }> {
    const executed: string[] = [];
    const { store, requests } = recordedStore();
    arrange(store);
    const provider = await slot.load(store);
    const selectedRow = rowByPid(provider.getChildren(), 100, 'PID 100');

    await runInlineTrackMemory(store, undefined, [selectedRow], {
      runCommand: async (command) => {
        executed.push(command);
      },
      activeSession: () => session,
    });
    return { requests, executed };
  }

  test('on the live debuggee it routes to real memory tracking — never a CPU start', async () => {
    const { requests, executed } = await trackMemoryOnPid100(
      { id: 'session-1', type: 'sharplsp-coreclr' },
      (store) => {
        seedSignal(store.sessionIdToPid, new Map([['session-1', 100]]));
      },
    );

    assert.deepStrictEqual(
      executed,
      ['sharplsp.profiler.memoryStart'],
      'Track Memory on the debuggee row must start tracemalloc tracking',
    );
    assert.strictEqual(
      profilerStarts(requests).length,
      0,
      "Track Memory must NEVER start a CPU profiling session (the preset:'memory' defect)",
    );
  });

  test('on an external process it starts nothing and offers the launch flow', async () => {
    // No debug session at all — PID 100 is a foreign process.
    const { requests, executed } = await trackMemoryOnPid100(undefined);

    assert.deepStrictEqual(executed, [], 'no memory command can run against a foreign PID');
    assert.strictEqual(
      profilerStarts(requests).length,
      0,
      'an external row must not silently fall back to CPU profiling',
    );
  });

  test('memoryTrackRoute targets the debuggee only when session and PID both match', () => {
    const store = storeWith(STUB_PROCESSES);
    seedSignal(store.sessionIdToPid, new Map([['session-1', 100]]));
    const basilisk = { id: 'session-1', type: 'sharplsp-coreclr' };

    assert.strictEqual(memoryTrackRoute(store, 100, basilisk), 'start-tracking');
    assert.strictEqual(memoryTrackRoute(store, 200, basilisk), 'offer-launch', 'PID mismatch');
    assert.strictEqual(memoryTrackRoute(store, 100, undefined), 'offer-launch', 'no session');
    assert.strictEqual(
      memoryTrackRoute(store, 100, { id: 'session-1', type: 'python' }),
      'offer-launch',
      'foreign debug adapter',
    );
  });
});

// Tests for [PROF-UI-PROCESSES] / [PROF-PROCESSES-SCOPE]: the panel
// shows EVERY process (zero filters) and renders cues — launcher chips, a green
// workspace row, and a 🚫 / greyed / sunk row for anything it can't profile.
suite('Processes Panel — zero-filter display cues', () => {
  const slot = providerSlot();

  test('launchers are always listed and carry a framework chip (zero filters)', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    const rows = provider.getChildren();
    const uvicorn = rowByPid(rows, 300, 'uvicorn');
    assert.ok(
      String(uvicorn.description).includes('[uvicorn]'),
      `the launcher framework must render as a chip: ${String(uvicorn.description)}`,
    );
  });

  test('a workspace process resolves to a green decoration; an outside one does not', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    withDecorations(provider, (decorations) => {
      const rows = provider.getChildren();
      const inside = rowByPid(rows, 100, 'inside'); // inWorkspace: true
      const outside = rowByPid(rows, 300, 'outside'); // inWorkspace: false, debuggable
      const insideUri = resourceUri(inside);
      const outsideUri = resourceUri(outside);
      assert.ok(insideUri && outsideUri, 'process rows must carry a resourceUri for decoration');

      const insideDeco = decorations.provideFileDecoration(insideUri);
      assert.strictEqual(
        colorId(insideDeco?.color),
        'charts.green',
        'a workspace row must be green',
      );
      const outsideDeco = decorations.provideFileDecoration(outsideUri);
      assert.strictEqual(
        outsideDeco,
        undefined,
        'a non-workspace debuggable row keeps the default colour',
      );

      // A non-process URI is ignored, and a tree refresh re-fires decorations.
      assert.strictEqual(
        decorations.provideFileDecoration(vscode.Uri.file('/tmp/unrelated')),
        undefined,
        'URIs from other schemes are not decorated',
      );
      let fired = false;
      const sub = decorations.onDidChangeFileDecorations(() => {
        fired = true;
      });
      provider.refresh();
      sub.dispose();
      assert.ok(fired, 'a tree refresh must re-fire decorations so colours never go stale');
    });
  });

  test('a non-debuggable process is 🚫-marked, greyed, and sorted to the bottom', async () => {
    // MACHINERY has the highest CPU (99%) but must still sink below the others.
    const provider = await slot.load(storeWith([MACHINERY, ...STUB_PROCESSES]));
    withDecorations(provider, (decorations) => {
      const rows = provider.getChildren();
      assert.strictEqual(
        pidOf(rows[rows.length - 1]!),
        900,
        'the non-debuggable row sinks to the bottom despite the highest CPU',
      );
      const machineryRow = rowByPid(rows, 900, 'machinery');
      assert.ok(
        labelText(machineryRow).startsWith('🚫'),
        `a non-debuggable row must be prefixed with 🚫: ${labelText(machineryRow)}`,
      );
      assert.strictEqual(
        iconId(machineryRow),
        'circle-slash',
        'non-debuggable icon is circle-slash',
      );

      const machineryUri = resourceUri(machineryRow);
      assert.ok(machineryUri, 'the machinery row must carry a resourceUri');
      const deco = decorations.provideFileDecoration(machineryUri);
      assert.strictEqual(
        colorId(deco?.color),
        'disabledForeground',
        'a non-debuggable row is greyed',
      );
      assert.ok(
        tooltipText(machineryRow).includes('debugger machinery'),
        `the tooltip must explain why it can't be profiled: ${tooltipText(machineryRow)}`,
      );
    });
  });
});

// Icons, decoration precedence, tooltip detail, and within-group sinking —
// [PROF-UI-PROCESSES] (R4, R5, R6, R8).
suite('Processes Panel — display cues: icons, precedence, tooltip, grouping', () => {
  const slot = providerSlot();

  test('each process state renders its own info icon (R4)', async () => {
    const plain: ProcessInfo = { ...STUB_PROCESSES[0]!, pid: 111, inWorkspace: false };
    const store = storeWith([MACHINERY, plain, ...STUB_PROCESSES]);
    store.profilerActive(100, 'sess-cpu'); // mark PID 100 as actively profiled (store-derived, #148)
    const provider = await slot.load(store);
    const rows = provider.getChildren();
    const icons = new Map(rows.map((r) => [pidOf(r), iconId(r)]));
    assert.strictEqual(icons.get(100), 'flame', 'the actively-profiled row shows the flame');
    assert.strictEqual(
      icons.get(200),
      'lock',
      'an elevation row stays debuggable but shows the lock',
    );
    assert.strictEqual(icons.get(300), 'rocket', 'a launcher row shows the rocket');
    assert.strictEqual(
      icons.get(111),
      'vm-running',
      'a plain interpreter shows the running-VM glyph',
    );
    assert.strictEqual(icons.get(900), 'circle-slash', 'a non-debuggable row shows circle-slash');
  });

  test('greying wins over green for a non-debuggable workspace process (R5 > R6)', async () => {
    const wsMachinery: ProcessInfo = { ...MACHINERY, inWorkspace: true };
    const provider = await slot.load(storeWith([wsMachinery]));
    withDecorations(provider, (decorations) => {
      const row = rowByPid(processRows(provider.getChildren()), 900, 'machinery');
      const uri = resourceUri(row);
      assert.ok(uri, 'the row must carry a resourceUri');
      const deco = decorations.provideFileDecoration(uri);
      assert.strictEqual(
        colorId(deco?.color),
        'disabledForeground',
        "a workspace process you can't debug must be greyed, not green",
      );
    });
  });

  test('the tooltip surfaces every resolved detail (R8)', async () => {
    const rich: ProcessInfo = processFixture(555, {
      script: '/app/svc.py',
      cpuPercent: 7,
      memoryBytes: 12 * MB,
      runtimeSecs: 65,
      user: 'carol',
      inWorkspace: true,
      launcher: 'gunicorn',
    });
    const provider = await slot.load(storeWith([rich]));
    const row = rowByPid(processRows(provider.getChildren()), 555, 'rich process');
    const tip = tooltipText(row);
    for (const needle of [
      'PID 555',
      'Executable: /usr/bin/python3.12',
      'Entry: /app/svc.py',
      'CPython: 3.12.1',
      'Runtime:',
      'User: carol',
      'Launcher: gunicorn',
      'Workspace',
    ]) {
      assert.ok(tip.includes(needle), `tooltip must surface "${needle}": ${tip}`);
    }
  });

  test('a row opens its entry on click only when the runtime advertises source entries', async () => {
    const script: ProcessInfo = processFixture(557, {
      name: 'python3',
      interpreterPath: '/usr/bin/python3',
      script: '/app/run.py',
    });
    const binary: ProcessInfo = {
      ...script,
      pid: 558,
      name: 'App',
      interpreterPath: '/app/App',
      script: '/app/App',
      runtime: 'dotnet',
    };
    const provider = await slot.load(storeWith([script, binary]));
    const rows = processRows(provider.getChildren());
    const opens = rowByPid(rows, 557, 'script process').command;
    assert.strictEqual(opens?.command, 'vscode.open', 'a source entry opens in the editor');
    assert.strictEqual(String(opens?.arguments?.[0]), vscode.Uri.file('/app/run.py').toString());
    assert.strictEqual(
      rowByPid(rows, 558, 'binary process').command,
      undefined,
      'a runtime that never advertised source entries never opens its (binary) entry',
    );
  });

  test('a runtime the server never advertised is labelled by its wire id, not a guessed name', async () => {
    const odd: ProcessInfo = processFixture(556, {
      name: 'dotnet',
      interpreterPath: null,
      runtime: 'dotnet',
      runtimeVersion: '8.0.1',
    });
    const provider = await slot.load(storeWith([odd]));
    const row = rowByPid(processRows(provider.getChildren()), 556, 'odd runtime');
    const tip = tooltipText(row);
    assert.ok(tip.includes('dotnet: 8.0.1'), `the wire id labels the version: ${tip}`);
    assert.ok(!tip.includes('Dotnet:'), `no capitalised guess: ${tip}`);
  });

  test('when grouped, a non-debuggable process sinks within its group (R5)', async () => {
    const machinery: ProcessInfo = { ...MACHINERY, runtime: 'python', runtimeVersion: '3.12.1' }; // shares 100 & 300's group
    const provider = await slot.load(storeWith([machinery, ...STUB_PROCESSES]));
    provider.cycleGroupMode(); // none → version
    const groups = provider.getChildren();
    const twelve = groupOf(groups, '3.12.1');
    const members = provider.getChildren(twelve);
    assert.deepStrictEqual(
      members.map(pidOf),
      [100, 300, 900],
      'debuggable rows first (CPU-ordered), the non-debuggable one sinks last within the group',
    );
  });
});

// The big "Run & …(Current File)" buttons can't live in viewsWelcome once the
// tree is populated (VS Code renders welcome only for an EMPTY view), so they are
// pinned as rows at the top — gated per activity. [PROF-UI-PROCESSES]
// / [PROF-UI-PROCESSES].
suite('Processes Panel — pinned launch buttons', () => {
  const slot = providerSlot();

  function commandsOf(rows: vscode.TreeItem[]): (string | undefined)[] {
    return actionRows(rows).map((r) => r.command?.command);
  }

  test('the current-file launches are pinned above the process rows even when a process is listed', async () => {
    const provider = await slot.load(storeWith(STUB_PROCESSES));
    const rows = provider.getChildren();
    assert.deepStrictEqual(
      commandsOf(rows),
      ['sharplsp.profiler.profileCurrentFileCpu', 'sharplsp.profiler.trackMemoryCurrentFile'],
      'both launches must be pinned, CPU then memory',
    );
    assert.strictEqual(rows[0]!.contextValue, 'launchAction', 'a launch row is first');
    assert.ok(processRows(rows).length > 0, 'the process rows still follow the launches');
  });

  test('a busy metric hides ITS launch row but leaves the other (both: CPU during memory, memory during CPU)', async () => {
    const store = storeWith(STUB_PROCESSES);
    const provider = await slot.load(store);

    store.profilerActive(4242, 'sess-cpu'); // CPU busy
    assert.deepStrictEqual(
      commandsOf(provider.getChildren()),
      ['sharplsp.profiler.trackMemoryCurrentFile'],
      'while CPU profiles, the CPU launch is hidden but the memory launch remains',
    );

    store.profilerStopped();
    store.memoryTrackingActive('sess-mem'); // memory busy
    assert.deepStrictEqual(
      commandsOf(provider.getChildren()),
      ['sharplsp.profiler.profileCurrentFileCpu'],
      'while memory tracks, the memory launch is hidden but the CPU launch remains',
    );
    store.memoryTrackingStopped();
  });

  test('with no processes the tree is empty so the viewsWelcome big buttons render', async () => {
    const provider = await slot.load(storeWith([]));
    assert.deepStrictEqual(
      provider.getChildren(),
      [],
      'an empty process list defers to the welcome buttons rather than pinning rows',
    );
  });
});

// Memory tracking can only target the active SharpLsp debuggee, so the panel
// reveals the inline Track Memory action on that row alone and warns elsewhere —
// answering "why not grey it out beforehand?" ([PROF-UI-PROCESSES]).
suite('Processes Panel — Track Memory is debuggee-only', () => {
  const slot = providerSlot();

  test('only the active-debuggee row carries the Track-Memory-enabling contextValue', async () => {
    const store = storeWith(STUB_PROCESSES);
    store.setActiveDebuggeePid(100); // PID 100 is the active debuggee (centralised, #148)
    const provider = await slot.load(store);
    const rows = processRows(provider.getChildren());
    function ctxOf(pid: number): string | undefined {
      return rowByPid(rows, pid, 'process row').contextValue;
    }
    assert.strictEqual(ctxOf(100), 'processDebuggee', 'the debuggee row enables Track Memory');
    assert.strictEqual(ctxOf(200), 'processElevated', 'an external (elevated) row does not');
    assert.strictEqual(ctxOf(300), 'process', 'an external launcher row does not');
  });

  test('non-debuggee rows warn that memory tracking is unavailable here; the debuggee does not', async () => {
    const store = storeWith(STUB_PROCESSES);
    store.setActiveDebuggeePid(100);
    const provider = await slot.load(store);
    const rows = processRows(provider.getChildren());
    const debuggee = rowByPid(rows, 100, 'debuggee');
    const external = rowByPid(rows, 300, 'external');
    assert.ok(
      !tooltipText(debuggee).includes('Memory tracking needs'),
      'the debuggee row offers tracking, so it shows no caveat',
    );
    assert.ok(
      tooltipText(external).includes('Memory tracking needs'),
      `a non-debuggee row must warn memory tracking is unavailable: ${tooltipText(external)}`,
    );
  });

  test('with no active debuggee, no row enables Track Memory', async () => {
    const store = storeWith(STUB_PROCESSES);
    store.setActiveDebuggeePid(undefined);
    const provider = await slot.load(store);
    const rows = processRows(provider.getChildren());
    assert.ok(
      !rows.some((r) => r.contextValue === 'processDebuggee'),
      'no row may offer Track Memory when nothing runs under Basilisk',
    );
  });
});

// ── Inline action target resolution (issue #79) [PROF-UI-PROCESSES] ──
//
// Clicking the inline flame / database icon on a process row must act on
// THAT row. At runtime VS Code has been observed to invoke the command with
// `item === undefined`; the handler must fall back to the tree view's current
// selection — and only warn when there is truly no target.

suite('Processes Panel — inline action target (issue #79)', () => {
  const slot = providerSlot();

  test('undefined item falls back to the tree selection and profiles that PID — without warning', async () => {
    const { store, requests } = recordedStore();
    const provider = await slot.load(store);
    const selected = rowByPid(provider.getChildren(), 100, 'PID 100');

    const warnings = await captureWarnings(async () =>
      runInlineProfile(store, undefined, [selected]),
    );

    assert.deepStrictEqual(warnings, [], 'must not warn when a row is selected');
    const fired = profilerStarts(requests);
    assert.strictEqual(fired.length, 1, 'profiler start must be requested');
    assert.strictEqual(startPid(fired[0]!), 100, "must profile the selected row's PID");
  });

  test('memory tracking falls back to the tree selection the same way — without warning', async () => {
    const executed: string[] = [];
    const { store } = recordedStore();
    seedSignal(store.sessionIdToPid, new Map([['session-1', 200]]));
    const provider = await slot.load(store);
    const selected = rowByPid(provider.getChildren(), 200, 'PID 200');

    const warnings = await captureWarnings(async () =>
      runInlineTrackMemory(store, undefined, [selected], {
        runCommand: async (command) => {
          executed.push(command);
        },
        activeSession: () => ({ id: 'session-1', type: 'sharplsp-coreclr' }),
      }),
    );

    assert.deepStrictEqual(warnings, [], 'must not warn when a row is selected');
    assert.deepStrictEqual(
      executed,
      ['sharplsp.profiler.memoryStart'],
      'the selection fallback must reach the real memory-tracking flow',
    );
  });

  test('warns exactly once when there is neither an item nor a selection', async () => {
    const { store, requests } = recordedStore();

    const warnings = await captureWarnings(async () => runInlineProfile(store, undefined, []));

    assert.strictEqual(warnings.length, 1, 'must warn exactly once');
    assert.strictEqual(
      profilerStarts(requests).length,
      0,
      'must not start profiling without a target',
    );
  });
});

// A row the panel itself marks 🚫 (non-debuggable) must never offer the Profile
// CPU action: package.json reveals it via `viewItem =~ /^process/`, and the
// command handler is the last line of defence against a stale/raced row (#266).
suite('Processes Panel — blocked rows never offer Profile CPU (#266)', () => {
  const BLOCKED_MACHINERY: ProcessInfo = processFixture(400, {
    ppid: 100,
    name: 'python3.13',
    interpreterPath: '/usr/bin/python3.13',
    runtimeVersion: '3.13.7',
    memoryBytes: 5 * MB,
    runtimeSecs: 60,
    user: 'alice',
    requiresElevation: true,
    debuggable: false,
    undebuggableReason: 'debugger machinery',
  });
  const slot = providerSlot();

  test("a non-debuggable row's contextValue opts out of the /^process/ menu clauses", async () => {
    const provider = await slot.load(storeWith([...STUB_PROCESSES, BLOCKED_MACHINERY]));
    const rows = processRows(provider.getChildren());
    const blocked = rowByPid(rows, 400, 'machinery');
    const ctx = blocked.contextValue ?? '';
    // package.json's clause is `viewItem =~ /^process/` — an anchored
    // prefix match, i.e. exactly a startsWith check.
    assert.ok(
      !ctx.startsWith('process'),
      'package.json reveals Profile CPU on `viewItem =~ /^process/`, so a row the panel ' +
        `already marks 🚫 "Can't profile" must not match it; got contextValue: ${ctx}`,
    );
  });

  test('invoking Profile CPU on a blocked row refuses instead of attaching', async () => {
    const { store, requests } = recordedStore([...STUB_PROCESSES, BLOCKED_MACHINERY]);
    const provider = await slot.load(store);
    const blocked = rowByPid(processRows(provider.getChildren()), 400, 'machinery');

    await runInlineProfile(store, blocked, [blocked]);

    assert.strictEqual(
      profilerStarts(requests).length,
      0,
      'a row flagged "Can\'t profile" must never send basilisk.profiler.start — ' +
        'the attach is known to fail (#266)',
    );
  });
});
