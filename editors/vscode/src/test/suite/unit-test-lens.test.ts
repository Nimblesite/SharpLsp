// Pure-logic unit tests for the test-lens line parsers. These pin the EXACT
// behavior of the C#/F# signature scanners and the duration formatter that
// TestStatusLensProvider relies on to render pass/fail code lenses. Behavior
// is asserted against the literal regex semantics (notably: `\w` is ASCII-only
// without the `u` flag, so non-ASCII identifiers are NOT matched).
import * as assert from 'node:assert/strict';
import {
  extractCSharpMethodName,
  extractFSharpFunctionName,
  formatDuration,
} from '../../test-lens.js';

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
    assert.strictEqual(extractCSharpMethodName('public async Task<int> FetchAsync()'), 'FetchAsync');
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
    assert.strictEqual(extractCSharpMethodName('public void WithArgs(int a, string b)'), 'WithArgs');
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
