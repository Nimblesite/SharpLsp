/**
 * Running ONE target framework of every multi-targeted test project.
 *
 * `dotnet test <solution> --framework net48` forces the framework onto every
 * test project, and each one that does not target it fails NETSDK1005. So the
 * target is built once, then VSTest runs that framework's BUILT assemblies
 * directly — the containers an IDE runs per framework. The same path debugs a
 * selection under its .NET frameworks only, so no .NET Framework host is ever
 * started for a debugger that cannot attach to it.
 *
 * Implements [NETFX-TEST-PROFILES] and [NETFX-DEBUG].
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DOTNET_TIMEOUT_MS, cancellationSignal, runDotnet } from './dotnet-process.js';
import { info } from './log.js';
import { batchAssemblies } from './test-discovery.js';
import {
  cancelled,
  mergeRuns,
  needsUnfilteredRetry,
  outcomeOf,
  type TestRunOptions,
  type TestRunOutcome,
} from './test-execution.js';
import { filterBatches, filterExpression } from './test-filter.js';
import { compareFrameworks, TFM_TAG_PREFIX, type FrameworkIndex } from './test-frameworks.js';
import { buildTarget, dirOf } from './test-mtp-modules.js';
import { mergeKeepingFailures } from './test-mtp-run.js';
import { reportAll, type CacheWriter } from './test-reporting.js';
import { filterIdsFor, runCwd, runTarget } from './test-targets.js';
import { trxFiles } from './test-trx-collect.js';
import { RETRYING_RM } from './utils.js';

/** The `dotnet vstest` argument vector for one batch; no ids runs everything. */
export function vstestArgs(
  assemblies: readonly string[],
  ids: readonly string[],
  resultsDirectory: string,
): string[] {
  return [
    'vstest',
    ...assemblies,
    ...(ids.length === 0 ? [] : [`--TestCaseFilter:${filterExpression(ids)}`]),
    '--logger:trx',
    `--ResultsDirectory:${resultsDirectory}`,
  ];
}

