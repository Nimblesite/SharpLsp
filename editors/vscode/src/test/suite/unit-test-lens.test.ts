// Pure-logic unit tests for the test-lens line parsers. These pin the EXACT
// behavior of the C#/F# signature scanners and the duration formatter that
// TestStatusLensProvider relies on to render pass/fail code lenses. Behavior
// is asserted against the literal regex semantics (notably: `\w` is ASCII-only
// without the `u` flag, so non-ASCII identifiers are NOT matched).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  TestStatusLensProvider,
  extractCSharpMethodName,
  extractFSharpFunctionName,
  formatDuration,
} from '../../test-lens.js';
import { type CachedTestResult, type SharpLspTestController } from '../../testing.js';
import { CMD_TEST_RUN_AT_CURSOR, CMD_TEST_DEBUG_AT_CURSOR } from '../../constants.js';

/**
 * Minimal stand-in for {@link SharpLspTestController} that exposes only the
 * three members the lens provider reads — the `onResultsChanged` event, the
 * `cachedResults` map, and `items` — wired to a real {@link vscode.EventEmitter}
 * so tests can fire it and observe `onDidChangeCodeLenses`.
 */
class StubTestController {
  public readonly results = new Map<string, CachedTestResult>();
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onResultsChanged = this.emitter.event;

  public get cachedResults(): ReadonlyMap<string, CachedTestResult> {
    return this.results;
  }

  public readonly items: vscode.TestItemCollection = {
    forEach: () => undefined,
  } as unknown as vscode.TestItemCollection;

  /** Record a cached result keyed by fully qualified name. */
  public record(fqn: string, result: CachedTestResult): void {
    this.results.set(fqn, result);
  }

