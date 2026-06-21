/**
 * Code lens provider that shows pass/fail indicators above test methods.
 *
 * Scans C# and F# files for test attributes and displays the last known
 * test result from {@link SharpLspTestController} as an inline code lens.
 */

import * as vscode from 'vscode';
import { type CachedTestResult, type SharpLspTestController } from './testing.js';
import { CMD_TEST_RUN_AT_CURSOR, CMD_TEST_DEBUG_AT_CURSOR } from './constants.js';
import { info } from './log.js';

/** Attribute markers that identify a method as a test. */
const CS_TEST_ATTRIBUTES = ['Fact', 'Theory', 'Test', 'TestMethod', 'TestCase'] as const;

/** F# test attribute markers (angle-bracket form). */
const FS_TEST_ATTRIBUTES = ['Fact', 'Theory', 'Test', 'TestMethod', 'TestCase'] as const;

/**
 * Provides code lenses above test methods showing their last known result.
 * Each lens also offers "Run Test" and "Debug Test" actions.
 */
export class TestStatusLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly testController: SharpLspTestController) {
    this.disposables.push(
      testController.onResultsChanged(() => {
        this.changeEmitter.fire();
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sharplsp.testLens.enabled')) {
          this.changeEmitter.fire();
        }
      }),
    );
  }

  public dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    const enabled = vscode.workspace
      .getConfiguration('sharplsp.testLens')
      .get<boolean>('enabled', true);
    if (!enabled) {
      return [];
    }

    const lang = document.languageId;
    if (lang === 'csharp') {
      return this.lensesForCSharp(document);
    }
    if (lang === 'fsharp') {
      return this.lensesForFSharp(document);
    }
    return [];
  }

  private lensesForCSharp(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!this.hasTestAttribute(line, CS_TEST_ATTRIBUTES)) {
        continue;
      }
      const methodName = this.findCSharpMethodName(lines, i);
      if (methodName === undefined) {
        continue;
      }
      const range = new vscode.Range(i, 0, i, line.length);
      this.addLensesForTest(lenses, range, methodName, document.uri);
    }

    return lenses;
  }

  private lensesForFSharp(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!this.hasFSharpTestAttribute(line)) {
        continue;
      }
      const methodName = this.findFSharpTestName(lines, i);
      if (methodName === undefined) {
        continue;
      }
      const range = new vscode.Range(i, 0, i, line.length);
      this.addLensesForTest(lenses, range, methodName, document.uri);
    }

    return lenses;
  }

  private hasTestAttribute(line: string, attributes: readonly string[]): boolean {
    const trimmed = line.trim();
    return attributes.some(
      (attr) =>
        trimmed.startsWith(`[${attr}]`) ||
        trimmed.startsWith(`[${attr}(`) ||
        trimmed.includes(`[${attr}]`) ||
        trimmed.includes(`[${attr}(`),
    );
  }

  private hasFSharpTestAttribute(line: string): boolean {
    const trimmed = line.trim();
    return FS_TEST_ATTRIBUTES.some(
      (attr) => trimmed.includes(`[<${attr}>]`) || trimmed.includes(`[<${attr}(`),
    );
  }

  private findCSharpMethodName(lines: string[], attrLine: number): string | undefined {
    const limit = Math.min(attrLine + 6, lines.length);
    for (let i = attrLine; i < limit; i++) {
      const line = lines[i] ?? '';
      const match = extractCSharpMethodName(line);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }

  private findFSharpTestName(lines: string[], attrLine: number): string | undefined {
    const limit = Math.min(attrLine + 4, lines.length);
    for (let i = attrLine; i < limit; i++) {
      const line = lines[i] ?? '';
      const match = extractFSharpFunctionName(line);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }

  private addLensesForTest(
    lenses: vscode.CodeLens[],
    range: vscode.Range,
    methodName: string,
    uri: vscode.Uri,
  ): void {
    const result = this.findResultByMethodName(methodName);

    if (result !== undefined) {
      const statusTitle = result.passed
        ? `$(pass) Passed${formatDuration(result.duration)}`
        : `$(error) Failed${result.message !== undefined ? `: ${result.message}` : ''}`;

      lenses.push(
        new vscode.CodeLens(range, {
          title: statusTitle,
          command: '',
          arguments: [],
        }),
      );
    }

    lenses.push(
      new vscode.CodeLens(range, {
        title: '$(play) Run Test',
        command: CMD_TEST_RUN_AT_CURSOR,
        arguments: [uri, methodName],
      }),
    );

    lenses.push(
      new vscode.CodeLens(range, {
        title: '$(bug) Debug Test',
        command: CMD_TEST_DEBUG_AT_CURSOR,
        arguments: [uri, methodName],
      }),
    );
  }

  private findResultByMethodName(methodName: string): CachedTestResult | undefined {
    for (const [testId, result] of this.testController.cachedResults) {
      const lastDot = testId.lastIndexOf('.');
      const shortName = lastDot >= 0 ? testId.substring(lastDot + 1) : testId;
      if (shortName === methodName) {
        return result;
      }
    }
    return undefined;
  }
}

/** Extract a C# method name from a line containing a method signature. */
export function extractCSharpMethodName(line: string): string | undefined {
  const trimmed = line.trim();
  if (
    trimmed.startsWith('[') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed === '{' ||
    trimmed === '}'
  ) {
    return undefined;
  }
  const match = /\b(\w+)\s*(?:<[^>]+>)?\s*\(/.exec(trimmed);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const name = match[1];
  if (CS_KEYWORDS.has(name)) {
    return undefined;
  }
  return name;
}

const CS_KEYWORDS = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'using',
  'return',
  'new',
  'class',
  'struct',
  'record',
  'interface',
  'enum',
  'namespace',
  'void',
  'async',
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'virtual',
  'override',
  'abstract',
  'sealed',
]);

