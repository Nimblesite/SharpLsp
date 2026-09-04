/**
 * Code lens provider that shows pass/fail indicators above test methods.
 *
 * Scans C# and F# files for test attributes and displays the last known
 * test result from {@link SharpLspTestController} as an inline code lens.
 *
 * Implements [TEST-STATUS-LENS].
 */

import * as vscode from 'vscode';
import { type CachedTestResult, type SharpLspTestController } from './testing.js';
import { CMD_TEST_RUN_AT_CURSOR, CMD_TEST_DEBUG_AT_CURSOR } from './constants.js';
import { info } from './log.js';
import { forEachLeaf } from './test-tree.js';
import { singleLine } from './utils.js';
import {
  CS_DECLARATION_SPAN,
  declarationBelow,
  FS_DECLARATION_SPAN,
  hasCSharpTestAttribute,
  hasFSharpTestAttribute,
} from './test-lens-attributes.js';

/**
 * Provides code lenses above test methods showing their last known result.
 * Each lens also offers "Run Test" and "Debug Test" actions.
 */
/** What a test's status reads before anything in this session has run it. */
export const NEVER_RUN: CachedTestResult = { outcome: 'notRun', passed: false };

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
    return this.lensesFor(document, hasCSharpTestAttribute, extractCSharpMethodName, {
      span: CS_DECLARATION_SPAN,
    });
  }

  private lensesForFSharp(document: vscode.TextDocument): vscode.CodeLens[] {
    return this.lensesFor(document, hasFSharpTestAttribute, extractFSharpFunctionName, {
      span: FS_DECLARATION_SPAN,
    });
  }

  /**
   * One lens pair per attributed DECLARATION, whichever language the file is.
   *
   * Keyed on the declaration rather than on the attribute because a test may
   * carry several: `[DataRow(1, 2)]` above `[DataTestMethod]`, or NUnit's
   * `[Test]` above `[TestCase(2, 2, 4)]`. Emitting per attribute stacked two
   * identical Run buttons over one method and made the status line read twice.
   */
  private lensesFor(
    document: vscode.TextDocument,
    isAttribute: (line: string) => boolean,
    nameAt: (line: string) => string | undefined,
    reach: { readonly span: number },
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const lines = document.getText().split('\n');
    const claimed = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!isAttribute(line)) continue;
      const declaration = declarationBelow(lines, i, reach.span, nameAt);
      if (declaration === undefined || claimed.has(declaration.line)) continue;
      claimed.add(declaration.line);
      const range = new vscode.Range(i, 0, i, line.length);
      this.addLensesForTest(lenses, range, declaration.name, document.uri);
    }
    return lenses;
  }

  private addLensesForTest(
    lenses: vscode.CodeLens[],
    range: vscode.Range,
    methodName: string,
    uri: vscode.Uri,
  ): void {
    // No cached result IS the not-run result. [TEST-STATUS-LENS] pins
    // "$(circle-slash) Not run" as one of the four titles the lens renders, but
    // nothing writes to the cache until a run FINISHES, so that state was
    // unreachable: a freshly discovered test showed Run and Debug and no status
    // at all, and the row only began reporting itself after the user had
    // already run it — exactly when they no longer needed telling.
    const result = this.findResultByMethodName(methodName) ?? NEVER_RUN;

    lenses.push(
      new vscode.CodeLens(range, {
        title: statusLensTitle(result),
        command: '',
        arguments: [],
      }),
    );

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
      if (methodNameOf(testId) === methodName) {
        return result;
      }
    }
    return undefined;
  }
}

/**
 * `line` with any LEADING attribute groups removed, so a signature sharing a
 * line with its attributes is still a signature.
 *
 * `[Fact] public void Adds()` is idiomatic C# and the shape most xUnit one-line
 * tests are written in. Rejecting every line that opens with `[` — which is how
 * a bare `[InlineData(2, 2, 4)]` was kept from reading as a method called
 * `InlineData` — silently dropped the whole lens for those methods: no status,
 * no Run, no Debug. Stripping the groups instead keeps the bare attribute line
 * rejected (nothing is left of it) while letting the combined form through.
 *
 * Brackets are counted, not searched for, so an attribute carrying its own
 * indexer or array type closes where it really closes; a `]` inside a string
 * argument (`[Fact(Skip = "a]b")]`) is not a bracket at all.
 */
function withoutLeadingAttributes(line: string): string {
  let rest = line.trim();
  while (rest.startsWith('[')) {
    const end = attributeGroupEnd(rest);
    if (end === undefined) return '';
    rest = rest.slice(end + 1).trim();
  }
  return rest;
}

/** The index of the `]` closing the attribute group `text` opens with. */
function attributeGroupEnd(text: string): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (quote !== undefined) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth += 1;
    else if (ch === ']' && --depth === 0) return i;
  }
  return undefined;
}