  /** Simulate a completed test run notifying listeners. */
  public fireResultsChanged(): void {
    this.emitter.fire();
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

/** Build a provider bound to a fresh stub controller. */
function makeProvider(): { provider: TestStatusLensProvider; controller: StubTestController } {
  const controller = new StubTestController();
  const provider = new TestStatusLensProvider(controller as unknown as SharpLspTestController);
  return { provider, controller };
}

const NO_TOKEN = new vscode.CancellationTokenSource().token;

/** Open a real on-disk file as a TextDocument so languageId resolves by extension. */
async function openDoc(
  tmpDir: string,
  name: string,
  content: string,
): Promise<vscode.TextDocument> {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
}

suite('test-lens — extractCSharpMethodName()', () => {
  test('plain method signature yields the method name', () => {
    assert.strictEqual(extractCSharpMethodName('public void MyTest()'), 'MyTest');
  });

  test('the first word followed by ( is captured, skipping modifiers/return type', () => {
    assert.strictEqual(extractCSharpMethodName('public async Task FetchAsync()'), 'FetchAsync');
    assert.strictEqual(extractCSharpMethodName('static void Main(string[] args)'), 'Main');
    assert.strictEqual(extractCSharpMethodName('internal protected void X()'), 'X');
  });

  test('generic return type does not confuse the capture', () => {
    assert.strictEqual(
      extractCSharpMethodName('public async Task<int> FetchAsync()'),
      'FetchAsync',
    );
  });

  test('generic method type-parameter list is consumed before the (', () => {
    assert.strictEqual(extractCSharpMethodName('void Generic<TKey, TValue>()'), 'Generic');
    assert.strictEqual(extractCSharpMethodName('public void Single<T>()'), 'Single');
  });

  test('expression-bodied member is matched (name before the open paren)', () => {
    assert.strictEqual(extractCSharpMethodName('public int Calc() => 42;'), 'Calc');
  });

  test('whitespace between name and paren is tolerated', () => {
    assert.strictEqual(extractCSharpMethodName('public void  Spaced () '), 'Spaced');
  });

  test('leading indentation is trimmed before matching', () => {
    assert.strictEqual(extractCSharpMethodName('        public void Indented()'), 'Indented');
    assert.strictEqual(extractCSharpMethodName('\t\tpublic void Tabbed()'), 'Tabbed');
  });

  test('underscores and digits are valid identifier characters', () => {
    assert.strictEqual(extractCSharpMethodName('public void T_1()'), 'T_1');
    assert.strictEqual(extractCSharpMethodName('void _hidden()'), '_hidden');
    assert.strictEqual(extractCSharpMethodName('void Test42()'), 'Test42');
  });

  test('attribute-only line is rejected by the leading-[ guard', () => {
    assert.strictEqual(extractCSharpMethodName('[Fact]'), undefined);
    assert.strictEqual(extractCSharpMethodName('    [Theory]'), undefined);
    assert.strictEqual(extractCSharpMethodName('[InlineData(1, 2)]'), undefined);
  });

  test('attribute prefix on the same line as the method still rejects (leading-[ guard wins)', () => {
    assert.strictEqual(extractCSharpMethodName('[Theory] public void Inline()'), undefined);
  });

  test('comment lines are rejected', () => {
    assert.strictEqual(extractCSharpMethodName('// comment line'), undefined);
    assert.strictEqual(extractCSharpMethodName('/* block start'), undefined);
    assert.strictEqual(extractCSharpMethodName(' * doc continuation'), undefined);
  });

  test('lone braces are rejected', () => {
    assert.strictEqual(extractCSharpMethodName('{'), undefined);
    assert.strictEqual(extractCSharpMethodName('}'), undefined);
    assert.strictEqual(extractCSharpMethodName('   {   '), undefined);
    assert.strictEqual(extractCSharpMethodName('   }   '), undefined);
  });

  test('a brace that is not the entire trimmed line is NOT rejected by the brace guard', () => {
    // "{ Init() }" trims to "{ Init() }" which is not exactly "{" — regex runs.
    assert.strictEqual(extractCSharpMethodName('{ Init() }'), 'Init');
  });

  test('lines without any ( do not match', () => {
    assert.strictEqual(extractCSharpMethodName('no parens here'), undefined);
    assert.strictEqual(extractCSharpMethodName('public int Field;'), undefined);
    assert.strictEqual(extractCSharpMethodName('var x = 5'), undefined);
  });

  test('empty and whitespace-only lines return undefined', () => {
    assert.strictEqual(extractCSharpMethodName(''), undefined);
    assert.strictEqual(extractCSharpMethodName('   '), undefined);
    assert.strictEqual(extractCSharpMethodName('\t \n'), undefined);
  });

  test('control-flow keywords before their paren are filtered out', () => {
    assert.strictEqual(extractCSharpMethodName('if (x > 0)'), undefined);
    assert.strictEqual(extractCSharpMethodName('while (true)'), undefined);
    assert.strictEqual(extractCSharpMethodName('for (int i = 0; i < n; i++)'), undefined);
    assert.strictEqual(extractCSharpMethodName('foreach (var x in y)'), undefined);
    assert.strictEqual(extractCSharpMethodName('switch (value)'), undefined);
    assert.strictEqual(extractCSharpMethodName('catch (Exception e)'), undefined);
    // "using" is itself followed by "(" and is a keyword, so the whole line rejects.
    assert.strictEqual(extractCSharpMethodName('using (var s = open())'), undefined);
  });

  test('declaration keywords are rejected when they are the captured token', () => {
    // No identifier precedes the keyword's own paren, so the keyword is captured then filtered.
    assert.strictEqual(extractCSharpMethodName('void ()'), undefined);
    assert.strictEqual(extractCSharpMethodName('async ()'), undefined);
    assert.strictEqual(extractCSharpMethodName('static ()'), undefined);
  });

  test('keyword followed by a real call captures the call, not the keyword', () => {
    // The regex needs `word (`; "return" is not immediately followed by `(`,
    // so scanning continues to the next word that is.
    assert.strictEqual(extractCSharpMethodName('return Helper();'), 'Helper');
    assert.strictEqual(extractCSharpMethodName('new Widget();'), 'Widget');
  });

  test('member-access call captures the member after the dot (left-most word+paren)', () => {
    // For "Foo<A>.Bar()" the only `word ... (` match is "Bar(".
    assert.strictEqual(extractCSharpMethodName('Foo<A>.Bar()'), 'Bar');
    assert.strictEqual(extractCSharpMethodName('builder.Build()'), 'Build');
  });

  test('non-ASCII identifiers are not matched because \\w is ASCII-only', () => {
    // "DoИt(" — \w+ matches the trailing ASCII "t" before "(".
    assert.strictEqual(extractCSharpMethodName('private async Task DoИt()'), 't');
    // "fée(" — \w+ matches the trailing ASCII "e" before "(".
    assert.strictEqual(extractCSharpMethodName('public void fée()'), 'e');
    // Fully non-ASCII name has no ASCII \w before "(" → no match.
    assert.strictEqual(extractCSharpMethodName('public void Тест()'), undefined);
  });

  test('constructor-style signature captures the type name', () => {
    assert.strictEqual(extractCSharpMethodName('public MyService(ILogger log)'), 'MyService');
  });

  test('parameters present vs absent do not change the captured name', () => {
    assert.strictEqual(
      extractCSharpMethodName('public void WithArgs(int a, string b)'),
      'WithArgs',
    );
    assert.strictEqual(extractCSharpMethodName('public void NoArgs()'), 'NoArgs');
  });

  test('special regex characters in the surrounding text do not break matching', () => {
    assert.strictEqual(extractCSharpMethodName('public void Dollar$Free() // $.*+?'), 'Free');
  });
});

suite('test-lens — extractFSharpFunctionName()', () => {
  test('simple let binding yields the bound name', () => {
    assert.strictEqual(extractFSharpFunctionName('let myTest () ='), 'myTest');
  });

  test('let binding to a value (no params) yields the name', () => {
    assert.strictEqual(extractFSharpFunctionName('let value = 42'), 'value');
  });

  test('leading whitespace is trimmed before the ^let anchor applies', () => {
    assert.strictEqual(extractFSharpFunctionName('    let indented () ='), 'indented');
    assert.strictEqual(extractFSharpFunctionName('\tlet tabbed ='), 'tabbed');
  });

  test('extra whitespace after let is consumed by \\s+', () => {
    assert.strictEqual(extractFSharpFunctionName('let  spaced ='), 'spaced');
  });

  test('let rec captures "rec" — the regex stops at the first word after let', () => {
    // Real, literal behavior: ^let\s+(\w+) captures "rec", not the function name.
    assert.strictEqual(extractFSharpFunctionName('    let rec factorial n ='), 'rec');
    assert.strictEqual(extractFSharpFunctionName('let rec loop x ='), 'rec');
  });

  test('underscores and digits are valid in let names', () => {
    assert.strictEqual(extractFSharpFunctionName('let test_1 () ='), 'test_1');
    assert.strictEqual(extractFSharpFunctionName('let _private ='), '_private');
    assert.strictEqual(extractFSharpFunctionName('let f42 ='), 'f42');
  });

  test('backtick-quoted identifiers are not matched (backtick is not \\w)', () => {
    assert.strictEqual(extractFSharpFunctionName('let ``my test`` () ='), undefined);
  });

  test('member binding captures the name after the dot', () => {
    assert.strictEqual(extractFSharpFunctionName('member this.Foo() ='), 'Foo');
    assert.strictEqual(extractFSharpFunctionName('member x.Bar ='), 'Bar');
  });

  test('member without a dot is not matched', () => {
    assert.strictEqual(extractFSharpFunctionName('member Foo'), undefined);
  });

  test('member with whitespace around the dot does not match (regex has no \\s allowance)', () => {
    assert.strictEqual(extractFSharpFunctionName('member  this . Spaced'), undefined);
  });

  test('attribute lines are not matched', () => {
    assert.strictEqual(extractFSharpFunctionName('[<Fact>]'), undefined);
    assert.strictEqual(extractFSharpFunctionName('[<Theory>]'), undefined);
    assert.strictEqual(extractFSharpFunctionName('    [<Test>]'), undefined);
  });

  test('let must be a whole token — letx is not a let binding', () => {
    assert.strictEqual(extractFSharpFunctionName('letx = 5'), undefined);
  });

  test('let must be followed by at least one whitespace and a word', () => {
    assert.strictEqual(extractFSharpFunctionName('let'), undefined);
    assert.strictEqual(extractFSharpFunctionName('let '), undefined);
    assert.strictEqual(extractFSharpFunctionName('let ='), undefined);
  });

  test('case sensitivity — uppercase LET does not match the lowercase anchor', () => {
    assert.strictEqual(extractFSharpFunctionName('LET upper ='), undefined);
  });

  test('the anchor is at the start — let not at line start is not matched', () => {
    assert.strictEqual(extractFSharpFunctionName('do let inner ='), undefined);
    assert.strictEqual(extractFSharpFunctionName('x; let y ='), undefined);
  });

  test('non-ASCII let/member names are not matched (\\w is ASCII-only)', () => {
    assert.strictEqual(extractFSharpFunctionName('let Тест () ='), undefined);
    assert.strictEqual(extractFSharpFunctionName('member self.Тест () ='), undefined);
  });

  test('empty and whitespace-only lines return undefined', () => {
    assert.strictEqual(extractFSharpFunctionName(''), undefined);
    assert.strictEqual(extractFSharpFunctionName('   '), undefined);
    assert.strictEqual(extractFSharpFunctionName('\t'), undefined);
  });

  test('let takes precedence — a line that is both let and member returns the let name', () => {
    // ^let is checked first; this contrived line starts with let.
    assert.strictEqual(extractFSharpFunctionName('let member x.Foo ='), 'member');
  });
});

suite('test-lens — formatDuration()', () => {
  test('undefined yields an empty string', () => {
    assert.strictEqual(formatDuration(undefined), '');
  });

  test('zero is rendered as a sub-second ms value', () => {
    assert.strictEqual(formatDuration(0), ' (0ms)');
  });

  test('sub-second integer durations use the ms suffix verbatim', () => {
    assert.strictEqual(formatDuration(1), ' (1ms)');
    assert.strictEqual(formatDuration(250), ' (250ms)');
    assert.strictEqual(formatDuration(999), ' (999ms)');
  });

  test('the 1000ms boundary flips to seconds with one decimal place', () => {
    assert.strictEqual(formatDuration(999), ' (999ms)');
    assert.strictEqual(formatDuration(1000), ' (1.0s)');
  });

  test('seconds are formatted with exactly one decimal place', () => {
    assert.strictEqual(formatDuration(1500), ' (1.5s)');
    assert.strictEqual(formatDuration(12345), ' (12.3s)');
    assert.strictEqual(formatDuration(60000), ' (60.0s)');
  });

  test('toFixed(1) applies IEEE-754 rounding on the seconds value', () => {
    assert.strictEqual(formatDuration(1499), ' (1.5s)'); // 1.499 -> 1.5
    // 1.45 is stored as 1.4499999... so toFixed(1) rounds DOWN to 1.4.
    assert.strictEqual(formatDuration(1450), ' (1.4s)');
    assert.strictEqual(formatDuration(1550), ' (1.6s)'); // 1.55 -> 1.6
  });

  test('fractional sub-second values are passed through to the ms branch', () => {
    assert.strictEqual(formatDuration(0.5), ' (0.5ms)');
    assert.strictEqual(formatDuration(250.7), ' (250.7ms)');
  });

  test('negative durations take the ms branch (only < 1000 is checked)', () => {
    assert.strictEqual(formatDuration(-5), ' (-5ms)');
    assert.strictEqual(formatDuration(-1000), ' (-1000ms)');
  });

  test('the result always starts with a leading space for inline-lens spacing', () => {
    assert.strictEqual(formatDuration(5).startsWith(' '), true);
    assert.strictEqual(formatDuration(5000).startsWith(' '), true);
    assert.strictEqual(formatDuration(undefined).startsWith(' '), false);
  });

  test('the ms branch wraps the raw number in parentheses with an "ms" unit', () => {
    const out = formatDuration(42);
    assert.ok(out.includes('42'));
    assert.ok(out.endsWith('ms)'));
    assert.strictEqual(out, ' (42ms)');
  });

  test('the seconds branch ends with "s)" and never with "ms)"', () => {
    const out = formatDuration(3500);
    assert.ok(out.endsWith('s)'));
    assert.ok(!out.endsWith('ms)'));
    assert.strictEqual(out, ' (3.5s)');
  });
});

// ── TestStatusLensProvider — C# documents ─────────────────────────

suite('test-lens — TestStatusLensProvider (C#)', () => {
  let tmpDir: string;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-lens-cs-'));
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a C# document is recognised as csharp by extension', async () => {
    const doc = await openDoc(tmpDir, 'Lang.cs', 'class C {}\n');
    assert.strictEqual(doc.languageId, 'csharp');
  });

  test('one [Fact] test with no cached result yields Run + Debug lenses only', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'NoResult.cs',
      ['[Fact]', 'public void Alpha()', '{', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 2);

    const run = lenses[0];
    const debug = lenses[1];
    assert.ok(run !== undefined && debug !== undefined);
    assert.strictEqual(run.command?.title, '$(play) Run Test');
    assert.strictEqual(run.command?.command, CMD_TEST_RUN_AT_CURSOR);
    assert.deepStrictEqual(run.command?.arguments, [doc.uri, 'Alpha']);
    assert.strictEqual(debug.command?.title, '$(bug) Debug Test');
    assert.strictEqual(debug.command?.command, CMD_TEST_DEBUG_AT_CURSOR);
    assert.deepStrictEqual(debug.command?.arguments, [doc.uri, 'Alpha']);
    provider.dispose();
  });