/** Extract an F# function name from a `let` or `member` binding. */
export function extractFSharpFunctionName(line: string): string | undefined {
  const trimmed = line.trim();
  const letMatch = /^let\s+(\w+)/.exec(trimmed);
  if (letMatch?.[1] !== undefined) {
    return letMatch[1];
  }
  const memberMatch = /^member\s+\w+\.(\w+)/.exec(trimmed);
  if (memberMatch?.[1] !== undefined) {
    return memberMatch[1];
  }
  return undefined;
}

/** Format a duration in ms for display. */
export function formatDuration(duration: number | undefined): string {
  if (duration === undefined) {
    return '';
  }
  if (duration < 1000) {
    return ` (${String(duration)}ms)`;
  }
  return ` (${(duration / 1000).toFixed(1)}s)`;
}

/**
 * Register the test status code lens provider and its commands.
 */
export function registerTestStatusLens(
  context: vscode.ExtensionContext,
  testController: SharpLspTestController,
): TestStatusLensProvider {
  const provider = new TestStatusLensProvider(testController);

  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [{ language: 'csharp' }, { language: 'fsharp' }],
      provider,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD_TEST_RUN_AT_CURSOR,
      async (_uri: vscode.Uri, methodName: string) => {
        await runTestByMethodName(testController, methodName, false);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD_TEST_DEBUG_AT_CURSOR,
      async (_uri: vscode.Uri, methodName: string) => {
        await runTestByMethodName(testController, methodName, true);
      },
    ),
  );

  info('Test status lens registered');
  return provider;
}

async function runTestByMethodName(
  testController: SharpLspTestController,
  methodName: string,
  debug: boolean,
): Promise<void> {
  let matchedItem: vscode.TestItem | undefined;
  testController.items.forEach((item) => {
    const lastDot = item.id.lastIndexOf('.');
    const shortName = lastDot >= 0 ? item.id.substring(lastDot + 1) : item.id;
    if (shortName === methodName) {
      matchedItem = item;
    }
  });

  if (matchedItem === undefined) {
    void vscode.window.showWarningMessage(
      `No discovered test matching "${methodName}". Run test discovery first.`,
    );
    return;
  }

  if (debug) {
    await vscode.commands.executeCommand('testing.debugTests', matchedItem);
  } else {
    await vscode.commands.executeCommand('testing.runTests', matchedItem);
  }
  info(`Test ${debug ? 'debug' : 'run'} requested for: ${matchedItem.id}`);
}
