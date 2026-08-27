/**
 * Running tests: one `dotnet test` invocation, per-test results back.
 *
 * The Test Explorer previously spawned a separate `dotnet test` PER SELECTED
 * TEST and decided the outcome from whether the console summary contained
 * `Passed!`. Running a class of twenty tests therefore paid twenty restores and
 * builds — minutes on a warm Linux box, long past any sane timeout on Windows —
 * and every skipped test was reported as a failure. This module runs the whole
 * selection once and reads the per-test outcomes out of the TRX report.
 *
 * `--logger trx` is deliberately used WITHOUT `LogFileName`: a solution runs one
 * VSTest session per project, and a fixed file name makes each session overwrite
 * the previous one, so all but the last project's results are lost. Left to
 * auto-name, VSTest writes `<name>.trx`, `<name>[1].trx`, … and every file in
 * the results directory is read back.
 *
 * Implements [TEST-RUN-TRX] and [TEST-FILTER-ESCAPE].
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DOTNET_TIMEOUT_MS, runDotnet } from './dotnet-process.js';
import { filterExpression } from './test-filter.js';
import {
  parseFailureMessage,
  parseRunSummary,
  type TestOutcome,
  type TestRunSummary,
} from './test-run-output.js';
import { isRunError, parseTrxReport, type TrxRunInfo, type TrxTestResult } from './test-trx.js';

/** What one `dotnet test` invocation produced. */
export interface TestRunOutcome {
  /** Per-test results keyed by fully-qualified name. Empty when nothing ran. */
  readonly results: ReadonlyMap<string, TrxTestResult>;
  /** The console summary counts, when `dotnet test` printed one. */
  readonly summary: TestRunSummary | undefined;
  /** Set when the invocation itself failed — build error, missing SDK, timeout. */
  readonly failure: string | undefined;
  /** Run-level messages VSTest recorded, outside any individual test. */
  readonly runInfos: readonly TrxRunInfo[];
  /** True when the selection had to be re-run WITHOUT a filter to get results. */
  readonly retriedUnfiltered: boolean;
  /** Wall-clock time of the whole invocation, including restore and build. */
  readonly durationMs: number;
  /** Combined stdout/stderr, for the extension log. */
  readonly output: string;
}

/** Optional knobs for {@link runTests}. */
export interface TestRunOptions {
  /** Also collect Cobertura coverage into `resultsDirectory`. */
  readonly coverage?: boolean;
  /** Where TRX (and coverage) land. A fresh temp directory when omitted. */
  readonly resultsDirectory?: string;
  /**
   * The solution or project to run, passed positionally. Without it `dotnet
   * test` resolves the target from `cwd`, which errors out when the directory
   * holds more than one project or solution file.
   */
  readonly target?: string;
  readonly timeoutMs?: number;
}

/**
 * `dotnet test --filter` args restricted to `tests`, or no filter at all when
 * the selection is empty (which is how VS Code expresses "run everything").
 */
export function buildFilterArgs(tests: readonly { readonly id: string }[]): string[] {
  if (tests.length === 0) return [];
  return ['--filter', filterExpression(tests.map((test) => test.id))];
}

/** Run `testIds` (all tests when empty) in `cwd` and report per-test outcomes. */
export async function runTests(
  testIds: readonly string[],
  cwd: string,
  options: TestRunOptions = {},
): Promise<TestRunOutcome> {
  const owned = options.resultsDirectory === undefined;
  const resultsDirectory = options.resultsDirectory ?? freshTempDir();
  try {
    return await runInto(testIds, cwd, resultsDirectory, options);
  } finally {
    if (owned) fs.rmSync(resultsDirectory, { recursive: true, force: true });
  }
}

/** A private, empty directory for one run's TRX output. */
function freshTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-trx-'));
}

