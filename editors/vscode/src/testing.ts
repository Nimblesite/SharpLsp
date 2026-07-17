import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'child_process';
import { info } from './log';
import * as state from './state';
import { listTests } from './test-discovery';
import { findCoberturaFile, parseCoberturaXml, loadDetailedCoverage } from './test-coverage';

/**
 * Debounce for reactive re-discovery. Loading a solution can churn the
 * `solutionPath` signal several times in quick succession; collapse the burst
 * into a single `dotnet test --list-tests` sweep.
 */
const DISCOVERY_DEBOUNCE_MS = 1_000;

/** Cached result for a single test, keyed by fully qualified name. */
export interface CachedTestResult {
  readonly passed: boolean;
  readonly duration?: number | undefined;
  readonly message?: string | undefined;
}

/**
 * Test controller integrating with VS Code's Testing API.
 * Discovers tests via `dotnet test --list-tests` and runs them via `dotnet test --filter`.
 * Supports xUnit, NUnit, MSTest, Expecto, and FsCheck.
 */
export class SharpLspTestController {
  private readonly controller: vscode.TestController;
  private readonly runProfiles: vscode.TestRunProfile[] = [];
  private readonly results = new Map<string, CachedTestResult>();
  private readonly resultsChangedEmitter = new vscode.EventEmitter<void>();
  /** Cancels the reactive solution-change subscription. */
  private readonly solutionSubscription: () => void;
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

  /** Fires after any test run completes and results are cached. */
  public readonly onResultsChanged = this.resultsChangedEmitter.event;

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

  constructor() {
    this.controller = vscode.tests.createTestController(
      'sharplsp.testController',
      'SharpLsp Tests',
    );

    this.runProfiles.push(
      this.controller.createRunProfile(
        'Run',
        vscode.TestRunProfileKind.Run,
        async (request, token) => {
          await this.runTests(request, token);
        },
        true,
      ),
    );

    this.runProfiles.push(
      this.controller.createRunProfile(
        'Debug',
        vscode.TestRunProfileKind.Debug,
        async (request, token) => {
          await this.debugTests(request, token);
        },
      ),
    );

    const coverageProfile = this.controller.createRunProfile(
      'Run with Coverage',
      vscode.TestRunProfileKind.Coverage,
      async (request, token) => {
        await this.runTestsWithCoverage(request, token);
      },
    );
    coverageProfile.loadDetailedCoverage =
      // eslint-disable-next-line @typescript-eslint/require-await -- VS Code API requires Thenable return but lookup is synchronous
      async (_run, fileCoverage, _token) => loadDetailedCoverage(fileCoverage);
    this.runProfiles.push(coverageProfile);

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
   * folder) and replace the tree. A superseded sweep never clobbers a newer one.
   */
  public async discover(): Promise<void> {
    const generation = ++this.discoverGeneration;
    const targets = discoveryTargets();
    const items: vscode.TestItem[] = [];
    for (const target of targets) {
      const uri = vscode.Uri.file(dirOf(target));
      for (const fqn of await this.safeList(target)) {
        items.push(this.makeTestItem(fqn, uri));
      }
    }
    if (generation !== this.discoverGeneration) {
      return;
    }
    this.controller.items.replace(items);
    info(`Test discovery: ${String(items.length)} test(s) from ${String(targets.length)} target(s)`);
  }

