/**
 * The last known outcome of every discovered test.
 *
 * The status CodeLens ([TEST-STATUS-LENS]) paints from this cache, so it
 * outlives the run that filled it — and therefore has to be pruned when the
 * tree changes. A result must not outlive the test it belongs to: after the
 * loaded solution changes, a stale entry would paint an outcome for a test that
 * was never run here.
 *
 * Implements [TEST-REACTIVITY].
 */

import * as vscode from 'vscode';
import type { CacheWriter, CachedTestResult } from './test-reporting.js';
import { forEachLeafIn } from './test-tree.js';

/** Cached outcomes keyed by test id, with a change signal for the lens. */
export class TestResultCache {
  private readonly results = new Map<string, CachedTestResult>();
  private readonly changed = new vscode.EventEmitter<void>();

  /** Fires after any test run completes and results are cached. */
  public readonly onChanged = this.changed.event;

  /** Look up the last known result for a test id. */
  public get(testId: string): CachedTestResult | undefined {
    return this.results.get(testId);
  }

  /** All cached results keyed by test id. */
  public get all(): ReadonlyMap<string, CachedTestResult> {
    return this.results;
  }

  /** Announce that results changed, so the lens repaints. */
  public fire(): void {
    this.changed.fire();
  }

  /** The writer a real RUN reports through; a debug run passes none. */
  public writer(): CacheWriter {
    return (id, result) => {
      this.results.set(id, result);
    };
  }

  /** Record one result without announcing it. */
  public set(testId: string, result: CachedTestResult): void {
    this.results.set(testId, result);
  }

  /**
   * Drop cached outcomes for tests no longer in the tree. Listeners hear about
   * it only when something was actually dropped.
   */
  public pruneTo(items: readonly vscode.TestItem[]): void {
    const alive = new Set<string>();
    forEachLeafIn(items, (item) => alive.add(item.id));
    let dropped = 0;
    for (const id of [...this.results.keys()]) {
      if (alive.has(id)) continue;
      this.results.delete(id);
      dropped += 1;
    }
    if (dropped > 0) this.changed.fire();
  }

  public dispose(): void {
    this.changed.dispose();
  }
}
