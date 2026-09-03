/**
 * Turning one `dotnet test` invocation's results into what the user sees:
 * VS Code test-run states, the status-lens cache, and attached coverage.
 *
 * Split out of `testing.ts` so the controller file stays about Testing-API
 * wiring. Implements [TEST-RUN-TRX] and [TEST-COVERAGE].
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { info } from './log';
import { findCoberturaFiles, mergeCoberturaReports } from './test-coverage';
import type { TestOutcome } from './test-run-output';
import type { TrxTestResult } from './test-trx';
import { singleLine } from './utils';

/** Writes one result into the controller's status-lens cache. */
export type CacheWriter = (testId: string, result: CachedTestResult) => void;

/** The slice of a `dotnet test` invocation's outcome that reporting reads. */
interface ReportableOutcome {
  readonly results: ReadonlyMap<string, TrxTestResult>;
  readonly failure: string | undefined;
}

/** Cached result for a single test, keyed by fully qualified name. */
export interface CachedTestResult {
  /** How the run ended, as VS Code's Testing API models it. */
  readonly outcome: TestOutcome;
  /** True only for a genuine pass — a SKIP is not a pass and not a failure. */
  readonly passed: boolean;
  readonly duration?: number | undefined;
  readonly message?: string | undefined;
}

/** Sub-directory of the solution folder where a coverage run drops artefacts. */
export const COVERAGE_DIR = '.sharplsp-coverage';

/**
 * Translate a TRX result into the cache's shape.
 *
 * The cached message is flattened onto ONE line, because the cache exists to
 * feed the status LENS ([TEST-STATUS-LENS]) and a lens title is one line. The
 * raw `TrxTestResult` is what the Testing view's failure pane is built from
 * (see {@link reportOutcome}), so the expected/actual block keeps its layout
 * exactly where there is room to render it.
 */
export function cachedFrom(result: TrxTestResult): CachedTestResult {
  const failure = result.outcome === 'failed' ? 'Test failed' : undefined;
  const message = result.message === undefined ? failure : singleLine(result.message);
  return {
    outcome: result.outcome,
    passed: result.outcome === 'passed',
    duration: result.durationMs,
    message,
  };
}

/**
 * Map one invocation's TRX results onto the run — and, through `cache`, onto
 * the status-lens cache. A DEBUG run passes NO cache writer: its outcomes are
 * distorted by the debugging itself (a session stopped mid-test reports
 * nothing), so the last real run's cached result must stand.
 */
export function reportOutcome(
  run: vscode.TestRun,
  tests: readonly vscode.TestItem[],
  outcome: ReportableOutcome,
  cache: CacheWriter | undefined,
): void {
  if (outcome.failure !== undefined) {
    info(`Test run failed: ${outcome.failure}`);
  }
  for (const test of tests) {
    const result = outcome.results.get(test.id);
    if (result === undefined) {
      reportMissing(run, test, outcome, cache);
      continue;
    }
    cache?.(test.id, cachedFrom(result));
    reportResult(run, test, result);
  }
}

/** A selected test the run never reported on: build failure or no match. */
function reportMissing(
  run: vscode.TestRun,
  test: vscode.TestItem,
  outcome: ReportableOutcome,
  cache: CacheWriter | undefined,
): void {
  const message = outcome.failure ?? `No result reported for ${test.id} (filter matched no test)`;
  cache?.(test.id, { outcome: 'notRun', passed: false, message });
  run.errored(test, new vscode.TestMessage(message));
}

/** Report the same hard failure against every selected test. */
export function reportAll(
  run: vscode.TestRun,
  tests: readonly vscode.TestItem[],
  message: string,
  cache: CacheWriter,
): void {
  for (const test of tests) {
    cache(test.id, { outcome: 'notRun', passed: false, message });
    run.errored(test, new vscode.TestMessage(message));
  }
}

/** Report one TRX result onto the VS Code test run. */
export function reportResult(
  run: vscode.TestRun,
  test: vscode.TestItem,
  result: TrxTestResult,
): void {
  if (result.outcome === 'passed') {
    run.passed(test, result.durationMs);
    return;
  }
  if (result.outcome === 'skipped') {
    run.skipped(test);
    return;
  }
  const detail = [result.message, result.stackTrace]
    .filter((part) => part !== undefined)
    .join('\n');
  run.failed(
    test,
    new vscode.TestMessage(detail === '' ? 'Test failed' : detail),
    result.durationMs,
  );
}

/**
 * An EMPTY `.sharplsp-coverage` next to the solution. `findCoberturaFile` takes
 * the first report one level down, so a directory left over from an earlier run
 * makes the Testing view show yesterday's coverage for today's run.
 */
export function freshCoverageDir(cwd: string): string {
  const dir = path.join(cwd, COVERAGE_DIR);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Attach any Cobertura report the coverage run produced to the test run.
 *
 * The reports are MERGED per file rather than attached one by one. Two test
 * projects covering one library each report that library, and the per-line
 * detail behind an entry is stashed by file URI — so attaching both entries
 * left the last report parsed answering for both, and a function the other
 * project executed came back uncovered ([TEST-COVERAGE]).
 */
export function addCoverage(run: vscode.TestRun, resultsDirectory: string): void {
  const reports = findCoberturaFiles(resultsDirectory);
  const files = mergeCoberturaReports(reports);
  for (const fileCoverage of files) {
    run.addCoverage(fileCoverage);
  }
  info(`Coverage loaded: ${String(files.length)} files from ${String(reports.length)} report(s)`);
}
