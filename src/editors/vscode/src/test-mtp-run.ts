/**
 * Running Microsoft.Testing.Platform tests.
 *
 * One invocation per MODULE for the whole selection, never one per test — the
 * same rule [TEST-RUN-TRX] sets for VSTest, and for the same reason: a class of
 * twenty tests must not pay twenty starts.
 *
 * Selection is by `--filter-uid`, which takes the module's own run keys. Those
 * keys are LITERAL values, so the [TEST-FILTER-ESCAPE] grammar does not apply
 * and must not be used: an NUnit uid is
 * `Cs.Nunit.Mtp.CalculatorTests.Adds_Case(2,2,4)`, and escaping its parentheses
 * would make it match nothing.
 *
 * Outcomes come from the TRX report the module writes, read by the same reader
 * the VSTest path uses.
 *
 * Implements [TEST-MTP-RUN].
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { batchByWidth, MAX_ARG_CHARS } from './test-batching.js';
import { DOTNET_TIMEOUT_MS, runDotnet } from './dotnet-process.js';
import type { MtpModuleRun, MtpRunPlan } from './test-listing-model.js';
import { MTP_INVALID_COMMAND_LINE, rejectedMtpOption } from './test-mtp.js';
import { parseMtpSummary, type TestOutcome, type TestRunSummary } from './test-run-output.js';
import { collectReport, trxFiles, worse } from './test-trx-collect.js';
import type { TrxRunInfo, TrxTestResult } from './test-trx.js';
import type { TestRunOptions, TestRunOutcome } from './test-execution.js';

/** Ceiling on the uid arguments handed to ONE invocation. */
export const MAX_UID_ARG_CHARS = MAX_ARG_CHARS;

/**
 * Split uids into batches whose joined argument text stays under the ceiling.
 * A uid is passed as its own argv entry, so its cost is its length plus the
 * separator and the quoting a shell would add.
 */
export function uidBatches(uids: readonly string[], maxChars = MAX_UID_ARG_CHARS): string[][] {
  return batchByWidth(uids, (uid) => uid.length + 3, maxChars);
}

/** The uids one module must run for `testIds`; empty ids mean "run everything". */
export function uidsFor(module: MtpModuleRun, testIds: readonly string[]): string[] {
  if (testIds.length === 0) return [];
  return testIds.flatMap((id) => [...(module.uidsById.get(id) ?? [])]);
}

/** True when the module owns none of the selected ids, so it must not start. */
function untouched(module: MtpModuleRun, testIds: readonly string[]): boolean {
  return testIds.length > 0 && uidsFor(module, testIds).length === 0;
}

/**
 * A TRX name unique to this module.
 *
 * Two modules writing one auto-named report into a shared results directory
 * would overwrite each other, which is the defect [TEST-RUN-TRX] avoids under
 * VSTest by never pinning `LogFileName`.
 */
export function trxNameFor(modulePath: string, batchIndex: number): string {
  const stem = path.basename(modulePath, path.extname(modulePath));
  return `${stem}.${String(batchIndex)}.trx`;
}

/** The argument vector for one module invocation. */
export function runArgs(
  modulePath: string,
  uids: readonly string[],
  resultsDirectory: string,
  options: TestRunOptions,
  trxName: string,
): string[] {
  return [
    'exec',
    modulePath,
    ...(uids.length === 0 ? [] : ['--filter-uid', ...uids]),
    '--report-trx',
    '--report-trx-filename',
    trxName,
    '--results-directory',
    resultsDirectory,
    '--no-banner',
    '--no-ansi',
    // `--no-progress` is deprecated since MTP 2.3 and warns on every run.
    ...(options.coverage === true ? ['--coverage', '--coverage-output-format', 'cobertura'] : []),
  ];
}

/** An empty outcome, so a run that started nothing still has a shape. */
function emptyOutcome(failure: string | undefined): TestRunOutcome {
  return {
    results: new Map(),
    summary: undefined,
    failure,
    runInfos: [],
    retriedUnfiltered: false,
    durationMs: 0,
    output: '',
  };
}

