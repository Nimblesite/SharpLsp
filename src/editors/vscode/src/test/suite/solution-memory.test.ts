/**
 * The solution a user picks is remembered per workspace, so reloading the window
 * reopens it instead of asking again. A repo holding many solutions (fixtures,
 * samples, the real one) otherwise re-prompts on every reload, and one wrong
 * pick silently empties the Solution Explorer and the Test Explorer.
 * Implements [SE-SOLUTION].
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findSolutions, type SolutionSelection } from '../../solution.js';
import { activation, WorkspaceMemory } from './solution-loader-kit';
import { installUiStubs, type UiStubs } from './ui-stubs';

/** The pick a user would make that is NOT the first offered. */
function notFirst(offered: readonly SolutionSelection[]): SolutionSelection {
  const picked = offered.at(-1);
  assert.ok(picked !== undefined && offered.length >= 2, 'the premise: several solutions');
  return picked;
}

suite('Solution memory across window reloads [SE-SOLUTION]', () => {
  let stubs: UiStubs;
  setup(() => {
    stubs = installUiStubs();
  });
  teardown(() => {
    stubs.restore();
  });

  test('a reload reopens the solution the user picked instead of asking again', async () => {
    const memory = new WorkspaceMemory();
    const offered = await findSolutions();
    const picked = notFirst(offered);

    // 1 — first open: several solutions, so the user is asked and picks one.
    const firstLoads: string[] = [];
    stubs.queuePick((items) => items.find((item) => labelOf(item) === picked.name));
    await activation(memory, firstLoads).selectAndLoad();
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'the first open asks once');
    assert.deepStrictEqual(firstLoads, [picked.path], 'the picked solution is the one loaded');
    assert.ok(fs.existsSync(picked.path), 'the picked solution is a real file');

    // 2 — the window reloads: a NEW activation over the SAME workspace storage.
    const reloadLoads: string[] = [];
    await activation(memory, reloadLoads).selectAndLoad();
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'a reload never asks again');
    assert.deepStrictEqual(reloadLoads, [picked.path], 'the reload reopens the same solution');
    assert.strictEqual(path.basename(reloadLoads[0] ?? ''), picked.name, 'by its own file');
  });
});

/** The label of a QuickPick item the solution picker offers. */
function labelOf(item: unknown): string | undefined {
  return (item as { readonly label?: string }).label;
}