/** Extract a C# method name from a line containing a method signature. */
export function extractCSharpMethodName(line: string): string | undefined {
  const trimmed = withoutLeadingAttributes(line);
  if (
    trimmed === '' ||
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
  return (
    bindingName(/^let\s+(?:``([^`]+)``|(\w+))/, trimmed) ??
    bindingName(/^member\s+\w+\.(?:``([^`]+)``|(\w+))/, trimmed)
  );
}

/**
 * The name `pattern` captured, whichever of its two alternatives matched.
 *
 * F# names a test by writing it the way it reads — ``let `` `adds two numbers`
 * `` () =`` — and `\w+` cannot match a double-backtick binding, so every test
 * named in the idiomatic style resolved to nothing and carried no lens at all:
 * no status, no Run, no Debug. The backticks are F# syntax, not part of the
 * name, so the INNER text is captured: that is what the test id carries.
 */
function bindingName(pattern: RegExp, line: string): string | undefined {
  const match = pattern.exec(line);
  return match?.[1] ?? match?.[2];
}

/**
 * The bare method name a cached test id ends in.
 *
 * A data-driven test is listed one ROW per case — `Ns.Class.Adds(a: 2, b: 2)` —
 * so a lens looking up `Adds` matched nothing and the method showed no status
 * until a run replaced those ids with the merged bare name. Cutting at the
 * first `(` resolves both forms, and must happen BEFORE the last dot is taken:
 * an argument carrying a dot (`2.5`) would otherwise make the arguments look
 * like the method name.
 */
function methodNameOf(testId: string): string {
  const head = testId.split('(')[0] ?? testId;
  const lastDot = head.lastIndexOf('.');
  return lastDot >= 0 ? head.slice(lastDot + 1) : head;
}

/**
 * The status text rendered above a test method. A SKIPPED test is neither a
 * pass nor a failure — reporting it as "Failed" is exactly the bug the TRX-based
 * run path fixes, so the lens has to say so too.
 */
export function statusLensTitle(result: CachedTestResult): string {
  if (result.outcome === 'passed') {
    return `$(pass) Passed${formatDuration(result.duration)}`;
  }
  if (result.outcome === 'skipped') {
    return `$(debug-step-over) Skipped`;
  }
  if (result.outcome === 'notRun') {
    return `$(circle-slash) Not run${detail(result.message)}`;
  }
  return `$(error) Failed${detail(result.message)}`;
}

/**
 * A message rendered as the tail of a lens title, flattened onto ONE line.
 *
 * `cachedFrom` already flattens what it stores, so for a result that came from
 * a run this is the identity. It is applied again here because the lens takes a
 * {@link CachedTestResult}, not a TRX result: nothing in the type says the
 * message is single-line, and a lens is the one place that cannot render it if
 * it is not.
 */
function detail(message: string | undefined): string {
  if (message === undefined) return '';
  const flattened = singleLine(message);
  return flattened === '' ? '' : `: ${flattened}`;
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
 * The discovered test a "Run Test" / "Debug Test" lens points at, found by the
 * method name the lens carries.
 *
 * Descends to the LEAVES. The Testing view groups discovered tests as
 * **Assembly → Namespace → Class → Test**, so the top level holds assemblies:
 * matching against it alone finds nothing, and every lens reports a perfectly
 * discovered test as undiscovered. Discovery-error rows are leaves too, and are
 * never runnable.
 *
 * The FIRST match wins — a leaf's id is its fully-qualified name, so the short
 * name only repeats when two classes share a method name, and either is an
 * equally good answer to a lens that carries no more than that name.
 */
export function findTestByMethodName(
  items: vscode.TestItemCollection,
  methodName: string,
): vscode.TestItem | undefined {
  let matched: vscode.TestItem | undefined;
  forEachLeaf(items, (item) => {
    if (matched !== undefined || item.error !== undefined) {
      return;
    }
    const lastDot = item.id.lastIndexOf('.');
    const shortName = lastDot >= 0 ? item.id.substring(lastDot + 1) : item.id;
    if (shortName === methodName) {
      matched = item;
    }
  });
  return matched;
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
  const matchedItem = findTestByMethodName(testController.items, methodName);

  if (matchedItem === undefined) {
    void vscode.window.showWarningMessage(
      `No discovered test matching "${methodName}". Run test discovery first.`,
    );
    return;
  }

  const kind = debug ? vscode.TestRunProfileKind.Debug : vscode.TestRunProfileKind.Run;
  const profile = testController.profiles.find((candidate) => candidate.kind === kind);
  if (profile === undefined) {
    void vscode.window.showWarningMessage(`No ${debug ? 'Debug' : 'Run'} profile is registered.`);
    return;
  }
  info(`Test ${debug ? 'debug' : 'run'} requested for: ${matchedItem.id}`);
  await pressProfile(profile, matchedItem);
}

/**
 * Press `profile` for one test, exactly as the Test Explorer's own button does.
 *
 * NOT `testing.runTests`/`testing.debugTests`: no such workbench commands exist,
 * so the gesture died with "command not found" and the caret ran nothing. The
 * profile the extension registered is the run, and invoking its handler is the
 * same entry point VS Code uses — the run appears in the Testing view either
 * way, and the Debug profile still attaches through [DEBUG-FEATURES-TESTS].
 */
async function pressProfile(profile: vscode.TestRunProfile, item: vscode.TestItem): Promise<void> {
  const source = new vscode.CancellationTokenSource();
  try {
    await profile.runHandler(new vscode.TestRunRequest([item], undefined, profile), source.token);
  } finally {
    source.dispose();
  }
}