/**
 * The invocation, plus a single recovery attempt.
 *
 * A test adapter can REJECT the `--filter` expression rather than merely
 * matching nothing: the NUnit adapter's own filter parser refuses any
 * fully-qualified name containing a space, which is every idiomatic F# backtick
 * test (`Unexpected Word 'on' at position 43 in selection expression`). The run
 * then reports no result for a test that is perfectly runnable, and the Testing
 * view shows a phantom failure. TRX records that refusal as a run-level
 * `RunInfo` with `outcome="Error"`, so when it happens the selection is re-run
 * WITHOUT a filter and the per-test outcomes are picked out of the report by
 * name — slower, but correct, and only ever on the adapter's say-so.
 */
async function runInto(
  testIds: readonly string[],
  cwd: string,
  resultsDirectory: string,
  options: TestRunOptions,
): Promise<TestRunOutcome> {
  const filtered = await invoke(testIds, cwd, resultsDirectory, options);
  if (!needsUnfilteredRetry(filtered, testIds)) return filtered;
  const unfiltered = await invoke([], cwd, resultsDirectory, options);
  return mergeRuns(filtered, unfiltered);
}

/** One `dotnet test` invocation into `resultsDirectory`. */
async function invoke(
  testIds: readonly string[],
  cwd: string,
  resultsDirectory: string,
  options: TestRunOptions,
): Promise<TestRunOutcome> {
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const before = new Set(trxFiles(resultsDirectory));
  const args = runArgs(testIds, resultsDirectory, options);
  const started = Date.now();
  const run = await runDotnet(args, cwd, options.timeoutMs ?? DOTNET_TIMEOUT_MS);
  const durationMs = Date.now() - started;
  const output = `${run.stdout}\n${run.stderr}`;
  const report = collectReport(resultsDirectory, before);
  return {
    results: report.results,
    summary: parseRunSummary(output),
    failure: runFailure(run.failed, run.killed, run.errorMessage, output, report.results.size),
    runInfos: report.runInfos,
    retriedUnfiltered: false,
    durationMs,
    output,
  };
}

/** True when an adapter refused the filter and swallowed a selected test with it. */
function needsUnfilteredRetry(run: TestRunOutcome, testIds: readonly string[]): boolean {
  if (testIds.length === 0) return false;
  if (!run.runInfos.some(isRunError)) return false;
  return testIds.some((id) => !run.results.has(id));
}

/** Prefer the unfiltered retry's results; keep everything the first run proved. */
function mergeRuns(filtered: TestRunOutcome, unfiltered: TestRunOutcome): TestRunOutcome {
  const results = new Map(filtered.results);
  for (const [name, result] of unfiltered.results) {
    results.set(name, result);
  }
  return {
    results,
    summary: unfiltered.summary ?? filtered.summary,
    failure: results.size > 0 ? undefined : (unfiltered.failure ?? filtered.failure),
    runInfos: [...filtered.runInfos, ...unfiltered.runInfos],
    retriedUnfiltered: true,
    durationMs: filtered.durationMs + unfiltered.durationMs,
    output: `${filtered.output}\n${unfiltered.output}`,
  };
}

/** The argument vector for one run. */
function runArgs(
  testIds: readonly string[],
  resultsDirectory: string,
  options: TestRunOptions,
): string[] {
  return [
    'test',
    ...(options.target === undefined ? [] : [options.target]),
    ...buildFilterArgs(testIds.map((id) => ({ id }))),
    '--logger',
    'trx',
    '--results-directory',
    resultsDirectory,
    '--nologo',
    ...(options.coverage === true ? ['--collect:XPlat Code Coverage'] : []),
  ];
}

/**
 * A process-level failure worth surfacing. A non-zero exit with per-test results
 * is just "some tests failed", which the results themselves already say.
 */
function runFailure(
  failed: boolean,
  killed: boolean,
  errorMessage: string | undefined,
  output: string,
  resultCount: number,
): string | undefined {
  if (killed) return `dotnet test was killed (timeout or signal): ${errorMessage ?? 'no detail'}`;
  if (!failed || resultCount > 0) return undefined;
  return parseFailureMessage(output) ?? errorMessage ?? 'dotnet test failed';
}

/** Every `.trx` this run created, merged: results keyed by FQN, plus run info. */
function collectReport(
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
function worse(left: TrxTestResult, right: TrxTestResult): TrxTestResult {
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
function trxFiles(dir: string): string[] {
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