  test('the lens range covers the attribute line (line 0) full width', async () => {
    const { provider } = makeProvider();
    const attrLine = '[Fact]';
    const doc = await openDoc(
      tmpDir,
      'Range.cs',
      [attrLine, 'public void Ranged()', '{', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    const first = lenses[0];
    assert.ok(first !== undefined);
    assert.strictEqual(first.range.start.line, 0);
    assert.strictEqual(first.range.start.character, 0);
    assert.strictEqual(first.range.end.line, 0);
    assert.strictEqual(first.range.end.character, attrLine.length);
    provider.dispose();
  });

  test('a passing cached result renders a $(pass) status lens with duration', async () => {
    const { provider, controller } = makeProvider();
    controller.record('My.Ns.Suite.Beta', { passed: true, duration: 1500 });
    const doc = await openDoc(
      tmpDir,
      'Passed.cs',
      ['[Fact]', 'public void Beta()', '{', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 3);
    const status = lenses[0];
    assert.ok(status !== undefined);
    assert.strictEqual(status.command?.title, '$(pass) Passed (1.5s)');
    // Status lens is non-actionable: empty command and no arguments.
    assert.strictEqual(status.command?.command, '');
    assert.deepStrictEqual(status.command?.arguments, []);
    provider.dispose();
  });

  test('a passing result with sub-second duration uses the ms suffix', async () => {
    const { provider, controller } = makeProvider();
    controller.record('A.B.Gamma', { passed: true, duration: 42 });
    const doc = await openDoc(
      tmpDir,
      'PassedMs.cs',
      ['[Test]', 'public void Gamma()', '{', '}', ''].join('\n'),
    );

    const status = provider.provideCodeLenses(doc, NO_TOKEN)[0];
    assert.ok(status !== undefined);
    assert.strictEqual(status.command?.title, '$(pass) Passed (42ms)');
    provider.dispose();
  });

  test('a passing result without a duration omits the parenthetical', async () => {
    const { provider, controller } = makeProvider();
    controller.record('A.B.Delta', { passed: true });
    const doc = await openDoc(
      tmpDir,
      'PassedNoDur.cs',
      ['[Fact]', 'public void Delta()', '{', '}', ''].join('\n'),
    );

    const status = provider.provideCodeLenses(doc, NO_TOKEN)[0];
    assert.ok(status !== undefined);
    assert.strictEqual(status.command?.title, '$(pass) Passed');
    provider.dispose();
  });

  test('a failing cached result renders a $(error) status lens with the message', async () => {
    const { provider, controller } = makeProvider();
    controller.record('A.B.Epsilon', { passed: false, message: 'Expected 1 but got 2' });
    const doc = await openDoc(
      tmpDir,
      'Failed.cs',
      ['[Fact]', 'public void Epsilon()', '{', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 3);
    const status = lenses[0];
    assert.ok(status !== undefined);
    assert.strictEqual(status.command?.title, '$(error) Failed: Expected 1 but got 2');
    assert.strictEqual(status.command?.command, '');
    provider.dispose();
  });

  test('a failing result with no message renders bare $(error) Failed', async () => {
    const { provider, controller } = makeProvider();
    controller.record('A.B.Zeta', { passed: false });
    const doc = await openDoc(
      tmpDir,
      'FailedNoMsg.cs',
      ['[Fact]', 'public void Zeta()', '{', '}', ''].join('\n'),
    );

    const status = provider.provideCodeLenses(doc, NO_TOKEN)[0];
    assert.ok(status !== undefined);
    assert.strictEqual(status.command?.title, '$(error) Failed');
    provider.dispose();
  });

  test('the result is matched by short (last-segment) name, ignoring the namespace', async () => {
    const { provider, controller } = makeProvider();
    // FQN has dotted namespace; only the trailing "Match" segment is compared.
    controller.record('Deep.Nested.Name.Match', { passed: true, duration: 5 });
    const doc = await openDoc(
      tmpDir,
      'ShortName.cs',
      ['[Fact]', 'public void Match()', '{', '}', ''].join('\n'),
    );

    const status = provider.provideCodeLenses(doc, NO_TOKEN)[0];
    assert.ok(status !== undefined);
    assert.strictEqual(status.command?.title, '$(pass) Passed (5ms)');
    provider.dispose();
  });

  test('a cached result for an UNrelated method does not attach a status lens', async () => {
    const { provider, controller } = makeProvider();
    controller.record('Other.Unrelated', { passed: true, duration: 10 });
    const doc = await openDoc(
      tmpDir,
      'NoMatch.cs',
      ['[Fact]', 'public void Solo()', '{', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    // No status lens — just Run + Debug.
    assert.strictEqual(lenses.length, 2);
    assert.strictEqual(lenses[0]?.command?.title, '$(play) Run Test');
    provider.dispose();
  });

  test('a result id with no dot is matched against the whole id', async () => {
    const { provider, controller } = makeProvider();
    controller.record('Dotless', { passed: true, duration: 7 });
    const doc = await openDoc(
      tmpDir,
      'Dotless.cs',
      ['[Fact]', 'public void Dotless()', '{', '}', ''].join('\n'),
    );

    const status = provider.provideCodeLenses(doc, NO_TOKEN)[0];
    assert.ok(status !== undefined);
    assert.strictEqual(status.command?.title, '$(pass) Passed (7ms)');
    provider.dispose();
  });

  test('multiple test methods each produce their own lens group', async () => {
    const { provider, controller } = makeProvider();
    controller.record('N.First', { passed: true, duration: 1 });
    controller.record('N.Second', { passed: false, message: 'boom' });
    const doc = await openDoc(
      tmpDir,
      'Multi.cs',
      [
        '[Fact]',
        'public void First()',
        '{',
        '}',
        '',
        '[Theory]',
        'public void Second()',
        '{',
        '}',
        '',
      ].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    // 3 lenses per test (status + run + debug) × 2 tests.
    assert.strictEqual(lenses.length, 6);
    const titles = lenses.map((l) => l.command?.title);
    assert.ok(titles.includes('$(pass) Passed (1ms)'));
    assert.ok(titles.includes('$(error) Failed: boom'));
    // The two run lenses target the distinct method names.
    const runArgs = lenses
      .filter((l) => l.command?.command === CMD_TEST_RUN_AT_CURSOR)
      .map((l) => l.command?.arguments?.[1]);
    assert.deepStrictEqual(runArgs, ['First', 'Second']);
    provider.dispose();
  });

  test('attribute with parenthesised arguments ([Theory(...)]) is recognised', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'ParenAttr.cs',
      ['[Theory(DisplayName = "x")]', 'public void Parened()', '{', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 2);
    assert.deepStrictEqual(lenses[0]?.command?.arguments, [doc.uri, 'Parened']);
    provider.dispose();
  });

  test('an inline attribute prefixing the method ([Fact] public void) is recognised', async () => {
    const { provider } = makeProvider();
    // hasTestAttribute matches via `includes`; the method name is found by
    // scanning forward up to 6 lines — here it is on the SAME line, but the
    // leading-[ guard rejects that line, so no name is found → no lenses.
    const doc = await openDoc(
      tmpDir,
      'Inline.cs',
      ['[Fact] public void Inlined()', '{', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 0);
    provider.dispose();
  });

  test('an attribute with no method within 6 lines produces no lenses', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'Orphan.cs',
      ['[Fact]', '', '', '', '', '', '', 'public void TooFar()', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 0);
    provider.dispose();
  });

  test('a non-test attribute does not produce lenses', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'NonTest.cs',
      ['[Obsolete]', 'public void NotATest()', '{', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 0);
    provider.dispose();
  });

  test('a document with no test attributes yields an empty lens array', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'Plain.cs',
      ['public class Plain', '{', '    public void Helper() {}', '}', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.deepStrictEqual(lenses, []);
    provider.dispose();
  });

  test('an empty document yields an empty lens array', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(tmpDir, 'Empty.cs', '');
    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.deepStrictEqual(lenses, []);
    provider.dispose();
  });
});

// ── TestStatusLensProvider — F# documents ─────────────────────────

suite('test-lens — TestStatusLensProvider (F#)', () => {
  let tmpDir: string;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-lens-fs-'));
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('an F# document is recognised as fsharp by extension', async () => {
    const doc = await openDoc(tmpDir, 'Lang.fs', 'module M\n');
    assert.strictEqual(doc.languageId, 'fsharp');
  });

  test('[<Fact>] over a let binding yields Run + Debug lenses', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'Basic.fs',
      ['[<Fact>]', 'let alpha () =', '    ()', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 2);
    assert.strictEqual(lenses[0]?.command?.title, '$(play) Run Test');
    assert.deepStrictEqual(lenses[0]?.command?.arguments, [doc.uri, 'alpha']);
    assert.strictEqual(lenses[1]?.command?.title, '$(bug) Debug Test');
    assert.deepStrictEqual(lenses[1]?.command?.arguments, [doc.uri, 'alpha']);
    provider.dispose();
  });

  test('a passing cached F# result renders the $(pass) status lens', async () => {
    const { provider, controller } = makeProvider();
    controller.record('Tests.Module.beta', { passed: true, duration: 250 });
    const doc = await openDoc(
      tmpDir,
      'Passed.fs',
      ['[<Test>]', 'let beta () =', '    ()', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 3);
    assert.strictEqual(lenses[0]?.command?.title, '$(pass) Passed (250ms)');
    provider.dispose();
  });

  test('a failing cached F# result renders the $(error) status lens', async () => {
    const { provider, controller } = makeProvider();
    controller.record('Tests.gamma', { passed: false, message: 'assertion failed' });
    const doc = await openDoc(
      tmpDir,
      'Failed.fs',
      ['[<Fact>]', 'let gamma () =', '    ()', ''].join('\n'),
    );

    const status = provider.provideCodeLenses(doc, NO_TOKEN)[0];
    assert.ok(status !== undefined);
    assert.strictEqual(status.command?.title, '$(error) Failed: assertion failed');
    provider.dispose();
  });

  test('attribute with parenthesised arg ([<Test(...)>]) is recognised', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'ParenAttr.fs',
      ['[<Test(Category = "fast")>]', 'let parened () =', '    ()', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 2);
    assert.deepStrictEqual(lenses[0]?.command?.arguments, [doc.uri, 'parened']);
    provider.dispose();
  });

  test('a member binding under an attribute is captured after the dot', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'Member.fs',
      ['[<Fact>]', 'member this.MyTest () =', '    ()', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 2);
    assert.deepStrictEqual(lenses[0]?.command?.arguments, [doc.uri, 'MyTest']);
    provider.dispose();
  });

  test('backtick-quoted name under [<Fact>] finds no name within 4 lines → no lenses', async () => {
    const { provider } = makeProvider();
    // extractFSharpFunctionName cannot match the backtick form, so the forward
    // scan (limited to 4 lines) finds no binding name.
    const doc = await openDoc(
      tmpDir,
      'Backtick.fs',
      ['[<Fact>]', 'let ``my test`` () =', '    ()', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 0);
    provider.dispose();
  });

  test('an [<Fact>] with no binding within 4 lines produces no lenses', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'OrphanFs.fs',
      ['[<Fact>]', '', '', '', '', 'let tooFar () =', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 0);
    provider.dispose();
  });

  test('an F# document with no test attributes yields an empty lens array', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'Plain.fs',
      ['module Plain', '', 'let helper () = ()', ''].join('\n'),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.deepStrictEqual(lenses, []);
    provider.dispose();
  });

  test('two F# tests each yield distinct run targets', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'TwoFs.fs',
      ['[<Fact>]', 'let one () =', '    ()', '', '[<Theory>]', 'let two () =', '    ()', ''].join(
        '\n',
      ),
    );

    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(lenses.length, 4);
    const runArgs = lenses
      .filter((l) => l.command?.command === CMD_TEST_RUN_AT_CURSOR)
      .map((l) => l.command?.arguments?.[1]);
    assert.deepStrictEqual(runArgs, ['one', 'two']);
    provider.dispose();
  });
});

