import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'child_process';
import { XMLParser } from 'fast-xml-parser';
import { info } from './log';
import { buildWithDiagnostics } from './build';

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
export class ForgeTestController {
  private readonly controller: vscode.TestController;
  private readonly runProfiles: vscode.TestRunProfile[] = [];
  private readonly results = new Map<string, CachedTestResult>();
  private readonly resultsChangedEmitter = new vscode.EventEmitter<void>();

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
    this.controller = vscode.tests.createTestController('forge.testController', 'Forge Tests');

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

    this.controller.resolveHandler = async (item): Promise<void> => {
      await this.discoverTests(item);
    };
  }

  public dispose(): void {
    for (const profile of this.runProfiles) {
      profile.dispose();
    }
    this.resultsChangedEmitter.dispose();
    this.controller.dispose();
  }

  private async discoverTests(_item: vscode.TestItem | undefined): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined) {
      return;
    }

    // Auto-build before test discovery to ensure up-to-date binaries.
    try {
      await buildWithDiagnostics('build');
      info('Auto-build completed before test discovery');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      info(`Auto-build before test discovery failed: ${message}`);
    }

    for (const folder of folders) {
      await this.discoverTestsInFolder(folder);
    }
  }

  private async discoverTestsInFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const output = await runProcess(
        'dotnet',
        ['test', '--list-tests', '--verbosity', 'quiet'],
        folder.uri.fsPath,
      );

      const lines = output
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('The following'));

      let inTestList = false;
      for (const line of lines) {
        if (line === 'The following Tests are available:') {
          inTestList = true;
          continue;
        }
        if (!inTestList && !isTestName(line)) {
          continue;
        }
        inTestList = true;
        this.addTestItem(folder, line);
      }
      info(`Discovered ${String(this.controller.items.size)} tests`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      info(`Test discovery failed: ${message}`);
    }
  }

  private addTestItem(folder: vscode.WorkspaceFolder, fullName: string): void {
    const parts = fullName.split('.');
    const label = parts.at(-1) ?? fullName;
    const id = fullName;

    const item = this.controller.createTestItem(id, label, folder.uri);
    item.description = fullName;
    // Detect F# test frameworks.
    if (isExpectoTest(fullName) || isFsCheckTest(fullName)) {
      item.tags = [new vscode.TestTag('fsharp')];
    }
    this.controller.items.add(item);
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

      const resultsDir = path.join(folder.uri.fsPath, '.forge-coverage');
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

  private async executeTest(testId: string, debug: boolean): Promise<TestResult> {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder === undefined) {
        return { passed: false, message: 'No workspace folder' };
      }

      if (debug) {
        const terminal = vscode.window.createTerminal('Forge Test Debug');
        terminal.show();
        terminal.sendText(`dotnet test --filter "FullyQualifiedName=${testId}"`);
        return { passed: true };
      }

      const start = Date.now();
      const output = await runProcess(
        'dotnet',
        ['test', '--filter', `FullyQualifiedName=${testId}`, '--verbosity', 'quiet'],
        folder.uri.fsPath,
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
}

interface TestResult {
  passed: boolean;
  duration?: number | undefined;
  message?: string | undefined;
}

function isTestName(line: string): boolean {
  return /^[\w.]+$/.test(line) && line.includes('.');
}

function isExpectoTest(name: string): boolean {
  return name.includes('Expecto') || name.includes('testCase') || name.includes('testList');
}

function isFsCheckTest(name: string): boolean {
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

function buildFilterArgs(tests: vscode.TestItem[]): string[] {
  if (tests.length === 0) return [];
  const names = tests.map((t) => `FullyQualifiedName=${t.id}`);
  return ['--filter', names.join('|')];
}

// ── Cobertura XML parser ────────────────────────────────────────

interface CoberturaLine {
  readonly '@_number': string;
  readonly '@_hits': string;
  readonly '@_branch'?: string;
}

interface CoberturaClass {
  readonly '@_filename': string;
  readonly lines?: { line?: CoberturaLine | CoberturaLine[] };
}

interface CoberturaPackage {
  readonly classes?: { class?: CoberturaClass | CoberturaClass[] };
}

interface CoberturaReport {
  readonly coverage?: {
    readonly packages?: { package?: CoberturaPackage | CoberturaPackage[] };
  };
}

const coberturaParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (tagName) => tagName === 'package' || tagName === 'class' || tagName === 'line',
});

function findCoberturaFile(resultsDir: string): string | undefined {
  if (!fs.existsSync(resultsDir)) return undefined;
  const entries = fs.readdirSync(resultsDir);
  for (const entry of entries) {
    const sub = path.join(resultsDir, entry);
    const candidate = path.join(sub, 'coverage.cobertura.xml');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function parseCoberturaXml(filePath: string): vscode.FileCoverage[] {
  const xml = fs.readFileSync(filePath, 'utf-8');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- fast-xml-parser returns untyped output; CoberturaReport mirrors the known schema
  const doc: CoberturaReport = coberturaParser.parse(xml);
  const packages = doc.coverage?.packages?.package;
  if (packages === undefined) return [];

  const pkgList = Array.isArray(packages) ? packages : [packages];
  const result: vscode.FileCoverage[] = [];

  for (const pkg of pkgList) {
    const classes = pkg.classes?.class;
    if (classes === undefined) continue;
    const classList = Array.isArray(classes) ? classes : [classes];

    for (const cls of classList) {
      const lines = cls.lines?.line;
      if (lines === undefined) continue;
      const lineList = Array.isArray(lines) ? lines : [lines];

      let covered = 0;
      let total = 0;
      const details: vscode.StatementCoverage[] = [];

      for (const line of lineList) {
        const lineNo = parseInt(line['@_number'], 10) - 1;
        const hits = parseInt(line['@_hits'], 10);
        total++;
        if (hits > 0) covered++;
        details.push(new vscode.StatementCoverage(hits, new vscode.Position(lineNo, 0)));
      }

      const uri = vscode.Uri.file(cls['@_filename']);
      const fc = new vscode.FileCoverage(uri, new vscode.TestCoverageCount(covered, total));
      // Stash details on the instance for loadDetailedCoverage callback.
      coverageDetails.set(uri.toString(), details);
      result.push(fc);
    }
  }

  return result;
}

/** Coverage details keyed by file URI string, for loadDetailedCoverage. */
const coverageDetails = new Map<string, vscode.StatementCoverage[]>();

function loadDetailedCoverage(fileCoverage: vscode.FileCoverage): vscode.FileCoverageDetail[] {
  return coverageDetails.get(fileCoverage.uri.toString()) ?? [];
}

/**
 * Register the test controller.
 */
export function registerTestExplorer(context: vscode.ExtensionContext): ForgeTestController {
  const controller = new ForgeTestController();
  context.subscriptions.push({
    dispose: () => {
      controller.dispose();
    },
  });
  info('Test explorer registered');
  return controller;
}