/**
 * The message an invocation earns when it produced no result.
 *
 * Exit code 5 is MTP's "I did not understand the command line". `--report-trx`
 * and `--coverage` are EXTENSIONS, so a module that does not register them
 * exits that way. Naming the missing package is the whole point: a silent empty
 * run reports every selected test as "No result reported" and hides the cause.
 */
function invocationFailure(
  modulePath: string,
  output: string,
  errorMessage: string | undefined,
  resultCount: number,
): string | undefined {
  const rejected = rejectedMtpOption(output);
  if (rejected === '--report-trx') {
    return (
      `${path.basename(modulePath)} does not support ${rejected} (MTP exit code ` +
      `${String(MTP_INVALID_COMMAND_LINE)}). Add a PackageReference to ` +
      'Microsoft.Testing.Extensions.TrxReport so the Test Explorer can read per-test results.'
    );
  }
  if (rejected !== undefined) {
    return `${path.basename(modulePath)} does not support ${rejected}.`;
  }
  return resultCount > 0 ? undefined : (errorMessage ?? undefined);
}

/** One `dotnet exec <module>` invocation into `resultsDirectory`. */
async function invoke(
  module: MtpModuleRun,
  uids: readonly string[],
  batchIndex: number,
  context: { resultsDirectory: string; cwd: string; options: TestRunOptions },
): Promise<TestRunOutcome> {
  const { resultsDirectory, cwd, options } = context;
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const before = new Set(trxFiles(resultsDirectory));
  const args = runArgs(
    module.modulePath,
    uids,
    resultsDirectory,
    options,
    trxNameFor(module.modulePath, batchIndex),
  );
  const started = Date.now();
  const run = await runDotnet(
    args,
    cwd,
    options.timeoutMs ?? DOTNET_TIMEOUT_MS,
    options.signal,
    options.hooks,
  );
  const output = `${run.stdout}\n${run.stderr}`;
  const report = collectReport(resultsDirectory, before);
  return {
    results: report.results,
    summary: parseMtpSummary(output),
    failure: run.killed
      ? `${path.basename(module.modulePath)} was killed: ${run.errorMessage ?? 'no detail'}`
      : invocationFailure(module.modulePath, output, run.errorMessage, report.results.size),
    runInfos: report.runInfos,
    retriedUnfiltered: false,
    durationMs: Date.now() - started,
    output,
  };
}

/** Sum two summaries; one module's counts are never the whole run's. */
function mergeSummaries(
  left: TestRunSummary | undefined,
  right: TestRunSummary | undefined,
): TestRunSummary | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const totals = {
    passed: left.passed + right.passed,
    failed: left.failed + right.failed,
    skipped: left.skipped + right.skipped,
    total: left.total + right.total,
  };
  return { ...totals, outcome: worstSummaryOutcome(left, right) };
}

/** A run of several modules is as bad as its worst module. */
function worstSummaryOutcome(left: TestRunSummary, right: TestRunSummary): TestOutcome {
  const ranked: readonly TestOutcome[] = ['passed', 'skipped', 'notRun', 'failed'];
  return ranked.indexOf(right.outcome) > ranked.indexOf(left.outcome)
    ? right.outcome
    : left.outcome;
}

/** Merge two invocations, keeping the WORST outcome reported for each id. */
export function mergeOutcomes(left: TestRunOutcome, right: TestRunOutcome): TestRunOutcome {
  const results = new Map<string, TrxTestResult>(left.results);
  for (const [name, result] of right.results) {
    const existing = results.get(name);
    results.set(name, existing === undefined ? result : worse(existing, result));
  }
  const runInfos: TrxRunInfo[] = [...left.runInfos, ...right.runInfos];
  return {
    results,
    summary: mergeSummaries(left.summary, right.summary),
    failure: results.size > 0 ? undefined : (left.failure ?? right.failure),
    runInfos,
    retriedUnfiltered: false,
    durationMs: left.durationMs + right.durationMs,
    output: `${left.output}\n${right.output}`,
  };
}

