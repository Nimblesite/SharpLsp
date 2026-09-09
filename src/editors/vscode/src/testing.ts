import * as vscode from 'vscode';
import { effect } from './signals';
import { info } from './log';
import * as state from './state';
import { listTests } from './test-discovery';
import { mergePlans, type MtpRunPlan, type TestListing } from './test-listing-model';
import { runMtpTests } from './test-mtp-run';
import { makeAssemblyItem, makeErrorItem, makeTestItem, type ItemContext } from './test-items';
import {
  cancelled,
  runOptions,
  runTests,
  type RunInvocation,
  type TestRunOptions,
  type TestRunOutcome,
} from './test-execution';
import { debugSelectedTests, type TestDebugHost } from './test-debug';
import { registerRunProfiles, type RunProfileHandlers } from './test-profiles';
import {
  addCoverage,
  cachedFrom,
  freshCoverageDir,
  reportAll,
  reportOutcome,
  type CachedTestResult,
} from './test-reporting';
import { DotnetQueue } from './test-queue';
import { TestResultCache } from './test-result-cache';
import { cancellationSignal, configureDotnet } from './dotnet-process';
import { discoveryTargets, dirOf, filterIdsFor, runCwd, runTarget } from './test-targets';

export { buildFilterArgs } from './test-execution';
export { isExpectoTest, isFsCheckTest } from './test-targets';
export type { CachedTestResult } from './test-reporting';

/**
 * Debounce for reactive re-discovery. Loading a solution can churn the
 * `solutionPath` signal several times in quick succession; collapse the burst
 * into a single `dotnet test --list-tests` sweep.
 */
const DISCOVERY_DEBOUNCE_MS = 1_000;

/**
 * Test controller integrating with VS Code's Testing API.
 * Discovers tests by fully-qualified name (see `test-discovery.ts`), renders
 * them grouped per the documented hierarchy — **Assembly → Namespace → Class →
 * Test** — and runs them in `dotnet test` invocations whose `--filter` stays
 * under the Windows command-line ceiling, reading per-test outcomes back out
 * of the TRX report (see `test-execution.ts`).
 * Supports xUnit, NUnit, MSTest, Expecto, and FsCheck.
 *
 * Implements [TEST-EXPLORER], [TEST-REACTIVITY] and [TEST-RUN-TRX].
 */
export class SharpLspTestController {
  private readonly controller: vscode.TestController;
  private readonly runProfiles: vscode.TestRunProfile[] = [];
  private readonly results = new TestResultCache();
  /** Cancels the reactive solution-change subscription. */
  private readonly solutionSubscription: () => void;
  /** Cancels the reactive `dotnet` executable subscription. */
  private readonly dotnetSubscription: () => void;
  /** Pending debounced discovery timer, if any. */
  private debounceHandle: ReturnType<typeof setTimeout> | undefined;
  /** Monotonic id so a superseded discovery sweep never clobbers a newer one. */
  private discoverGeneration = 0;
  /**
   * True once the user has engaged the Test Explorer (revealed the view or hit
   * refresh). Discovery runs `dotnet test` — a full build — so we do NOT do that
   * as a side effect of merely loading a solution; only once tests are actually
   * being shown does a solution change reactively re-discover.
   */
  private active = false;
  /** One `dotnet` invocation at a time, discovery and runs alike. */
  private readonly dotnetQueue = new DotnetQueue();
  /**
   * How to RUN what the last sweep discovered, when the runner was
   * Microsoft.Testing.Platform. `undefined` means VSTest, whose test ids ARE
   * the filter values. Spec: [TEST-MTP-RUN].
   */
  private mtpPlan: MtpRunPlan | undefined;

  /** Fires after any test run completes and results are cached. */
  public readonly onResultsChanged = this.results.onChanged;

