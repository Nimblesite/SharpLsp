import * as vscode from 'vscode';
import { effect } from './signals';
import { info } from './log';
import * as state from './state';
import { listTests, type TestAssemblyListing, type TestListing } from './test-discovery';
import {
  cancelled,
  runOptions,
  runTests,
  type RunInvocation,
  type TestRunOutcome,
} from './test-execution';
import { debugSelectedTests, type TestDebugHost } from './test-debug';
import { forEachLeafIn } from './test-tree';
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
 * Id prefix marking the row that explains WHY discovery failed. Error rows
 * are leaves that never run; a successful sweep removes them.
 */
const ERROR_ITEM_PREFIX = 'discovery-error:';

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
   * standing — with an error row appended saying why — rather than blanking the
   * view on a transient `dotnet` failure.
   */
  public async discover(): Promise<void> {
    const generation = ++this.discoverGeneration;
    const targets = discoveryTargets();
    const items: vscode.TestItem[] = [];
    const errors: vscode.TestItem[] = [];
    let anyOk = targets.length === 0;
    for (const target of targets) {
      // A newer sweep supersedes this one: stop before paying for another build
      // rather than enumerating targets whose results will be thrown away.
      if (generation !== this.discoverGeneration) return;
      const listing = await this.safeList(target);
      anyOk = anyOk || listing.ok;
      const uri = vscode.Uri.file(dirOf(target));
      if (!listing.ok && listing.names.length === 0) {
        // The enumeration itself failed: surface the real diagnostic as a row,
        // never a silent blank view (MSB1011 ambiguity, build errors, missing
        // target — the cases the extension log showed going unnoticed).
        errors.push(this.makeErrorItem(target, uri, listing.warnings));
        continue;
      }
      if (listing.byAssembly.length > 0) {
        for (const assembly of listing.byAssembly) {
          items.push(this.makeAssemblyItem(assembly, uri));
        }
        continue;
      }
      // Display-name fallback: no attribution, so flat rows — weaker, but never
      // worse than dropping the tests outright.
      for (const fqn of listing.names) {
        items.push(this.makeTestItem(fqn, uri));
      }
    }
    if (generation !== this.discoverGeneration) return;
    this.applyDiscovery(items, errors, anyOk, targets.length);
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
    this.pruneResults(this.leafIdSet([...items, ...errors]));
    info(
      `Test discovery: ${String(items.length)} item(s) from ${String(targetCount)} target(s)` +
        (errors.length > 0 ? `; ${String(errors.length)} error row(s)` : ''),
    );
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

  /** Every LEAF id under `items`, recursively — group nodes never hold results. */
  private leafIdSet(items: readonly vscode.TestItem[]): Set<string> {
    const ids = new Set<string>();
    forEachLeafIn(items, (item) => ids.add(item.id));
    return ids;
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

  /** A non-test group node: an assembly, a namespace or a class. */
  private makeGroupItem(id: string, label: string, uri: vscode.Uri): vscode.TestItem {
    const item = this.controller.createTestItem(id, label, uri);
    item.canResolveChildren = true;
    return item;
  }

  /**
   * Build one assembly's Assembly → Namespace → Class → Test subtree from its
   * fully-qualified names. The last dotted segment is the test, the one before
   * it the class, the rest joined the namespace — deterministic for C#
   * namespaces and dotted F# modules alike (`Fs.Xunit.Fixtures.adds two
   * numbers` → `Fs.Xunit` / `Fixtures` / `adds two numbers`). Shorter names
   * nest under whatever levels exist; nothing is ever dropped.
   */
  private makeAssemblyItem(assembly: TestAssemblyListing, uri: vscode.Uri): vscode.TestItem {
    const root = this.makeGroupItem(`assembly:${assembly.path}`, assembly.name, uri);
    const namespaces = new Map<string, vscode.TestItem>();
    const classes = new Map<string, vscode.TestItem>();
    for (const fqn of assembly.names) {
      const parts = fqn.split('.');
      const namespaceLabel = parts.length >= 3 ? parts.slice(0, -2).join('.') : '';
      const classLabel = parts.length >= 2 ? (parts.at(-2) ?? '') : '';
      let parent = root;
      if (namespaceLabel !== '') {
        const nsId = `namespace:${assembly.path}|${namespaceLabel}`;
        let nsItem = namespaces.get(nsId);
        if (nsItem === undefined) {
          nsItem = this.makeGroupItem(nsId, namespaceLabel, uri);
          namespaces.set(nsId, nsItem);
          root.children.add(nsItem);
        }
        parent = nsItem;
      }
      if (classLabel !== '') {
        const classId = `class:${assembly.path}|${namespaceLabel}|${classLabel}`;
        let classItem = classes.get(classId);
        if (classItem === undefined) {
          classItem = this.makeGroupItem(classId, classLabel, uri);
          classes.set(classId, classItem);
          parent.children.add(classItem);
        }
        parent = classItem;
      }
      parent.children.add(this.makeTestItem(fqn, uri));
    }
    return root;
  }

  /**
   * The row that explains WHY discovery failed: the real `dotnet` diagnostic
   * plus a remedy, so the user acts instead of staring at an empty view.
   */
  private makeErrorItem(
    target: string,
    uri: vscode.Uri,
    warnings: readonly string[],
  ): vscode.TestItem {
    const item = this.controller.createTestItem(
      `${ERROR_ITEM_PREFIX}${target}`,
      'Test discovery failed',
      uri,
    );
    item.description = target;
    const diagnostics =
      warnings.length > 0 ? warnings.join('\n\n') : 'dotnet test produced no test listing.';
    item.error = new vscode.MarkdownString(
      `SharpLsp could not enumerate tests for \`${target}\`.\n\n` +
        `${diagnostics}\n\n` +
        'Load one solution with the **SharpLsp: Select Solution** command, fix the build errors above, then refresh the Testing view.',
    );
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
      const filterIds = filterIdsFor(request, tests);
      if (request.include !== undefined && tests.length === 0) return;
      await this.executeInto(run, tests, token, coverage, filterIds);
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
    filterIds: readonly string[],
  ): Promise<void> {
    const cwd = runCwd();
    if (cwd === undefined) {
      reportAll(run, tests, 'No workspace folder or solution', this.cacheWriter());
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
    reportOutcome(run, tests, outcome, this.cacheWriter());
    if (coverage && resultsDirectory !== undefined) addCoverage(run, resultsDirectory);
  }

  /** One queued, CANCELLABLE `dotnet test` over the whole selection. */
  private async invoke(request: RunInvocation): Promise<TestRunOutcome> {
    const cancellation = cancellationSignal(request.token);
    const options = runOptions(request, cancellation.signal);
    try {
      return await this.enqueue(
        async () => await runTests(request.filterIds, request.cwd, options),
      );
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
    await debugSelectedTests(
      this.debugHost(),
      run,
      tests,
      token,
      cwd,
      filterIdsFor(request, tests),
    );
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
 * The filter ids a run uses. "Run everything, nothing excluded" is how VS Code
 * expresses ▶ on the root of the Testing view; passing NO filter then runs every
 * test in ONE `dotnet test` — instead of N command-line-sized filter batches.
 */
function filterIdsFor(
  request: vscode.TestRunRequest,
  tests: readonly vscode.TestItem[],
): readonly string[] {
  const unfiltered = request.include === undefined && (request.exclude ?? []).length === 0;
  return unfiltered ? [] : tests.map((test) => test.id);
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
