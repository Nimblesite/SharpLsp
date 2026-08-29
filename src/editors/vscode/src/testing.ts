import * as vscode from 'vscode';
import { effect } from './signals';
import { info } from './log';
import * as state from './state';
import { listTests, type TestListing } from './test-discovery';
import {
  cancelled,
  runOptions,
  runTests,
  type RunInvocation,
  type TestRunOutcome,
} from './test-execution';
import { debugSelectedTests, type TestDebugHost } from './test-debug';
import { loadDetailedCoverage } from './test-coverage';
import {
  addCoverage,
  cachedFrom,
  freshCoverageDir,
  reportAll,
  reportOutcome,
  type CacheWriter,
  type CachedTestResult,
} from './test-reporting';
import { cancellationSignal, configureDotnet } from './dotnet-process';
import {
  discoveryTargets,
  dirOf,
  isExpectoTest,
  isFsCheckTest,
  runCwd,
  runTarget,
} from './test-targets';

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
 * Discovers tests by fully-qualified name (see `test-discovery.ts`) and runs
 * them in a single `dotnet test` invocation, reading per-test outcomes back out
 * of the TRX report (see `test-execution.ts`).
 * Supports xUnit, NUnit, MSTest, Expecto, and FsCheck.
 *
 * Implements [TEST-EXPLORER], [TEST-REACTIVITY] and [TEST-RUN-TRX].
 */
export class SharpLspTestController {
  private readonly controller: vscode.TestController;
  private readonly runProfiles: vscode.TestRunProfile[] = [];
  private readonly results = new Map<string, CachedTestResult>();
  private readonly resultsChangedEmitter = new vscode.EventEmitter<void>();
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
  /**
   * Serializes every `dotnet` invocation this controller makes. Discovery BUILDS
   * the solution and a run rebuilds the same projects, so two overlapping
   * invocations race on the shared `bin/`/`obj/` output — VSTest then dies with
   * "The application to execute does not exist: ...testhost.dll". Reactive
   * re-discovery is debounced, not cancelled, so that overlap is reachable
   * whenever a user runs a test while a sweep is still building. One at a time.
   */
  private dotnetQueue: Promise<unknown> = Promise.resolve();

  /** Fires after any test run completes and results are cached. */
  public readonly onResultsChanged = this.resultsChangedEmitter.event;

