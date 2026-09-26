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
import { extensionOf, fileNameOf, joinPath } from './paths';
import { batchByWidth, MAX_ARG_CHARS } from './test-batching.js';
import { DOTNET_TIMEOUT_MS, type DotnetRun } from './dotnet-process.js';
import type { MtpModuleRun, MtpRunPlan } from './test-listing-model.js';
import { MTP_INVALID_COMMAND_LINE, rejectedMtpOption } from './test-mtp.js';
import { relistModule } from './test-mtp-discovery.js';
import { refusedOutcome, runReported, startedModules } from './test-mtp-report.js';
import { buildTarget, builtMtpProjects, dirOf, type MtpProjectScan } from './test-mtp-modules.js';
import { err, ok, type Result } from './result.js';
import { parseMtpSummary, type TestOutcome, type TestRunSummary } from './test-run-output.js';
import { collectReport, trxFiles, worse } from './test-trx-collect.js';
import type { TrxRunInfo, TrxTestResult } from './test-trx.js';
import type { TestRunOptions, TestRunOutcome } from './test-execution.js';

export { runArgs } from './test-mtp-report.js';

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
export function uidsFor(
  module: Pick<MtpModuleRun, 'uidsById'>,
  testIds: readonly string[],
): string[] {
  if (testIds.length === 0) return [];
  return testIds.flatMap((id) => [...(module.uidsById.get(id) ?? [])]);
}

/** True when the module owns none of the selected ids, so it must not start. */
function untouched(module: MtpModuleRun, testIds: readonly string[]): boolean {
  return testIds.length > 0 && uidsFor(module, testIds).length === 0;
}

/**
 * The TRX name of one invocation; `index` counts the run's invocations.
 *
 * Two invocations writing one report name into a shared results directory
 * would overwrite each other, which is the defect [TEST-RUN-TRX] avoids under
 * VSTest by never pinning `LogFileName`. The stem alone cannot tell them apart:
 * the target frameworks of one project build modules sharing ONE file name.
 */
export function trxNameFor(modulePath: string, index: number): string {
  const stem = fileNameOf(modulePath, extensionOf(modulePath));
  return `${stem}.${String(index)}.trx`;
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
  if (rejected === undefined) return resultCount > 0 ? undefined : (errorMessage ?? undefined);
  const extension = EXTENSION_PACKAGES.get(rejected);
  const refusal =
    `${fileNameOf(modulePath)} does not support ${rejected} (MTP exit code ` +
    `${String(MTP_INVALID_COMMAND_LINE)}).`;
  return extension === undefined
    ? refusal
    : `${refusal} Add a PackageReference to ${extension.packageId} so ${extension.purpose}.`;
}

/**
 * The options this path passes that are EXTENSIONS, not part of MTP, and the
 * package that registers each. A module without the package rejects the option,
 * and the only useful message is the one that names it.
 */
const EXTENSION_PACKAGES: ReadonlyMap<string, { packageId: string; purpose: string }> = new Map([
  [
    '--report-trx',
    {
      packageId: 'Microsoft.Testing.Extensions.TrxReport',
      purpose: 'the Test Explorer can read per-test results',
    },
  ],
  [
    '--coverage',
    {
      packageId: 'Microsoft.Testing.Extensions.CodeCoverage',
      purpose: 'Run with Coverage can collect coverage',
    },
  ],
]);

/** What every invocation of one run shares. */
interface RunContext {
  readonly resultsDirectory: string;
  readonly cwd: string;
  readonly options: TestRunOptions;
  /**
   * Invocations started so far in this run. It numbers the TRX reports, so no
   * two invocations of one run ever share a report name — not even the two
   * target frameworks of one project, whose modules share a FILE name and
   * would otherwise overwrite each other's report.
   */
  readonly started: { count: number };
}

/** One `dotnet exec <module>` invocation into `resultsDirectory`. */
async function invoke(
  module: MtpModuleRun,
  uids: readonly string[],
  context: RunContext,
): Promise<TestRunOutcome> {
  const { resultsDirectory, options } = context;
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const before = new Set(trxFiles(resultsDirectory));
  const trxName = nextTrxName(module, context);
  const started = Date.now();
  const run = await runReported({ ...context, modulePath: module.modulePath, uids, trxName });
  const report = collectReport(resultsDirectory, before);
  return outcomeOf(module.modulePath, debugged(run, options), report, Date.now() - started);
}

/**
 * A debug run's exit code is no verdict ([TEST-MTP-DEBUG]): it writes no TRX
 * report, a failing test exits non-zero by design, and stopping the debugger
 * ends the module however it ends. A refused option or a kill still reports.
 */