/** An outcome for a run that never reached VSTest. */
function failedBefore(failure: string): TestRunOutcome {
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

/** One `dotnet vstest` over `assemblies` into `dir`. */
async function invokeVsTest(
  assemblies: readonly string[],
  ids: readonly string[],
  cwd: string,
  dir: string,
  options: TestRunOptions,
): Promise<TestRunOutcome> {
  fs.mkdirSync(dir, { recursive: true });
  const before = new Set(trxFiles(dir));
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DOTNET_TIMEOUT_MS;
  const args = vstestArgs(assemblies, ids, dir);
  const run = await runDotnet(args, cwd, timeoutMs, options.signal, options.hooks);
  return outcomeOf(run, dir, before, Date.now() - started);
}

/**
 * One batch, plus the unfiltered retry an adapter's refused filter earns — the
 * same recovery `dotnet test` gets ([TEST-FILTER-ESCAPE]); never for a debug or
 * cancelled run.
 */
async function runBatch(
  assemblies: readonly string[],
  ids: readonly string[],
  cwd: string,
  dir: string,
  options: TestRunOptions,
): Promise<TestRunOutcome> {
  const filtered = await invokeVsTest(assemblies, ids, cwd, dir, options);
  if (options.debug === true || options.signal?.aborted === true) return filtered;
  if (!needsUnfilteredRetry(filtered, ids)) return filtered;
  return mergeRuns(filtered, await invokeVsTest(assemblies, [], cwd, dir, options));
}

/** Every assembly batch × filter batch, merged with every failure kept. */
async function runBatches(
  assemblies: readonly string[],
  ids: readonly string[],
  cwd: string,
  dir: string,
  options: TestRunOptions,
): Promise<TestRunOutcome> {
  let merged: TestRunOutcome | undefined;
  for (const group of batchAssemblies(assemblies)) {
    for (const batch of ids.length === 0 ? [[]] : filterBatches(ids)) {
      if (options.signal?.aborted === true) break;
      const one = await runBatch(group, batch, cwd, dir, options);
      merged = merged === undefined ? one : mergeKeepingFailures(merged, one);
    }
  }
  return merged ?? failedBefore('Run cancelled before any batch started');
}

/**
 * Build the target once, then run `ids` (all when empty) in `assemblies` only.
 * A failed build fails the run: the assemblies an earlier build left behind
 * are never run in its place.
 */
export async function runAssemblies(
  assemblies: readonly string[],
  ids: readonly string[],
  cwd: string,
  options: TestRunOptions,
): Promise<TestRunOutcome> {
  if (assemblies.length === 0) return failedBefore('No built test assembly for this framework');
  const target = options.target ?? cwd;
  const timeoutMs = options.timeoutMs ?? DOTNET_TIMEOUT_MS;
  const built = await buildTarget(target, dirOf(target), timeoutMs, options.signal);
  if (built.length > 0) return failedBefore(built.join('\n'));
  const owned = options.resultsDirectory === undefined;
  const dir = options.resultsDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-tfm-'));
  try {
    return await runBatches(assemblies, ids, cwd, dir, options);
  } finally {
    if (owned) fs.rmSync(dir, RETRYING_RM);
  }
}

/** Every built assembly of `frameworks`, in framework order. */
export function assembliesOf(index: FrameworkIndex, frameworks: readonly string[]): string[] {
  return [...frameworks].sort(compareFrameworks).flatMap((each) => index.assembliesFor(each));
}

/** What every profile's request reads from the controller. */
export interface ControllerAccess {
  readonly controller: vscode.TestController;
  collect(request: vscode.TestRunRequest): vscode.TestItem[];
  enqueue<T>(work: () => Promise<T>): Promise<T>;
}

/** What a `Run on <tfm>` profile needs from the controller. */
export interface FrameworkRunHost extends ControllerAccess {
  frameworks(): FrameworkIndex;
  /** Report onto the run AND the result cache, then announce the change. */
  report(run: vscode.TestRun, tests: readonly vscode.TestItem[], outcome: TestRunOutcome): void;
  writer(): CacheWriter;
}

/** True when `test` exists in `framework`'s build. */
function builtFor(test: vscode.TestItem, framework: string): boolean {
  return test.tags.some((tag) => tag.id === `${TFM_TAG_PREFIX}${framework}`);
}

/** The `Run on <tfm>` handler: the selection's tests that exist in `framework`. */
export async function runFrameworkProfile(
  host: FrameworkRunHost,
  framework: string,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const run = host.controller.createTestRun(request);
  const tests = host.collect(request).filter((test) => builtFor(test, framework));
  for (const test of tests) run.enqueued(test);
  try {
    await executeFramework(host, framework, { run, tests, request, token });
  } finally {
    run.end();
  }
}

/** One framework profile invocation's moving parts. */
interface FrameworkRun {
  readonly run: vscode.TestRun;
  readonly tests: readonly vscode.TestItem[];
  readonly request: vscode.TestRunRequest;
  readonly token: vscode.CancellationToken;
}

async function executeFramework(
  host: FrameworkRunHost,
  framework: string,
  { run, tests, request, token }: FrameworkRun,
): Promise<void> {
  const cwd = runCwd();
  if (cwd === undefined) {
    reportAll(run, tests, 'No workspace folder or solution', host.writer());
    return;
  }
  if (tests.length === 0 || cancelled(token)) return;
  for (const test of tests) run.started(test);
  const cancellation = cancellationSignal(token);
  const target = runTarget();
  const options: TestRunOptions = {
    signal: cancellation.signal,
    ...(target === undefined ? {} : { target }),
  };
  const ids = filterIdsFor(request, tests);
  info(`Test run on ${framework}: ${String(tests.length)} test(s)`);
  try {
    const assemblies = host.frameworks().assembliesFor(framework);
    const outcome = await host.enqueue(
      async () => await runAssemblies(assemblies, ids, cwd, options),
    );
    if (!cancelled(token)) host.report(run, tests, outcome);
  } finally {
    cancellation.dispose();
  }
}

/**
 * One `Run on <tfm>` profile per framework a multi-targeted project builds,
 * scoped by that framework's tag. Kept in step with every sweep.
 */
export class FrameworkProfiles {
  private readonly profiles = new Map<string, vscode.TestRunProfile>();

  constructor(
    private readonly controller: vscode.TestController,
    private readonly handler: (
      framework: string,
      request: vscode.TestRunRequest,
      token: vscode.CancellationToken,
    ) => Promise<void>,
  ) {}

  /** The live profiles, in framework order. */
  public get all(): vscode.TestRunProfile[] {
    return [...this.profiles]
      .sort(([left], [right]) => compareFrameworks(left, right))
      .map(([, profile]) => profile);
  }

  /** Create the missing profiles and dispose the stale ones. */
  public update(frameworks: readonly string[]): void {
    for (const [framework, profile] of this.profiles) {
      if (frameworks.includes(framework)) continue;
      profile.dispose();
      this.profiles.delete(framework);
    }
    for (const framework of frameworks) {
      if (!this.profiles.has(framework)) this.profiles.set(framework, this.create(framework));
    }
  }

  private create(framework: string): vscode.TestRunProfile {
    return this.controller.createRunProfile(
      `Run on ${framework}`,
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        await this.handler(framework, request, token);
      },
      false,
      new vscode.TestTag(`${TFM_TAG_PREFIX}${framework}`),
    );
  }

  public dispose(): void {
    for (const profile of this.profiles.values()) profile.dispose();
    this.profiles.clear();
  }
}
