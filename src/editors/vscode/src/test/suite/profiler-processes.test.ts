// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE
//
// The Processes panel over the real SharpLsp server and live .NET targets: the
// server lists every .NET process with its runtime facts, the panel renders a
// row per process with the runtime's advertised name, a stable id, a tooltip
// carrying every resolved detail and the contextValue that offers both CPU and
// (direct-mode) memory actions; the launch rows stay pinned; filter, sort and
// group re-project the same list; copy, reveal and kill act on a row; and the
// welcome's context key follows the fetch. Ported from Basilisk's
// process-explorer, process-reactive-store and procexp suites, with every
// assertion run against a real process instead of a mocked table.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { contextKeyValues, processesViewState } from '@nimblesite/lsp-profiler-ui';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProcessList } from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import {
  execute,
  executeError,
  fixtureSource,
  panelRows,
  processesProvider,
  profilerStore,
  rowOf,
  Target,
  tooltipText,
  uiCommand,
  waitFor,
} from './profiler-kit';
import { setupLspTestSuite, teardownLspTestSuite } from './test-helpers';
import { ACTIVATION_MS, COMMAND_MS, LSP_RESPONSE_MS, PROCESS_START_MS } from './test-timeouts';

async function refreshed(): Promise<void> {
  await vscode.commands.executeCommand(uiCommand('refreshProcesses'));
}

async function listedRow(pid: number): Promise<vscode.TreeItem> {
  const row = await waitFor(
    () => rowOf(pid),
    (item) => item !== undefined,
    LSP_RESPONSE_MS,
    `row for PID ${pid}`,
  );
  assert.ok(row);
  return row;
}

suite('Processes panel — the server lists live .NET processes', () => {
  let tmpDir = '';
  let target: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-procs-'));
    target = await Target.start('ProfileTarget');
  });
  suiteTeardown(() => {
    target?.stop();
    teardownLspTestSuite(tmpDir);
  });

  test('the wire listing carries the target with its runtime facts', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    const listing = await execute<ProcessList>('processes', { workspace_roots: [] });
    const entry = listing.processes.find((proc) => proc.pid === target?.pid);
    assert.ok(entry, `PID ${target.pid} listed: ${listing.processes.map((p) => p.pid).join(', ')}`);
    assert.equal(entry.runtime, 'dotnet');
    assert.ok(entry.name.includes('ProfileTarget'), `name: ${entry.name}`);
    assert.equal(entry.attachable, true, 'a live .NET target advertises its diagnostics endpoint');
    assert.ok(entry.runtime_version, 'the runtime version is resolved');
    assert.equal(entry.ppid, process.pid, 'spawned by the extension host');
  });

  test('the extension host itself is not a .NET process and is never listed', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const listing = await execute<ProcessList>('processes', { workspace_roots: [] });
    assert.ok(
      !listing.processes.some((proc) => proc.pid === process.pid),
      'enumeration lists only processes a runtime recognises',
    );
  });

  test('a process under a workspace root is marked in_workspace; outside every root it is not', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    const project = path.dirname(fixtureSource('ProfileTarget'));
    const inside = await execute<ProcessList>('processes', { workspace_roots: [project] });
    const outside = await execute<ProcessList>('processes', { workspace_roots: [os.tmpdir()] });
    assert.equal(inside.processes.find((proc) => proc.pid === target?.pid)?.in_workspace, true);
    assert.equal(outside.processes.find((proc) => proc.pid === target?.pid)?.in_workspace, false);
  });

  test('a listing request without workspace roots is INVALID_PARAMS', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.equal((await executeError('processes', {}))?.code, -32602);
  });

  test('refresh loads the store and flips the welcome key to loaded', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    await refreshed();
    const state = profilerStore().processes.value;
    assert.equal(state.fetch, 'loaded');
    assert.ok(
      state.list.some((proc) => proc.pid === target?.pid),
      'the target is in the store',
    );
    assert.equal(contextKeyValues().get('sharplsp.profiler.processesState'), 'loaded');
  });

  test('the row has a stable id, the runtime’s advertised name, and every resolved detail', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    await refreshed();
    const row = await listedRow(target.pid);
    assert.equal(row.id, `process:${target.pid}`);
    const tip = tooltipText(row);
    for (const needle of [`PID ${target.pid}`, '.NET: ', 'CPU: ', 'Memory: ', 'Runtime: ']) {
      assert.ok(tip.includes(needle), `tooltip carries "${needle}": ${tip}`);
    }
    assert.ok(
      !tip.includes('Dotnet:'),
      `the label is the server’s display name, not a guess: ${tip}`,
    );
  });

  test('a direct-memory runtime offers Track Memory on any attachable row, not only a debuggee', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(target);
    await refreshed();
    const row = await listedRow(target.pid);
    assert.equal(
      row.contextValue,
      'processDebuggee',
      'the row carries the Track-Memory contextValue',
    );
    assert.ok(
      !tooltipText(row).includes('Memory tracking needs the process'),
      'no courier-only warning on a direct runtime',
    );
  });

  test('the row reveals no script and opens nothing when the process has none', async function () {
    this.timeout(COMMAND_MS);
    assert.ok(target);
    const row = await listedRow(target.pid);
    assert.equal(row.command, undefined, 'a .NET process has no entry script to open on click');
    const before = vscode.window.activeTextEditor?.document.uri.toString();
    await vscode.commands.executeCommand(uiCommand('revealProcessScript'), row);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), before);
  });

  test('the current-file launches stay pinned above the rows', async function () {
    this.timeout(LSP_RESPONSE_MS);
    await refreshed();
    const rows = panelRows();
    assert.deepEqual(
      rows.slice(0, 2).map((row) => row.id),
      [
        `launchAction:${uiCommand('profileCurrentFileCpu')}`,
        `launchAction:${uiCommand('trackMemoryCurrentFile')}`,
      ],
    );
    assert.ok(rows.slice(0, 2).every((row) => row.contextValue === 'launchAction'));
  });

  test('copy PID puts the row’s PID on the clipboard', async function () {
    this.timeout(COMMAND_MS);
    assert.ok(target);
    const row = await listedRow(target.pid);
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand(uiCommand('copyProcessPid'), row);
    const deadline = Date.now() + COMMAND_MS;
    let copied = await vscode.env.clipboard.readText();
    while (copied === '' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      copied = await vscode.env.clipboard.readText();
    }
    assert.equal(copied, String(target.pid));
  });

  test('the panel is idle chrome when nothing is profiling', () => {
    assert.deepEqual(processesViewState(), { message: undefined, badge: undefined });
  });
});