function debugged(run: DotnetRun, options: TestRunOptions): DotnetRun {
  return options.debug === true ? { ...run, errorMessage: undefined } : run;
}

/** The next report name of this run: no two of its invocations share one. */
function nextTrxName(module: MtpModuleRun, context: RunContext): string {
  const name = trxNameFor(module.modulePath, context.started.count);
  context.started.count += 1;
  return name;
}

/** What one finished invocation reported, and why it reported nothing if so. */
function outcomeOf(
  modulePath: string,
  run: DotnetRun,
  report: { results: Map<string, TrxTestResult>; runInfos: TrxRunInfo[] },
  durationMs: number,
): TestRunOutcome {
  const output = `${run.stdout}\n${run.stderr}`;
  return {
    results: report.results,
    summary: parseMtpSummary(output),
    failure: run.killed
      ? `${fileNameOf(modulePath)} was killed: ${run.errorMessage ?? 'no detail'}`
      : invocationFailure(modulePath, output, run.errorMessage, report.results.size),
    runInfos: report.runInfos,
    retriedUnfiltered: false,
    durationMs,
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
    retriedUnfiltered: left.retriedUnfiltered || right.retriedUnfiltered,
    durationMs: left.durationMs + right.durationMs,
    output: `${left.output}\n${right.output}`,
  };
}

/** Every batch of one module, merged, plus its one unfiltered recovery. */
async function runModule(
  module: MtpModuleRun,
  testIds: readonly string[],
  context: RunContext,
): Promise<TestRunOutcome | undefined> {
  const batches = testIds.length === 0 ? [[]] : uidBatches(uidsFor(module, testIds));
  let merged: TestRunOutcome | undefined;
  for (const batch of batches) {
    if (context.options.signal?.aborted === true) break;
    const one = await invoke(module, batch, context);
    // A batch that reported nothing keeps its failure beside a batch that
    // reported something, or the refusal it hides is never retried.
    merged = merged === undefined ? one : mergeKeepingFailures(merged, one);
  }
  if (merged === undefined || !needsUnfilteredRetry(module, merged, testIds, context)) {
    return merged;
  }
  return await retryUnfiltered(module, merged, context);
}

