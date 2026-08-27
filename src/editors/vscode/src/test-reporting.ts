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
import { findCoberturaFiles, parseCoberturaXml } from './test-coverage';
import type { CachedTestResult } from './testing';
import type { TrxTestResult } from './test-trx';

/** Sub-directory of the solution folder where a coverage run drops artefacts. */
export const COVERAGE_DIR = '.sharplsp-coverage';

/** Translate a TRX result into the cache's shape. */
export function cachedFrom(result: TrxTestResult): CachedTestResult {
  return {
    outcome: result.outcome,
    passed: result.outcome === 'passed',
    duration: result.durationMs,
    message: result.message ?? (result.outcome === 'failed' ? 'Test failed' : undefined),
  };
}

/** Report one TRX result onto the VS Code test run. */
export function reportResult(run: vscode.TestRun, test: vscode.TestItem, result: TrxTestResult): void {
  if (result.outcome === 'passed') {
    run.passed(test, result.durationMs);
    return;
  }
  if (result.outcome === 'skipped') {
    run.skipped(test);
    return;
  }
  const detail = [result.message, result.stackTrace].filter((part) => part !== undefined).join('\n');
  run.failed(test, new vscode.TestMessage(detail === '' ? 'Test failed' : detail), result.durationMs);
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

/** Attach any Cobertura report the coverage run produced to the test run. */
export function addCoverage(run: vscode.TestRun, resultsDirectory: string): void {
  const reports = findCoberturaFiles(resultsDirectory);
  let attached = 0;
  for (const report of reports) {
    for (const fileCoverage of parseCoberturaXml(report)) {
      run.addCoverage(fileCoverage);
      attached += 1;
    }
  }
  info(`Coverage loaded: ${String(attached)} files from ${String(reports.length)} report(s)`);
}