suite('Processes panel — filter, sort and group re-project the same list', () => {
  let tmpDir = '';
  let first: Target | undefined;
  let second: Target | undefined;
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS + PROCESS_START_MS * 2);
    ({ tmpDir } = await setupLspTestSuite('profiler-procs-view-'));
    first = await Target.start('ProfileTarget');
    second = await Target.start('ProfileLeakTarget');
    await refreshed();
  });
  suiteTeardown(() => {
    processesProvider().setFilter('');
    first?.stop();
    second?.stop();
    teardownLspTestSuite(tmpDir);
  });

  test('a PID filter narrows the rows to that process', async function () {
    this.timeout(LSP_RESPONSE_MS);
    assert.ok(first && second);
    await listedRow(first.pid);
    processesProvider().setFilter(String(first.pid));
    assert.ok(rowOf(first.pid), 'the matching row stays');
    assert.equal(rowOf(second.pid), undefined, 'the other row is filtered out');
  });

  test('a name filter matches case-insensitively', () => {
    assert.ok(first && second);
    processesProvider().setFilter('PROFILELEAKTARGET');
    assert.ok(rowOf(second.pid), 'the leak target matches its name in any case');
    assert.equal(rowOf(first.pid), undefined);
  });

  test('a filter that hides every process shows an honest placeholder, never an empty list', () => {
    processesProvider().setFilter('no-such-process-anywhere');
    const message = panelRows().find((row) => row.contextValue === 'processesMessage');
    assert.ok(message, 'a placeholder row is shown');
    assert.ok(
      String(message.label).includes('No process matches "no-such-process-anywhere"'),
      `placeholder names the filter: ${String(message.label)}`,
    );
    assert.ok(
      panelRows().some((row) => row.contextValue === 'launchAction'),
      'the launches survive the filter',
    );
  });

  test('clearing the filter restores both rows', () => {
    assert.ok(first && second);
    processesProvider().setFilter('');
    assert.ok(rowOf(first.pid) && rowOf(second.pid));
  });

  test('sort cycles through every mode in order and wraps', async () => {
    const store = profilerStore();
    const seen: string[] = [store.processes.value.sortMode];
    for (let i = 0; i < 6; i++) {
      await vscode.commands.executeCommand(uiCommand('sortProcesses'));
      seen.push(store.processes.value.sortMode);
    }
    assert.deepEqual(seen, ['cpu', 'memory', 'pid', 'name', 'runtime', 'version', 'cpu']);
  });

  test('PID sort orders each block by ascending PID, attachable rows above blocked ones', async () => {
    assert.ok(first && second);
    const store = profilerStore();
    const sortMode = (): string => store.processes.value.sortMode;
    while (sortMode() !== 'pid') {
      await vscode.commands.executeCommand(uiCommand('sortProcesses'));
    }
    const attachable = new Map(
      store.processes.value.list.map((proc) => [proc.pid, proc.debuggable]),
    );
    const pids = panelRows()
      .filter((row) => row.id?.startsWith('process:') === true)
      .map((row) => Number(row.id?.slice('process:'.length)));
    const open = pids.filter((pid) => attachable.get(pid) === true);
    const blocked = pids.filter((pid) => attachable.get(pid) !== true);
    assert.deepEqual(pids, [...open, ...blocked], `attachable rows first: ${pids.join(', ')}`);
    assert.deepEqual(
      open,
      [...open].sort((a, b) => a - b),
      `ascending: ${open.join(', ')}`,
    );
    assert.deepEqual(
      blocked,
      [...blocked].sort((a, b) => a - b),
      `ascending: ${blocked.join(', ')}`,
    );
    assert.ok(
      open.includes(first.pid) && open.includes(second.pid),
      'both live targets are attachable',
    );
    while (sortMode() !== 'cpu') {
      await vscode.commands.executeCommand(uiCommand('sortProcesses'));
    }
  });

  test('grouping by runtime version buckets both targets under one header with a count', async () => {
    assert.ok(first && second);
    const store = profilerStore();
    await vscode.commands.executeCommand(uiCommand('groupProcesses'));
    assert.equal(store.processes.value.groupMode, 'version');
    const provider = processesProvider();
    const groups = provider.getChildren().filter((row) => row.contextValue === 'processGroup');
    assert.ok(groups.length > 0, 'group headers render');
    const holding = groups.filter((group) =>
      provider
        .getChildren(group)
        .some((row) => row.id === `process:${first?.pid}` || row.id === `process:${second?.pid}`),
    );
    assert.equal(holding.length, 1, 'both net10.0 targets share one version group');
    assert.ok(
      Number(holding[0]?.description) >= 2,
      `the count badge counts members: ${holding[0]?.description}`,
    );
  });

  test('group cycles through every mode and back to none', async () => {
    const store = profilerStore();
    const seen: string[] = [store.processes.value.groupMode];
    for (let i = 0; i < 4; i++) {
      await vscode.commands.executeCommand(uiCommand('groupProcesses'));
      seen.push(store.processes.value.groupMode);
    }
    assert.deepEqual(seen, ['version', 'interpreter', 'user', 'parent', 'none']);
    assert.ok(!panelRows().some((row) => row.contextValue === 'processGroup'), 'flat again');
  });
});