/** The ONE unfiltered recovery of a module that refused its selection. */
async function retryUnfiltered(
  module: MtpModuleRun,
  refused: TestRunOutcome,
  context: RunContext,
): Promise<TestRunOutcome> {
  const unfiltered = await invoke(module, [], context);
  return {
    ...mergeOutcomes(refused, unfiltered),
    // The retry re-ran the SAME module, so its counts REPLACE the refused
    // attempt's rather than adding to them. Summing is right only ACROSS
    // modules, which is what `mergeOutcomes` does everywhere else.
    summary: unfiltered.summary ?? refused.summary,
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
  // A debug run reads no report: a retry would only start another waiting module.
  if (testIds.length === 0 || context.options.debug === true) return false;
  if (context.options.signal?.aborted === true) return false;
  if (outcome.failure === undefined) return false;
  // A REJECTED option is rejected again without a filter, so retrying only
  // doubles the wait before the user reads the same message.
  if (rejectedMtpOption(outcome.output) !== undefined) return false;
  const mine = testIds.filter((id) => module.uidsById.has(id));
  return mine.some((id) => !outcome.results.has(id));
}

/**
 * Merge two invocations that answer for DIFFERENT tests: two batches, two
 * modules, or two runners. One that reported nothing is not rescued by one
 * that reported something: its failure is the only account its tests get, and
 * the reason a batch's refusal is retried, so every failure is kept. Only the
 * unfiltered retry — the same tests again — replaces a failure with results.
 */
export function mergeKeepingFailures(left: TestRunOutcome, right: TestRunOutcome): TestRunOutcome {
  const failures = [left.failure, right.failure].filter((failure) => failure !== undefined);
  return {
    ...mergeOutcomes(left, right),
    failure: failures.length === 0 ? undefined : failures.join('\n'),
  };
}

/**
 * Build one discovery target, exactly as `dotnet test` does on the VSTest
 * path. `dotnet exec` builds nothing, so without this a test edited since the
 * last discovery would run from its STALE module. A failed build fails that
 * target's modules rather than running whatever an earlier build left behind.
 */
async function rebuild(
  target: string,
  previous: readonly MtpModuleRun[],
  options: TestRunOptions,
): Promise<Result<MtpModuleRun[]>> {
  const timeoutMs = options.timeoutMs ?? DOTNET_TIMEOUT_MS;
  const warnings = await buildTarget(target, dirOf(target), timeoutMs, options.signal);
  if (warnings.length > 0) return err(warnings.join('\n'));
  // OutputPath, AssemblyName and target frameworks may have changed since
  // discovery. Never execute the obsolete DLL merely because it still exists.
  const found = await builtMtpProjects(target, timeoutMs);
  return currentModules(target, found, previous);
}

/** Keep known uids only for a module MSBuild still identifies as current. */
function currentModules(
  target: string,
  found: MtpProjectScan,
  previous: readonly MtpModuleRun[],
): Result<MtpModuleRun[]> {
  if (found.warnings.length > 0) return err(found.warnings.join('\n'));
  const known = new Map(previous.map((module) => [module.modulePath, module.uidsById]));
  return ok(
    found.projects.flatMap((project) =>
      project.modules.map((modulePath) => ({
        modulePath,
        buildTarget: target,
        uidsById: known.get(modulePath) ?? new Map<string, string[]>(),
      })),
    ),
  );
}

/**
 * The modules the selection starts, grouped by the target that builds them.
 *
 * A module is rebuilt from ITS target, never from the run's working directory:
 * in a multi-root workspace that is the FIRST folder, and building it would run
 * the second folder's module as it was before the user's edit.
 */
function byBuildTarget(plan: MtpRunPlan, testIds: readonly string[]): Map<string, MtpModuleRun[]> {
  const groups = new Map<string, MtpModuleRun[]>();
  for (const module of plan.modules) {
    if (untouched(module, testIds)) continue;
    groups.set(module.buildTarget, [...(groups.get(module.buildTarget) ?? []), module]);
  }
  return groups;
}

/** Every module of one target, merged; `undefined` when none started. */
async function runModules(
  modules: readonly MtpModuleRun[],
  testIds: readonly string[],
  context: RunContext,
): Promise<TestRunOutcome | undefined> {
  const { start, refused } = startedModules(modules, testIds, context.options);
  let merged = refused
    .map(refusedOutcome)
    .reduce<TestRunOutcome | undefined>(
      (left, right) => (left === undefined ? right : mergeKeepingFailures(left, right)),
      undefined,
    );
  for (const module of start) {
    if (context.options.signal?.aborted === true) break;
    const one = await runModule(module, testIds, context);
    if (one === undefined) continue;
    merged = merged === undefined ? one : mergeKeepingFailures(merged, one);
  }
  return merged;
}

/**
 * The rebuilt modules with the uids THEIR build reports, when a filter needs
 * uids at all.
 *
 * Discovery's uids describe the build discovery saw. `xunit.v3` hashes a theory
 * row's DATA into its uid, so editing an `[<InlineData>]` row gives that row a
 * new uid: filtering the rebuilt module by the old ones runs every row EXCEPT
 * the edited one, and a row the edit turned red reports green. One listing per
 * module is the price; an unfiltered run pays nothing.
 */
async function relisted(
  modules: readonly MtpModuleRun[],
  testIds: readonly string[],
  context: RunContext,
): Promise<MtpModuleRun[]> {
  if (testIds.length === 0) return [...modules];
  const timeoutMs = context.options.timeoutMs ?? DOTNET_TIMEOUT_MS;
  const fresh: MtpModuleRun[] = [];
  for (const module of modules) fresh.push(await relistModule(module, context.cwd, timeoutMs));
  return fresh;
}

/** Each target is built, then its modules run; one target's failure is its own. */
async function runTargets(
  plan: MtpRunPlan,
  testIds: readonly string[],
  context: RunContext,
): Promise<TestRunOutcome | undefined> {
  let merged: TestRunOutcome | undefined;
  for (const [target, modules] of byBuildTarget(plan, testIds)) {
    if (context.options.signal?.aborted === true) break;
    const rebuilt = await rebuild(target, modules, context.options);
    const one = rebuilt.ok
      ? await runModules(await relisted(rebuilt.value, testIds, context), testIds, context)
      : emptyOutcome(rebuilt.error);
    if (one === undefined) continue;
    merged = merged === undefined ? one : mergeKeepingFailures(merged, one);
  }
  return merged;
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
  const context: RunContext = { resultsDirectory, cwd, options, started: { count: 0 } };
  try {
    return (await runTargets(plan, testIds, context)) ?? emptyOutcome(noModuleRan(plan, options));
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
  return fs.mkdtempSync(joinPath(os.tmpdir(), 'sharplsp-mtp-'));
}
