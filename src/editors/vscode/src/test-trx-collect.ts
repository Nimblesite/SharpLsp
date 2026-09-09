/**
 * Reading back the `.trx` files ONE invocation created.
 *
 * Both runners end here. VSTest writes its reports with `--logger trx`, a
 * Microsoft.Testing.Platform module writes its own with `--report-trx`, and the
 * two documents carry the same `className` + `.` + `name` pair — so the same
 * collection, the same worst-row merge and the same reader serve both.
 *
 * Implements [TEST-RUN-TRX] and [TEST-MTP-RUN].
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestOutcome } from './test-run-output.js';
import { parseTrxReport, type TrxRunInfo, type TrxTestResult } from './test-trx.js';

/** Every `.trx` this run created, merged: results keyed by FQN, plus run info. */
export function collectReport(
  dir: string,
  before: ReadonlySet<string>,
): { results: Map<string, TrxTestResult>; runInfos: TrxRunInfo[] } {
  const results = new Map<string, TrxTestResult>();
  const runInfos: TrxRunInfo[] = [];
  for (const file of trxFiles(dir)) {
    if (before.has(file)) continue;
    const report = readTrx(file);
    runInfos.push(...report.runInfos);
    for (const result of report.results) {
      const existing = results.get(result.fullyQualifiedName);
      results.set(
        result.fullyQualifiedName,
        existing === undefined ? result : worse(existing, result),
      );
    }
  }
  return { results, runInfos };
}

/** Severity order, so a data-driven test is judged by its WORST row. */
const OUTCOME_SEVERITY: Record<TestOutcome, number> = {
  passed: 0,
  skipped: 1,
  notRun: 2,
  failed: 3,
};

/**
 * Merge two results reported under the SAME fully-qualified name.
 *
 * A theory or `[TestCase]` with several rows writes one TRX entry PER ROW, all
 * carrying the same FQN. Keeping the last one seen would report a green tree for
 * a theory whose second row failed, purely because of the order VSTest happened
 * to write them. The worst outcome wins and the durations add up.
 */
export function worse(left: TrxTestResult, right: TrxTestResult): TrxTestResult {
  const durationMs = sumDurations(left.durationMs, right.durationMs);
  const dominant = OUTCOME_SEVERITY[right.outcome] > OUTCOME_SEVERITY[left.outcome] ? right : left;
  return { ...dominant, durationMs };
}

/** Add two optional durations, keeping `undefined` only when both are absent. */
function sumDurations(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

/** Absolute paths of the `.trx` reports directly inside `dir`. */
export function trxFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.toLowerCase().endsWith('.trx'))
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

/** Parse one TRX file, tolerating a truncated or unreadable report. */
function readTrx(file: string): {
  results: readonly TrxTestResult[];
  runInfos: readonly TrxRunInfo[];
} {
  try {
    return parseTrxReport(fs.readFileSync(file, 'utf8'));
  } catch {
    return { results: [], runInfos: [] };
  }
}