suite('Processes panel — kill', () => {
  let tmpDir = '';
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    ({ tmpDir } = await setupLspTestSuite('profiler-procs-kill-'));
  });
  suiteTeardown(() => {
    teardownLspTestSuite(tmpDir);
  });

  test('kill terminates a recognised .NET process and it leaves the listing', async function () {
    this.timeout(PROCESS_START_MS + LSP_RESPONSE_MS);
    const victim = await Target.start('ProfileTarget');
    try {
      const result = await execute<{ pid: number; killed: boolean }>('kill', { pid: victim.pid });
      assert.deepEqual(result, { pid: victim.pid, killed: true });
      await waitFor(
        () => victim.pid,
        (pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        LSP_RESPONSE_MS,
        'the victim exits',
      );
      const listing = await execute<ProcessList>('processes', { workspace_roots: [] });
      assert.ok(
        !listing.processes.some((proc) => proc.pid === victim.pid),
        'gone from the listing',
      );
    } finally {
      victim.stop();
    }
  });

  test('kill refuses a process no runtime recognises — it can never hit the editor', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const error = await executeError('kill', { pid: process.pid });
    assert.equal(error?.code, -32002, error?.message ?? 'no error');
  });

  test('kill refuses a PID that does not exist', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const error = await executeError('kill', { pid: 999_999 });
    assert.equal(error?.code, -32001, error?.message ?? 'no error');
  });

  test('the kill command without a row does nothing and raises nothing', async function () {
    this.timeout(COMMAND_MS);
    await vscode.commands.executeCommand(uiCommand('killProcess'));
    assert.equal(profilerStore().profiler.value.cpu, 'idle');
  });
});