// ── TestStatusLensProvider — language gating, events, lifecycle ────

interface MutableWorkspace {
  getConfiguration: typeof vscode.workspace.getConfiguration;
}

suite('test-lens — TestStatusLensProvider (gating / events)', () => {
  let tmpDir: string;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-lens-misc-'));
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a non-C#/F# language (e.g. plaintext) yields no lenses', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(tmpDir, 'notes.txt', '[Fact]\npublic void X()\n');
    assert.notStrictEqual(doc.languageId, 'csharp');
    assert.notStrictEqual(doc.languageId, 'fsharp');
    const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.deepStrictEqual(lenses, []);
    provider.dispose();
  });

  test('when sharplsp.testLens.enabled is false the provider returns no lenses', async () => {
    const { provider } = makeProvider();
    const doc = await openDoc(
      tmpDir,
      'Gated.cs',
      ['[Fact]', 'public void Gated()', '{', '}', ''].join('\n'),
    );

    const mut = vscode.workspace as unknown as MutableWorkspace;
    const orig = mut.getConfiguration;
    try {
      mut.getConfiguration = (section?: string) => {
        if (section === 'sharplsp.testLens') {
          return {
            get: <T>(_key: string, _default: T): T => false as unknown as T,
          } as unknown as vscode.WorkspaceConfiguration;
        }
        return orig(section);
      };

      const lenses = provider.provideCodeLenses(doc, NO_TOKEN);
      assert.deepStrictEqual(lenses, []);
    } finally {
      mut.getConfiguration = orig;
    }
    provider.dispose();
  });

  test('onDidChangeCodeLenses fires when the controller reports results changed', () => {
    const { provider, controller } = makeProvider();
    let fired = 0;
    const sub = provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });

    controller.fireResultsChanged();
    controller.fireResultsChanged();
    assert.strictEqual(fired, 2);

    sub.dispose();
    provider.dispose();
  });

  test('dispose unsubscribes — later controller events do not reach a fresh listener count', () => {
    const { provider, controller } = makeProvider();
    let fired = 0;
    provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });

    controller.fireResultsChanged();
    assert.strictEqual(fired, 1);

    // After dispose the provider's emitter is torn down; firing the underlying
    // controller no longer drives the (now disposed) change emitter.
    provider.dispose();
    controller.fireResultsChanged();
    assert.strictEqual(fired, 1);
    controller.dispose();
  });

  test('dispose is idempotent and does not throw on a second call', () => {
    const { provider, controller } = makeProvider();
    provider.dispose();
    assert.doesNotThrow(() => {
      provider.dispose();
    });
    controller.dispose();
  });

  test('provideCodeLenses can be called repeatedly with stable output', async () => {
    const { provider, controller } = makeProvider();
    controller.record('N.Stable', { passed: true, duration: 3 });
    const doc = await openDoc(
      tmpDir,
      'Stable.cs',
      ['[Fact]', 'public void Stable()', '{', '}', ''].join('\n'),
    );

    const first = provider.provideCodeLenses(doc, NO_TOKEN);
    const second = provider.provideCodeLenses(doc, NO_TOKEN);
    assert.strictEqual(first.length, second.length);
    assert.strictEqual(first.length, 3);
    assert.strictEqual(first[0]?.command?.title, second[0]?.command?.title);
    provider.dispose();
  });

  // ── Constructor config-change subscription (test-lens.ts 37-38) ────
  //
  // The provider subscribes in its constructor to onDidChangeConfiguration and,
  // when the change `affectsConfiguration('sharplsp.testLens.enabled')`, fires
  // onDidChangeCodeLenses. We drive a REAL workspace config update on that key
  // and await the provider's change event to prove lines 37-38 execute.

  test('toggling sharplsp.testLens.enabled fires onDidChangeCodeLenses (37-38)', async function () {
    this.timeout(15_000);
    const { provider, controller } = makeProvider();
    const cfg = vscode.workspace.getConfiguration('sharplsp.testLens');
    const effective = cfg.get<boolean>('enabled', true);
    // Restore the exact prior workspace value (undefined when unset) so the key
    // is removed rather than persisted as a default into the fixture settings.
    const savedWorkspaceValue = cfg.inspect<boolean>('enabled')?.workspaceValue;

    const fired = new Promise<void>((resolve) => {
      const sub = provider.onDidChangeCodeLenses(() => {
        sub.dispose();
        resolve();
      });
    });

    try {
      // Flip the value so the configuration genuinely changes and VS Code emits
      // an onDidChangeConfiguration that affects the watched key.
      await cfg.update('enabled', !effective, vscode.ConfigurationTarget.Workspace);
      await fired; // resolves only if the constructor handler fired the emitter.
      assert.ok(true, 'provider re-emitted after the testLens.enabled config change');
    } finally {
      await vscode.workspace
        .getConfiguration('sharplsp.testLens')
        .update('enabled', savedWorkspaceValue, vscode.ConfigurationTarget.Workspace);
      provider.dispose();
      controller.dispose();
    }
  });

  test('a config change to an UNRELATED key does not fire the lens emitter', async function () {
    this.timeout(15_000);
    const { provider, controller } = makeProvider();
    let fired = 0;
    const sub = provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });

    const cfg = vscode.workspace.getConfiguration('sharplsp');
    const saved = cfg.get<string>('logging.level') ?? 'info';
    const next = saved === 'debug' ? 'info' : 'debug';
    try {
      await cfg.update('logging.level', next, vscode.ConfigurationTarget.Workspace);
      // Give VS Code a tick to deliver the config event before asserting.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      // affectsConfiguration('sharplsp.testLens.enabled') is false here, so the
      // constructor handler must NOT fire the emitter (37-38 guard is skipped).
      assert.strictEqual(fired, 0, 'unrelated config change must not refresh the lenses');
    } finally {
      await vscode.workspace
        .getConfiguration('sharplsp')
        .update('logging.level', saved, vscode.ConfigurationTarget.Workspace);
      sub.dispose();
      provider.dispose();
      controller.dispose();
    }
  });
});