  /** Queue `work` behind any `dotnet` invocation already in flight. */
  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    return await this.dotnetQueue.enqueue(work);
  }

  /** Resolve once no `dotnet` invocation is outstanding. */
  public async whenIdle(): Promise<void> {
    await this.dotnetQueue.whenIdle();
  }

  /** Look up the last known result for a fully qualified test name. */
  public getResult(fullyQualifiedName: string): CachedTestResult | undefined {
    return this.results.get(fullyQualifiedName);
  }

  /** All cached results keyed by fully qualified test name. */
  public get cachedResults(): ReadonlyMap<string, CachedTestResult> {
    return this.results.all;
  }

  /** Discovered test items (delegates to the underlying TestController). */
  public get items(): vscode.TestItemCollection {
    return this.controller.items;
  }

  /**
   * The registered run profiles — Run, Debug and Run with Coverage, in that
   * order. Exposed so tests can invoke the very handler VS Code invokes when the
   * user presses the corresponding button in the Test Explorer.
   */
  public get profiles(): readonly vscode.TestRunProfile[] {
    return this.runProfiles;
  }

  /** Create a TestItem for `fullName` without adding it to the tree. */
  public createItem(fullName: string, uri: vscode.Uri): vscode.TestItem {
    return makeTestItem({ controller: this.controller, uri, locations: undefined }, fullName);
  }

  constructor() {
    this.controller = vscode.tests.createTestController(
      'sharplsp.testController',
      'SharpLsp Tests',
    );
    this.runProfiles.push(...registerRunProfiles(this.controller, this.profileHandlers()));
    // `dotnet` is not necessarily on `$PATH`: [DIST-RUNTIME-ACQUIRE] resolves an
    // SDK that may live anywhere and publishes its path on a signal. Track it
    // reactively so discovery and runs follow a late or re-acquired SDK instead
    // of failing with ENOENT on a bare `dotnet`.
    this.dotnetSubscription = effect(() => {
      configureDotnet(state.dotnetPath.value);
    });
    // VS Code's refresh affordance and the initial view reveal drive the first
    // discovery and mark the controller active.
    this.controller.refreshHandler = async (): Promise<void> => {
      await this.activateAndDiscover();
    };
    this.controller.resolveHandler = async (item): Promise<void> => {
      if (item === undefined) {
        await this.activateAndDiscover();
      }
    };
    // Reactive: once tests are being shown, a change to the loaded solution must
    // reactively re-discover with no manual refresh. Debounced to collapse the
    // burst a solution load emits. Gated on `active` so merely loading a solution
    // never triggers a background build before the user looks at tests.
    this.solutionSubscription = state.solutionPath.subscribe(() => {
      if (this.active) {
        this.scheduleDiscovery();
      }
    });
  }

  /** Mark the Test Explorer active and run a discovery sweep. */
  public async activateAndDiscover(): Promise<void> {
    this.active = true;
    await this.discover();
  }

  public dispose(): void {
    this.solutionSubscription();
    this.dotnetSubscription();
    if (this.debounceHandle !== undefined) {
      clearTimeout(this.debounceHandle);
    }
    for (const profile of this.runProfiles) {
      profile.dispose();
    }
    this.results.dispose();
    this.controller.dispose();
  }

  /** Debounced trigger for reactive re-discovery on solution change. */
  private scheduleDiscovery(): void {
    if (this.debounceHandle !== undefined) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = undefined;
      void this.discover();
    }, DISCOVERY_DEBOUNCE_MS);
  }

  /**
   * Discover every test in the loaded solution (or, absent one, each workspace
   * folder) and replace the tree. A superseded sweep never clobbers a newer one,
   * and a sweep where NO target could be enumerated leaves the previous tree
   * standing — with an error row appended saying why — rather than blanking the
   * view on a transient `dotnet` failure.
   */
  public async discover(): Promise<void> {
    const generation = ++this.discoverGeneration;
    const targets = discoveryTargets();
    const items: vscode.TestItem[] = [];
    const errors: vscode.TestItem[] = [];
    const plans: MtpRunPlan[] = [];
    let anyOk = targets.length === 0;
    for (const target of targets) {
      // A newer sweep supersedes this one: stop before paying for another build
      // rather than enumerating targets whose results will be thrown away.
      if (generation !== this.discoverGeneration) return;
      const listing = await this.safeList(target);
      anyOk = anyOk || listing.ok;
      if (listing.mtp !== undefined) plans.push(listing.mtp);
      this.rowsFor(target, listing, items, errors);
    }
    if (generation !== this.discoverGeneration) return;
    this.mtpPlan = mergePlans(plans);
    this.applyDiscovery(items, errors, anyOk, targets.length);
  }

  /** Turn one target's listing into tree rows, or into the row that explains it. */
  private rowsFor(
    target: string,
    listing: TestListing,
    items: vscode.TestItem[],
    errors: vscode.TestItem[],
  ): void {
    const context: ItemContext = {
      controller: this.controller,
      uri: vscode.Uri.file(dirOf(target)),
      locations: listing.locations,
    };
    if (!listing.ok && listing.names.length === 0) {
      // The enumeration itself failed: surface the real diagnostic as a row,
      // never a silent blank view (MSB1011 ambiguity, build errors, missing
      // target — the cases the extension log showed going unnoticed).
      errors.push(makeErrorItem(context, target, listing.warnings));
      return;
    }
    if (listing.byAssembly.length > 0) {
      for (const assembly of listing.byAssembly) items.push(makeAssemblyItem(context, assembly));
      return;
    }
    // Display-name fallback: no attribution, so flat rows — weaker, but never
    // worse than dropping the tests outright.
    for (const fqn of listing.names) items.push(makeTestItem(context, fqn));
  }

  /**
   * Replace the tree, unless nothing could be enumerated and one already exists
   * — a transient failure (a `dotnet` file lock mid-sweep) then keeps the
   * standing tree, logged but not perturbed, so a good view never flaps. Error
   * rows appear only when a tree is actually (re)built: a total failure over an
   * EMPTY view surfaces the real diagnostic instead of silent blankness.
   */
  private applyDiscovery(
    items: vscode.TestItem[],
    errors: vscode.TestItem[],
    anyOk: boolean,
    targetCount: number,
  ): void {
    if (!anyOk && items.length === 0 && this.controller.items.size > 0) {
      info(
        `Test discovery: every target failed; keeping ${String(
          this.controller.items.size,
        )} item(s) standing`,
      );
      return;
    }
    this.controller.items.replace([...items, ...errors]);
    this.results.pruneTo([...items, ...errors]);
    info(
      `Test discovery: ${String(items.length)} item(s) from ${String(targetCount)} target(s)` +
        (errors.length > 0 ? `; ${String(errors.length)} error row(s)` : ''),
    );
  }

  /** List one target, logging whatever diagnostics the enumeration produced. */
  private async safeList(target: string): Promise<TestListing> {
    const listing = await this.enqueue(async () => await listTests(target));
    for (const warning of listing.warnings) {
      info(`Test discovery (${target}): ${warning}`);
    }
    return listing;
  }

  /** The Run and Run-with-Coverage profiles share every step but collection. */
  private async runProfileHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    coverage: boolean,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const tests = this.collectTests(request);
    for (const test of tests) run.enqueued(test);
    try {
      const filterIds = filterIdsFor(request, tests);
      if (request.include !== undefined && tests.length === 0) return;
      await this.executeInto(run, tests, token, coverage, filterIds);
    } finally {
      run.end();
      this.results.fire();
    }
  }

  /** Invoke `dotnet test` for `tests` and report every outcome onto `run`. */
  private async executeInto(
    run: vscode.TestRun,
    tests: readonly vscode.TestItem[],
    token: vscode.CancellationToken,
    coverage: boolean,
    filterIds: readonly string[],
  ): Promise<void> {
    const cwd = runCwd();
    if (cwd === undefined) {
      reportAll(run, tests, 'No workspace folder or solution', this.results.writer());
      return;
    }
    if (cancelled(token)) return;
    for (const test of tests) run.started(test);
    const resultsDirectory = coverage ? freshCoverageDir(cwd) : undefined;
    const outcome = await this.invoke({ filterIds, cwd, token, coverage, resultsDirectory });
    // ⏹ means STOP. The whole selection runs in `dotnet test` invocations which
    // the token has just killed mid-flight, so whatever they managed to write
    // is a TRUNCATED account of a run the user abandoned: never cache or paint it.
    if (cancelled(token)) return;
    reportOutcome(run, tests, outcome, this.results.writer());
    if (coverage && resultsDirectory !== undefined) addCoverage(run, resultsDirectory);
  }

  /** One queued, CANCELLABLE `dotnet test` over the whole selection. */
  private async invoke(request: RunInvocation): Promise<TestRunOutcome> {
    const cancellation = cancellationSignal(request.token);
    const options = runOptions(request, cancellation.signal);
    try {
      return await this.enqueue(
        async () => await this.dispatch(request.filterIds, request.cwd, options),
      );
    } finally {
      cancellation.dispose();
    }
  }

  /** Send one invocation to the runner the last discovery sweep chose. */
  private async dispatch(
    ids: readonly string[],
    cwd: string,
    options: TestRunOptions,
  ): Promise<TestRunOutcome> {
    const plan = this.mtpPlan;
    if (plan === undefined) return await runTests(ids, cwd, options);
    return await runMtpTests(plan, ids, cwd, options);
  }

  /**
   * The Debug profile: run the selection under `VSTEST_HOST_DEBUG=1` and
   * attach the debugger to the waiting TEST HOST child, never to the parent
   * `dotnet test`. Resolves once the first attach settles or the run dies
   * before any host waits ([DEBUG-FEATURES-TESTS]).
   */
  private async debugTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const tests = this.collectTests(request);
    if (tests.length === 0 || cancelled(token)) return;
    const run = this.controller.createTestRun(request);
    const cwd = runCwd();
    if (cwd === undefined) {
      // No cache writes: a debug gesture must never fabricate a run result.
      reportAll(run, tests, 'No workspace folder or solution', () => undefined);
      run.end();
      return;
    }
    for (const test of tests) run.started(test);
    await debugSelectedTests(
      this.debugHost(),
      run,
      tests,
      token,
      cwd,
      filterIdsFor(request, tests),
    );
  }

  /** The three handlers the Test Explorer's profiles invoke. */
  private profileHandlers(): RunProfileHandlers {
    return {
      run: async (request, token) => {
        await this.runProfileHandler(request, token, false);
      },
      debug: async (request, token) => {
        await this.debugTests(request, token);
      },
      coverage: async (request, token) => {
        await this.runProfileHandler(request, token, true);
      },
    };
  }

  /** The slice of this controller the test-debug flow needs. */
  private debugHost(): TestDebugHost {
    return {
      enqueue: async (work) => await this.enqueue(work),
      runSelection: async (ids, cwd, options) => await this.dispatch(ids, cwd, options),
      // Run-only reporting: a debug run neither caches results nor announces a
      // results change — the last real run's outcome stands.
      finish: (run, tests, outcome) => {
        reportOutcome(run, tests, outcome, undefined);
      },
    };
  }

  /**
   * The tests a request selects: its `include` set (or the whole tree when it
   * has none), minus everything the user explicitly EXCLUDED. Ignoring
   * `exclude` runs tests the user just deselected in the Testing view. Group
   * nodes expand to their leaf tests — a class or namespace ▶ runs its members
   * — and discovery-error rows are never selectable as tests.
   */
  private collectTests(request: vscode.TestRunRequest): vscode.TestItem[] {
    const excluded = new Set((request.exclude ?? []).map((item) => item.id));
    const tests: vscode.TestItem[] = [];
    const walk = (item: vscode.TestItem): void => {
      if (excluded.has(item.id)) return;
      if (item.error !== undefined) return;
      if (item.children.size === 0) {
        tests.push(item);
        return;
      }
      item.children.forEach(walk);
    };
    if (request.include !== undefined) {
      for (const item of request.include) walk(item);
      return tests;
    }
    this.controller.items.forEach(walk);
    return tests;
  }

  /**
   * Run a single test by id, cache the result, and notify listeners. `cwd`
   * overrides the working directory (the loaded solution's folder by default) —
   * used by callers targeting a project outside the workspace.
   */
  public async runSingle(testId: string, cwd?: string): Promise<CachedTestResult> {
    const folder = cwd ?? runCwd();
    const result =
      folder === undefined
        ? { outcome: 'notRun' as const, passed: false, message: 'No workspace folder or solution' }
        : await this.runOne(testId, folder, cwd === undefined);
    this.results.set(testId, result);
    this.results.fire();
    return result;
  }

  /** One `dotnet test` invocation restricted to a single fully-qualified name. */
  private async runOne(testId: string, cwd: string, useTarget: boolean): Promise<CachedTestResult> {
    // Only the DEFAULT working directory implies the loaded solution. A caller
    // that overrode `cwd` is pointing at a specific project, and naming the
    // solution as well would run the wrong thing.
    const target = useTarget ? runTarget() : undefined;
    const options: TestRunOptions = target === undefined ? {} : { target };
    const outcome = await this.enqueue(async () => await this.dispatch([testId], cwd, options));
    const result = outcome.results.get(testId);
    if (result !== undefined) return cachedFrom(result);
    const message = outcome.failure ?? `No result reported for ${testId}`;
    info(`Test execution produced no result for ${testId}: ${message}`);
    return { outcome: 'notRun', passed: false, duration: outcome.durationMs, message };
  }
}

/**
 * Register the test controller.
 */
export function registerTestExplorer(context: vscode.ExtensionContext): SharpLspTestController {
  const controller = new SharpLspTestController();
  context.subscriptions.push({
    dispose: () => {
      controller.dispose();
    },
  });
  info('Test explorer registered');
  return controller;
}