  /** Queue `work` behind any `dotnet` invocation already in flight. */
  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.dotnetQueue.then(work, work);
    this.dotnetQueue = next.catch(() => undefined);
    return await next;
  }

  /**
   * Resolve once no `dotnet` invocation is outstanding. Tests use this to settle
   * reactive re-discovery before touching the fixture on disk; a `dotnet test`
   * left pointing at a deleted directory hangs and poisons the next run.
   */
  public async whenIdle(): Promise<void> {
    let tail: Promise<unknown> | undefined;
    while (tail !== this.dotnetQueue) {
      tail = this.dotnetQueue;
      await tail;
    }
  }

  /** Look up the last known result for a fully qualified test name. */
  public getResult(fullyQualifiedName: string): CachedTestResult | undefined {
    return this.results.get(fullyQualifiedName);
  }

  /** All cached results keyed by fully qualified test name. */
  public get cachedResults(): ReadonlyMap<string, CachedTestResult> {
    return this.results;
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
    return this.makeTestItem(fullName, uri);
  }

  constructor() {
    this.controller = vscode.tests.createTestController(
      'sharplsp.testController',
      'SharpLsp Tests',
    );
    this.registerProfiles();
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

  /** Run, Debug and Coverage, in the order the Test Explorer shows them. */
  private registerProfiles(): void {
    this.runProfiles.push(
      this.controller.createRunProfile(
        'Run',
        vscode.TestRunProfileKind.Run,
        async (request, token) => {
          await this.runProfileHandler(request, token, false);
        },
        true,
      ),
      this.controller.createRunProfile(
        'Debug',
        vscode.TestRunProfileKind.Debug,
        async (request, token) => {
          await this.debugTests(request, token);
        },
      ),
    );
    const coverage = this.controller.createRunProfile(
      'Run with Coverage',
      vscode.TestRunProfileKind.Coverage,
      async (request, token) => {
        await this.runProfileHandler(request, token, true);
      },
    );
    coverage.loadDetailedCoverage =
      // eslint-disable-next-line @typescript-eslint/require-await -- VS Code API requires Thenable return but lookup is synchronous
      async (_run, fileCoverage, _token) => loadDetailedCoverage(fileCoverage);
    this.runProfiles.push(coverage);
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
    this.resultsChangedEmitter.dispose();
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
   * standing rather than blanking the view on a transient `dotnet` failure.
   */
  public async discover(): Promise<void> {
    const generation = ++this.discoverGeneration;
    const targets = discoveryTargets();
    const items: vscode.TestItem[] = [];
    let anyOk = targets.length === 0;
    for (const target of targets) {
      // A newer sweep supersedes this one: stop before paying for another build
      // rather than enumerating targets whose results will be thrown away.
      if (generation !== this.discoverGeneration) return;
      const listing = await this.safeList(target);
      anyOk = anyOk || listing.ok;
      const uri = vscode.Uri.file(dirOf(target));
      for (const fqn of listing.names) {
        items.push(this.makeTestItem(fqn, uri));
      }
    }
    if (generation !== this.discoverGeneration) return;
    this.applyDiscovery(items, anyOk, targets.length);
  }

  /** Replace the tree, unless nothing could be enumerated and one already exists. */
  private applyDiscovery(items: vscode.TestItem[], anyOk: boolean, targetCount: number): void {
    if (!anyOk && this.controller.items.size > 0) {
      info(
        `Test discovery: every target failed; keeping ${String(this.controller.items.size)} item(s)`,
      );
      return;
    }
    this.controller.items.replace(items);
    this.pruneResults(new Set(items.map((item) => item.id)));
    info(`Test discovery: ${String(items.length)} test(s) from ${String(targetCount)} target(s)`);
  }

  /**
   * Drop cached outcomes for tests no longer in the tree. The cache is keyed
   * by fully-qualified name and outlives sweeps, so after the loaded solution
   * changes it would paint an outcome for a test that was never run here —
   * [TEST-REACTIVITY]: a result must not outlive the test it belongs to.
   * Listeners hear about it only when something was actually dropped.
   */
  private pruneResults(alive: ReadonlySet<string>): void {
    let dropped = 0;
    for (const id of [...this.results.keys()]) {
      if (alive.has(id)) continue;
      this.results.delete(id);
      dropped += 1;
    }
    if (dropped > 0) this.resultsChangedEmitter.fire();
  }

  /** List one target, logging whatever diagnostics the enumeration produced. */
  private async safeList(target: string): Promise<TestListing> {
    const listing = await this.enqueue(async () => await listTests(target));
    for (const warning of listing.warnings) {
      info(`Test discovery (${target}): ${warning}`);
    }
    return listing;
  }

  /** Build a flat TestItem for a fully-qualified name, tagging F# tests. */
  private makeTestItem(fullName: string, uri: vscode.Uri): vscode.TestItem {
    const parts = fullName.split('.');
    const label = parts.at(-1) ?? fullName;
    const item = this.controller.createTestItem(fullName, label, uri);
    item.description = fullName;
    if (isExpectoTest(fullName) || isFsCheckTest(fullName)) {
      item.tags = [new vscode.TestTag('fsharp')];
    }
    return item;
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
      await this.executeInto(run, tests, token, coverage);
    } finally {
      run.end();
      this.resultsChangedEmitter.fire();
    }
  }

  /** Invoke `dotnet test` for `tests` and report every outcome onto `run`. */
  private async executeInto(
    run: vscode.TestRun,
    tests: readonly vscode.TestItem[],
    token: vscode.CancellationToken,
    coverage: boolean,
  ): Promise<void> {
    const cwd = runCwd();
    if (cwd === undefined) {
      reportAll(run, tests, 'No workspace folder or solution', this.cacheWriter());
      return;
    }
    if (cancelled(token)) return;
    for (const test of tests) run.started(test);
    const resultsDirectory = coverage ? freshCoverageDir(cwd) : undefined;
    const outcome = await this.invoke({ tests, cwd, token, coverage, resultsDirectory });
    // ⏹ means STOP. The whole selection runs in ONE `dotnet test`, which the
    // token has just killed mid-flight, so whatever it managed to write is a
    // TRUNCATED account of a run the user abandoned: never cache or paint it.
    if (cancelled(token)) return;
    reportOutcome(run, tests, outcome, this.cacheWriter());
    if (coverage && resultsDirectory !== undefined) addCoverage(run, resultsDirectory);
  }

  /** One queued, CANCELLABLE `dotnet test` over the whole selection. */
  private async invoke(request: RunInvocation): Promise<TestRunOutcome> {
    const ids = request.tests.map((test) => test.id);
    const cancellation = cancellationSignal(request.token);
    const options = runOptions(request, cancellation.signal);
    try {
      return await this.enqueue(async () => await runTests(ids, request.cwd, options));
    } finally {
      cancellation.dispose();
    }
  }

  private cache(testId: string, result: CachedTestResult): void {
    this.results.set(testId, result);
  }

  /** The cache writer a real RUN reports through; a debug run passes none. */
  private cacheWriter(): CacheWriter {
    return (id, result) => {
      this.cache(id, result);
    };
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
    await debugSelectedTests(this.debugHost(), run, tests, token, cwd);
  }

  /** The slice of this controller the test-debug flow needs. */
  private debugHost(): TestDebugHost {
    return {
      enqueue: async (work) => await this.enqueue(work),
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
   * `exclude` runs tests the user just deselected in the Testing view.
   */
  private collectTests(request: vscode.TestRunRequest): vscode.TestItem[] {
    const excluded = new Set((request.exclude ?? []).map((item) => item.id));
    const tests: vscode.TestItem[] = [];
    if (request.include !== undefined) {
      for (const item of request.include) {
        if (!excluded.has(item.id)) tests.push(item);
      }
      return tests;
    }
    this.controller.items.forEach((item) => {
      if (!excluded.has(item.id)) tests.push(item);
    });
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
    this.cache(testId, result);
    this.resultsChangedEmitter.fire();
    return result;
  }

  /** One `dotnet test` invocation restricted to a single fully-qualified name. */
  private async runOne(testId: string, cwd: string, useTarget: boolean): Promise<CachedTestResult> {
    // Only the DEFAULT working directory implies the loaded solution. A caller
    // that overrode `cwd` is pointing at a specific project, and naming the
    // solution as well would run the wrong thing.
    const target = useTarget ? runTarget() : undefined;
    const outcome = await this.enqueue(
      async () => await runTests([testId], cwd, target === undefined ? {} : { target }),
    );
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