  /** List one target, swallowing failures into an empty result. */
  private async safeList(target: string): Promise<string[]> {
    try {
      return await listTests(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      info(`Test discovery failed for ${target}: ${message}`);
      return [];
    }
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

  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const tests = this.collectTests(request);

    for (const test of tests) {
      if (token.isCancellationRequested) {
        break;
      }
      run.started(test);
      const result = await this.executeTest(test.id, false);
      this.results.set(test.id, result);
      if (result.passed) {
        run.passed(test, result.duration);
      } else {
        run.failed(test, new vscode.TestMessage(result.message ?? 'Test failed'), result.duration);
      }
    }
    run.end();
    this.resultsChangedEmitter.fire();
  }

  private async debugTests(
    request: vscode.TestRunRequest,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const tests = this.collectTests(request);
    if (tests.length === 0) {
      return;
    }

    // Debug the first selected test.
    const first = tests[0];
    if (first !== undefined) {
      await this.executeTest(first.id, true);
    }
  }

  private collectTests(request: vscode.TestRunRequest): vscode.TestItem[] {
    const tests: vscode.TestItem[] = [];
    if (request.include !== undefined) {
      for (const item of request.include) {
        tests.push(item);
      }
    } else {
      this.controller.items.forEach((item) => tests.push(item));
    }
    return tests;
  }

  private async runTestsWithCoverage(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      run.end();
      return;
    }

    const tests = this.collectTests(request);
    for (const test of tests) {
      run.started(test);
    }

    try {
      if (token.isCancellationRequested) {
        run.end();
        return;
      }

      const resultsDir = path.join(folder.uri.fsPath, '.sharplsp-coverage');
      const filterArgs = buildFilterArgs(tests);
      const args = [
        'test',
        ...filterArgs,
        '--collect:XPlat Code Coverage',
        `--results-directory=${resultsDir}`,
        '--verbosity',
        'quiet',
      ];

      const output = await runProcess('dotnet', args, folder.uri.fsPath);
      const passed = output.includes('Passed!');

      for (const test of tests) {
        const result: TestResult = { passed, duration: undefined };
        this.results.set(test.id, result);
        if (passed) {
          run.passed(test);
        } else {
          run.failed(test, new vscode.TestMessage('Test failed'));
        }
      }

      const coverageFile = findCoberturaFile(resultsDir);
      if (coverageFile !== undefined) {
        const fileCoverages = parseCoberturaXml(coverageFile);
        for (const fc of fileCoverages) {
          run.addCoverage(fc);
        }
        info(`Coverage loaded: ${String(fileCoverages.length)} files`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      info(`Coverage run failed: ${message}`);
      for (const test of tests) {
        run.failed(test, new vscode.TestMessage(message));
      }
    }

    run.end();
    this.resultsChangedEmitter.fire();
  }

  private async executeTest(
    testId: string,
    debug: boolean,
    cwdOverride?: string,
  ): Promise<TestResult> {
    try {
      const cwd = cwdOverride ?? runCwd();
      if (cwd === undefined) {
        return { passed: false, message: 'No workspace folder or solution' };
      }

      if (debug) {
        const terminal = vscode.window.createTerminal('SharpLsp Test Debug');
        terminal.show();
        terminal.sendText(`dotnet test --filter "FullyQualifiedName=${testId}"`);
        return { passed: true };
      }

      const start = Date.now();
      const output = await runProcess(
        'dotnet',
        ['test', '--filter', `FullyQualifiedName=${testId}`, '--verbosity', 'quiet'],
        cwd,
      );
      const duration = Date.now() - start;

      const passed = output.includes('Passed!');
      const failureMatch = /Failed\s+(.+)/g.exec(output);
      return {
        passed,
        duration,
        message: passed ? undefined : (failureMatch?.[1] ?? 'Test failed'),
      };
    } catch {
      return { passed: false, message: 'Test execution error' };
    }
  }

  /**
   * Run a single test by id, cache the result, and notify listeners. `cwd`
   * overrides the working directory (the loaded solution's folder by default) —
   * used by callers targeting a project outside the workspace.
   */
  public async runSingle(testId: string, cwd?: string): Promise<CachedTestResult> {
    const result = await this.executeTest(testId, false, cwd);
    this.results.set(testId, result);
    this.resultsChangedEmitter.fire();
    return result;
  }
}

/** The paths to enumerate: the loaded solution, else each workspace folder. */
function discoveryTargets(): string[] {
  const solution = state.solutionPath.value;
  if (solution !== undefined) {
    return [solution];
  }
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/** Directory containing a target path (the path itself when it is a directory). */
function dirOf(target: string): string {
  try {
    return fs.statSync(target).isDirectory() ? target : path.dirname(target);
  } catch {
    return path.dirname(target);
  }
}

/** Working directory for `dotnet test` runs: the loaded solution's folder. */
function runCwd(): string | undefined {
  const solution = state.solutionPath.value;
  if (solution !== undefined) {
    return path.dirname(solution);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

interface TestResult {
  passed: boolean;
  duration?: number | undefined;
  message?: string | undefined;
}

/** True when a line looks like a fully qualified test name (word chars/dots, contains a dot). */
export function isTestName(line: string): boolean {
  return /^[\w.]+$/.test(line) && line.includes('.');
}

/** True when a test name matches Expecto naming conventions. */
export function isExpectoTest(name: string): boolean {
  return name.includes('Expecto') || name.includes('testCase') || name.includes('testList');
}

/** True when a test name matches FsCheck property-test conventions. */
export function isFsCheckTest(name: string): boolean {
  return name.includes('FsCheck') || name.includes('Property');
}

async function runProcess(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 60000 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr !== '' ? stderr : error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Build `dotnet test --filter` args from selected test items (empty when none). */
export function buildFilterArgs(tests: vscode.TestItem[]): string[] {
  if (tests.length === 0) return [];
  const names = tests.map((t) => `FullyQualifiedName=${t.id}`);
  return ['--filter', names.join('|')];
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