/** Every batch of one module, merged, plus its one unfiltered recovery. */
async function runModule(
  module: MtpModuleRun,
  testIds: readonly string[],
  context: { resultsDirectory: string; cwd: string; options: TestRunOptions },
): Promise<TestRunOutcome | undefined> {
  const uids = uidsFor(module, testIds);
  const batches = testIds.length === 0 ? [[]] : uidBatches(uids);
  let merged: TestRunOutcome | undefined;
  let index = 0;
  for (const batch of batches) {
    if (context.options.signal?.aborted === true) break;
    const one = await invoke(module, batch, index, context);
    merged = merged === undefined ? one : mergeOutcomes(merged, one);
    index += 1;
  }
  if (merged === undefined || !needsUnfilteredRetry(module, merged, testIds, context)) {
    return merged;
  }
  const unfiltered = await invoke(module, [], index, context);
  return {
    ...mergeOutcomes(merged, unfiltered),
    // The retry re-ran the SAME module, so its counts REPLACE the refused
    // attempt's rather than adding to them. Summing is right only ACROSS
    // modules, which is what `mergeOutcomes` does everywhere else.
    summary: unfiltered.summary ?? merged.summary,
    retriedUnfiltered: true,
  };
}

/**
 * True when the module REFUSED the selection rather than merely matching none.
 *
 * A framework bridged onto MTP can translate `--filter-uid` back into a VSTest
 * filter EXPRESSION and then reject its own translation. NUnit does exactly
 * that for a uid carrying both a SPACE and PARENTHESES — which is every
 * idiomatic F# `[<TestCase>]` binding
 * (`Fs.Nunit.Fixtures.adds case(2,2,4)` → "Unexpected FQN 'case\(2,2,4\)' at
 * position 46 in selection expression") — and the whole module then reports
 * nothing, so perfectly runnable tests show as phantom failures.
 *
 * The remedy is the one [TEST-FILTER-ESCAPE] already sets for the VSTest path:
 * re-run the module ONCE without a filter and pick the outcomes out of the
 * report by name. Slower, but correct, and only ever when the module both
 * failed AND left a selected test unreported — never on a selection that
 * legitimately matched nothing.
 */
function needsUnfilteredRetry(
  module: MtpModuleRun,
  outcome: TestRunOutcome,
  testIds: readonly string[],
  context: { options: TestRunOptions },
): boolean {
  if (testIds.length === 0) return false;
  if (context.options.signal?.aborted === true) return false;
  if (outcome.failure === undefined) return false;
  // A REJECTED option is rejected again without a filter, so retrying only
  // doubles the wait before the user reads the same message.
  if (rejectedMtpOption(outcome.output) !== undefined) return false;
  const mine = testIds.filter((id) => module.uidsById.has(id));
  return mine.some((id) => !outcome.results.has(id));
}

/** Run `testIds` (all tests when empty) across the plan's modules. */
export async function runMtpTests(
  plan: MtpRunPlan,
  testIds: readonly string[],
  cwd: string,
  options: TestRunOptions = {},
): Promise<TestRunOutcome> {
  const owned = options.resultsDirectory === undefined;
  const resultsDirectory = options.resultsDirectory ?? freshTempDir();
  const context = { resultsDirectory, cwd, options };
  try {
    let merged: TestRunOutcome | undefined;
    for (const module of plan.modules) {
      if (options.signal?.aborted === true) break;
      if (untouched(module, testIds)) continue;
      const one = await runModule(module, testIds, context);
      if (one === undefined) continue;
      merged = merged === undefined ? one : mergeOutcomes(merged, one);
    }
    return merged ?? emptyOutcome(noModuleRan(plan, options));
  } finally {
    if (owned) fs.rmSync(resultsDirectory, { recursive: true, force: true });
  }
}

/** Why a plan started nothing: cancelled first, or simply empty. */
function noModuleRan(plan: MtpRunPlan, options: TestRunOptions): string | undefined {
  if (options.signal?.aborted === true) return 'Run cancelled before any module started';
  return plan.modules.length === 0 ? 'No Microsoft.Testing.Platform module to run' : undefined;
}

/** A private, empty directory for one run's TRX output. */
function freshTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtp-'));
}
