// The fully-qualified NAME reader: what an adapter decorated, and what it did
// not.
//
// [TEST-DISCOVERY-FQN] states the rule exactly. `xunit.runner.visualstudio`
// 2.2.0 appends the test case's `UniqueID` — a SHA-1, 40 hex digits — after a
// SPACE and inside PARENTHESES, and that decoration MUST come off before the
// name becomes an id: kept, it labels the test with a hex blob, escapes to a
// `--filter` that matches nothing, and cannot be reconciled with the TRX report,
// which keys on the bare `className.name`.
//
// The same spec sentence makes the OPPOSITE guarantee, and it is the harder
// half: stripping "MUST NOT touch a name that legitimately ends in parentheses",
// because the NUnit `[TestCase]` shape `Ns.Class.Adds_Case(2,2,4)` is a real
// fully-qualified name. The two are told apart by exactly two conditions — a
// space before the bracket, and 40 hex digits inside it — so a stripper that
// gets either one wrong corrupts a real test name into one that can never be
// run. `test-explorer-adapter-ids.test.ts` drives the decorating adapter
// end-to-end; this suite pins the boundary itself, permutation by permutation,
// including every near miss that differs from the decoration in ONE respect.
//
// It also covers the listing FILE those names arrive in: `dotnet vstest
// --ListFullyQualifiedTests` writes one name per line, with a UTF-8 BOM and CRLF
// endings on Windows, and one line PER THEORY ROW when the adapter decorates —
// which is why stripping is also what collapses a theory's rows onto the single
// name they share.
//
// Split out of `test-explorer-parsers.test.ts` so each file stays under the
// project's 500-line ceiling; that suite keeps the TRX, console and MSBuild
// readers.
//
// Covers [TEST-DISCOVERY-FQN].
import * as assert from 'node:assert/strict';
import { parseFullyQualifiedTestList, withoutAdapterUniqueId } from '../../test-discovery.js';
import { HEX_DIGITS, dedupeLines } from '../../test-names.js';
import { fixtureFor } from './test-explorer-fixtures';
import { eq, deepEq } from './test-helpers';
import { FAST_MS } from './test-timeouts';

const CS = fixtureFor('xunit-csharp');

/**
 * Every framework fixture in the suite, so the name reader is driven against
 * the WHOLE of [TEST-DISCOVERY-FQN]'s "name shapes that MUST round-trip
 * unchanged" table rather than against one row of it.
 */
const FRAMEWORK_KEYS: readonly string[] = [
  'xunit-csharp',
  'nunit-csharp',
  'mstest-csharp',
  'xunit-fsharp',
  'nunit-fsharp',
  'mstest-fsharp',
];

/** Every fully-qualified name those fixtures declare, de-duplicated. */
function everyFixtureName(): string[] {
  const names: string[] = [];
  for (const key of FRAMEWORK_KEYS) {
    const fixture = fixtureFor(key);
    names.push(fixture.passing, fixture.failing, fixture.skipped, fixture.parameterized);
    if (fixture.mixedParameterized !== undefined) names.push(fixture.mixedParameterized);
  }
  return [...new Set(names)];
}

/** The idiomatic F# backtick binding whose xUnit FQN literally contains spaces. */
const FS_FACT_SPACED = 'Fs.Xunit.Fixtures.adds two numbers with spaces';

/** The real NUnit `[TestCase]` FQN — parentheses and commas, verbatim. */
const NUNIT_CASE = 'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)';

/** The F# MSTest FQN, carrying the CLR nested-type `+` separator. */
const FS_MSTEST_NESTED = 'Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers';

/**
 * A real `xunit.runner.visualstudio` 2.2.0 unique ID: a SHA-1, 40 hex digits.
 *
 * [TEST-DISCOVERY-FQN] pins the shape exactly — appended after a SPACE, wrapped
 * in parentheses — because the two conditions that make it a decoration are the
 * same two that keep an NUnit `[TestCase]` name safe.
 */
const UNIQUE_ID = 'd87517d9ff18440615ea8de9ec508cb292e09385';

suite('Test Explorer — adapter decoration comes off, real names stay on', () => {
  test('an adapter unique ID is stripped, and every name that only LOOKS like one is not', function () {
    this.timeout(FAST_MS);

    // [TEST-DISCOVERY-FQN]: the decoration is a SPACE, then 40 hex digits in
    // PARENTHESES. Both conditions are load-bearing — they are exactly what
    // separates the decoration from the NUnit `[TestCase]` shape the same spec
    // requires to round-trip untouched.
    //
    // Interaction 1 — the real decoration comes off, whatever it is attached to,
    // leaving the bare name the filter and the TRX report key on.
    const decorated: readonly (readonly [string, string])[] = [
      [`${CS.passing} (${UNIQUE_ID})`, CS.passing],
      [`${CS.parameterized} (${UNIQUE_ID})`, CS.parameterized],
      [`${FS_FACT_SPACED} (${UNIQUE_ID})`, FS_FACT_SPACED],
      [`${FS_MSTEST_NESTED} (${UNIQUE_ID})`, FS_MSTEST_NESTED],
      [`${NUNIT_CASE} (${UNIQUE_ID})`, NUNIT_CASE],
      [`${CS.passing} (${UNIQUE_ID.toUpperCase()})`, CS.passing],
    ];
    for (const [raw, bare] of decorated) {
      assert.strictEqual(
        withoutAdapterUniqueId(raw),
        bare,
        `${raw} must reduce to the bare name — kept, it labels the test with a hex blob, ` +
          'escapes to a filter that matches nothing, and cannot be reconciled with the TRX report',
      );
    }
    assert.strictEqual(
      withoutAdapterUniqueId(`${FS_FACT_SPACED} (${UNIQUE_ID})`).includes(' '),
      true,
      'stripping an F# name removes the ID and NOT the spaces the binding legitimately carries',
    );
    assert.strictEqual(
      withoutAdapterUniqueId(`${NUNIT_CASE} (${UNIQUE_ID})`),
      NUNIT_CASE,
      'a decorated NUnit case keeps its OWN parentheses and loses only the appended ID',
    );

    // Interaction 2 — every near miss is left alone. Each of these differs from
    // the decoration in exactly one respect, so a stripper that got any single
    // condition wrong corrupts a real test name into one that matches nothing.
    const untouched: readonly string[] = [
      NUNIT_CASE,
      'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case (2,2,4)',
      `Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(${UNIQUE_ID})`,
      `${CS.passing} (${UNIQUE_ID.slice(0, 39)})`,
      `${CS.passing} (${UNIQUE_ID}0)`,
      `${CS.passing} (${UNIQUE_ID.slice(0, 39)}z)`,
      `${CS.passing} ()`,
      `${CS.passing} (${UNIQUE_ID}) trailing`,
      `${CS.passing}(${UNIQUE_ID})`,
      FS_FACT_SPACED,
      FS_MSTEST_NESTED,
      CS.passing,
      '',
    ];
    for (const name of untouched) {
      assert.strictEqual(
        withoutAdapterUniqueId(name),
        name,
        `'${name}' is not an adapter decoration and MUST survive verbatim — a name the ` +
          'stripper edits can never be run, because the filter no longer matches it',
      );
    }

    // Interaction 3 — the two rules stated as rules, not as a table: no space
    // before the bracket, and no hex inside it. Both are what
    // [TEST-DISCOVERY-FQN] names as the distinguishing conditions.
    assert.strictEqual(
      withoutAdapterUniqueId(`Ns.C.M(${UNIQUE_ID})`),
      `Ns.C.M(${UNIQUE_ID})`,
      'no SPACE before the bracket means it is part of the name, however hex-like it looks',
    );
    assert.strictEqual(
      withoutAdapterUniqueId('Ns.C.M (2,2,4)'),
      'Ns.C.M (2,2,4)',
      'a space before a NON-hex bracket is a name that happens to contain a space',
    );
    assert.strictEqual(
      withoutAdapterUniqueId(withoutAdapterUniqueId(`${CS.passing} (${UNIQUE_ID})`)),
      CS.passing,
      'stripping is idempotent — an already-bare id survives a second pass unchanged',
    );
    // Interaction 4 - stripping is a TOTAL function: it answers for every
    // string, and answering twice never changes the answer. A stripper that is
    // not idempotent corrupts a name the second time discovery sweeps.
    for (const name of untouched) {
      assert.strictEqual(
        withoutAdapterUniqueId(withoutAdapterUniqueId(name)),
        name,
        `'${name}' must survive a second pass unchanged`,
      );
    }
    assert.strictEqual(withoutAdapterUniqueId(' '), ' ', 'a lone space is not a decoration');
    assert.strictEqual(withoutAdapterUniqueId('()'), '()', 'nor a bare pair of brackets');
    assert.strictEqual(withoutAdapterUniqueId(' ()'), ' ()', 'nor a space and a bare pair');
    assert.strictEqual(
      withoutAdapterUniqueId(`(${UNIQUE_ID})`),
      `(${UNIQUE_ID})`,
      'a decoration with NO name in front of it is not a decorated name',
    );
  });

  test('the REAL listing file collapses theory rows onto one id, whatever decorated it', function () {
    this.timeout(FAST_MS);

    // `dotnet vstest --ListFullyQualifiedTests` writes the file this reads: one
    // name per line, a BOM on Windows, CRLF endings, and — on the decorating
    // adapter — one line PER THEORY ROW, each carrying its own unique ID
    // ([TEST-DISCOVERY-FQN]).
    //
    // Interaction 1 — a listing in exactly that shape reduces to one id per
    // test, in the order VSTest wrote them.
    const rows = [
      `${CS.passing} (${UNIQUE_ID})`,
      `${CS.parameterized} (${UNIQUE_ID})`,
      `${CS.parameterized} (${UNIQUE_ID.slice(0, 39)}a)`,
      `${FS_FACT_SPACED} (${UNIQUE_ID})`,
      NUNIT_CASE,
    ];
    const listing = `\uFEFF${rows.join('\r\n')}\r\n`;
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(listing),
      [CS.passing, CS.parameterized, FS_FACT_SPACED, NUNIT_CASE],
      'each theory row carries its own unique ID, so stripping must collapse them onto the ' +
        'one name they share — two leaves for one [Theory] is what a kept ID produces',
    );

    // Interaction 2 — the Windows envelope is removed, not carried into an id. A
    // BOM left on the first name makes that one test unrunnable and nothing
    // else, which is why it hid for so long.
    for (const id of parseFullyQualifiedTestList(listing)) {
      assert.strictEqual(id.includes('\uFEFF'), false, `${id} must carry no byte-order mark`);
      assert.strictEqual(id.includes('\r'), false, `${id} must carry no carriage return`);
      assert.strictEqual(id.trim(), id, `${id} must carry no padding`);
      assert.strictEqual(id.length > 0, true, 'and no blank line becomes an id');
    }

    // Interaction 3 — blank lines, padding and repeats are all absorbed, and the
    // NUnit shape still round-trips through the whole reader.
    const noisy = ['', `  ${CS.passing}  `, '', CS.passing, NUNIT_CASE, '   '].join('\n');
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(noisy),
      [CS.passing, NUNIT_CASE],
      'blank and padded lines are dropped, and a name listed twice is one test',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(''),
      [],
      'an empty listing yields no tests rather than one empty id',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList('\uFEFF\r\n'),
      [],
      'and a file holding nothing but a BOM yields none either',
    );
    // Interaction 4 - the reader must survive the shapes a truncated or
    // half-written listing file takes. Discovery MUST NOT throw
    // ([TEST-DISCOVERY-FQN]), and a listing it cannot read is an empty listing,
    // never an exception out of the sweep.
    assert.doesNotThrow(
      () => parseFullyQualifiedTestList('\uFEFF'),
      'a file holding nothing but a byte-order mark must not throw',
    );
    assert.doesNotThrow(
      () => parseFullyQualifiedTestList('\r\n\r\n'),
      'nor one holding nothing but line endings',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList('\r\n\r\n'),
      [],
      'and both reduce to no tests at all',
    );
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(`${CS.passing}`),
      [CS.passing],
      'a file with no trailing newline still yields its one test',
    );
  });

  // Implements the whole of [TEST-DISCOVERY-FQN]'s "Name shapes that MUST
  // round-trip unchanged" table, across all six framework fixtures at once.
  // One row of that table proves nothing about the others: the F# backtick
  // shape is the only one carrying SPACES, the NUnit shape the only one
  // carrying PARENTHESES, and the F# MSTest shape the only one carrying a CLR
  // nested-type `+`.
  test('every name shape the spec table names survives the reader, decorated or not', function () {
    this.timeout(FAST_MS);

    // Interaction 1 — every fixture name, undecorated, must come back verbatim.
    // A reader that trims, escapes or normalises ANY of them produces an id no
    // `--filter` will match and no TRX report can be reconciled with.
    const names = everyFixtureName();
    eq(names.length >= 24, true, 'all six framework fixtures contribute their four names');
    for (const name of names) {
      eq(withoutAdapterUniqueId(name), name, name + ' must survive the stripper verbatim');
      deepEq(parseFullyQualifiedTestList(name), [name], name + ' must survive the listing reader');
      eq(name.trim(), name, name + ' carries no padding to begin with');
      eq(name.includes('.'), true, name + ' is a dotted fully-qualified name');
    }
    eq(
      names.filter((name) => name.includes(' ')).length >= 1,
      true,
      'at least one shape carries SPACES - the idiomatic F# backtick binding',
    );
    eq(
      names.filter((name) => name.includes('(')).length >= 1,
      true,
      'at least one carries PARENTHESES - the NUnit [TestCase] row data',
    );
    eq(
      names.filter((name) => name.includes('+')).length >= 1,
      true,
      'and at least one a CLR nested-type + - the F# MSTest shape',
    );

    // Interaction 2 — every one of them, DECORATED, must reduce to itself. The
    // decoration is applied to whatever the adapter reports, so it lands on the
    // spaced, the parenthesised and the nested shapes alike.
    for (const name of names) {
      const decorated = name + ' (' + UNIQUE_ID + ')';
      eq(
        withoutAdapterUniqueId(decorated),
        name,
        decorated + ' must reduce to the bare name the filter and the TRX report key on',
      );
      deepEq(
        parseFullyQualifiedTestList(decorated),
        [name],
        name + ' must reduce through the LISTING reader as well as the stripper',
      );
      eq(
        withoutAdapterUniqueId(name + ' (' + UNIQUE_ID.toUpperCase() + ')'),
        name,
        name + ': a SHA-1 in upper case is still 40 hex digits',
      );
    }

    // Interaction 3 — a whole listing of decorated names, in the Windows
    // envelope VSTest really writes, must reduce to exactly the bare set, once
    // each, in listing order.
    const listing = '﻿' + names.map((name) => name + ' (' + UNIQUE_ID + ')').join('\r\n') + '\r\n';
    const parsed = parseFullyQualifiedTestList(listing);
    deepEq(parsed, names, 'the whole decorated listing reduces to the bare names, in order');
    eq(parsed.length, new Set(parsed).size, 'with no id appearing twice');
    for (const id of parsed) {
      eq(id.includes('﻿'), false, id + ' must carry no byte-order mark');
      eq(id.includes('\r'), false, id + ' must carry no carriage return');
      eq(id.includes(UNIQUE_ID), false, id + ' must carry no adapter unique ID');
    }
    // Interaction 4 - and the reader is stable under REPETITION. VSTest writes
    // one line per theory row, so the same bare name arrives many times over,
    // and the tree must hold one leaf for it however many times it was listed.
    const repeated = everyFixtureName().flatMap((name) => [name, name, name]);
    assert.deepStrictEqual(
      parseFullyQualifiedTestList(repeated.join('\n')),
      everyFixtureName(),
      'a name listed three times is one test, in first-seen order',
    );
    assert.strictEqual(
      parseFullyQualifiedTestList(repeated.join('\n')).length,
      everyFixtureName().length,
      'and the count is the count of distinct names',
    );
    assert.strictEqual(
      repeated.length,
      everyFixtureName().length * 3,
      'the input really did repeat every one of them',
    );
  });

  // [TEST-DISCOVERY-FQN] names exactly two conditions that make a trailing
  // bracket a decoration: a SPACE before it, and 40 HEX digits inside it. This
  // test walks both conditions across their whole boundary, one character at a
  // time, because "a stripper that gets either one wrong corrupts a real test
  // name into one that can never be run".
  test('the decoration boundary holds at every hex length, case and character', function () {
    this.timeout(FAST_MS);
    const base = CS.passing;

    // Interaction 1 — LENGTH. Forty digits is the decoration; every other
    // length is a name that merely resembles one.
    for (const length of [0, 1, 8, 20, 32, 38, 39, 41, 44, 64]) {
      const payload = 'a'.repeat(length);
      const candidate = base + ' (' + payload + ')';
      eq(
        withoutAdapterUniqueId(candidate),
        candidate,
        String(length) + ' hex digits is not a SHA-1, so the name must survive verbatim',
      );
    }
    eq(
      withoutAdapterUniqueId(base + ' (' + 'a'.repeat(40) + ')'),
      base,
      'and exactly forty is the decoration the adapter appends',
    );
    eq(
      withoutAdapterUniqueId(base + ' (' + 'f'.repeat(40) + ')'),
      base,
      'whatever hex digits it happens to be made of',
    );

    // Interaction 2 — CASE and ALPHABET. Every hex digit is admissible in
    // either case; nothing else is, wherever it sits in the forty.
    for (const digit of '0123456789abcdefABCDEF'.split('')) {
      eq(HEX_DIGITS.has(digit), true, digit + ' is a hex digit');
      const payload = digit.repeat(40);
      eq(
        withoutAdapterUniqueId(base + ' (' + payload + ')'),
        base,
        'a SHA-1 made entirely of ' + digit + ' is still forty hex digits',
      );
    }
    for (const digit of 'gzGZ -_.+*'.split('')) {
      eq(HEX_DIGITS.has(digit), false, JSON.stringify(digit) + ' is not a hex digit');
    }
    for (const position of [0, 1, 20, 38, 39]) {
      const payload = UNIQUE_ID.slice(0, position) + 'z' + UNIQUE_ID.slice(position + 1);
      eq(payload.length, 40, 'the spoiled payload is still forty characters long');
      const candidate = base + ' (' + payload + ')';
      eq(
        withoutAdapterUniqueId(candidate),
        candidate,
        'one non-hex character at position ' +
          String(position) +
          ' makes it a NAME, not a ' +
          'decoration - and a stripper that ignores it corrupts a real test name',
      );
    }

    // Interaction 3 — the SPACE condition, and what surrounds the bracket. No
    // space, a tab, two spaces, trailing text, a second decoration: each
    // differs from the real shape in exactly one respect.
    const nearMisses: readonly string[] = [
      base + '(' + UNIQUE_ID + ')',
      base + '\t(' + UNIQUE_ID + ')',
      base + ' [' + UNIQUE_ID + ']',
      base + ' (' + UNIQUE_ID + ') (' + UNIQUE_ID + ') tail',
      base + ' (' + UNIQUE_ID,
      base + ' ' + UNIQUE_ID + ')',
      base + ' ((' + UNIQUE_ID + '))',
    ];
    for (const candidate of nearMisses) {
      eq(
        withoutAdapterUniqueId(candidate),
        candidate,
        JSON.stringify(candidate) +
          ' is not the decoration the spec describes and must ' +
          'survive verbatim',
      );
    }
    eq(
      withoutAdapterUniqueId(base + '  (' + UNIQUE_ID + ')'),
      base + ' ',
      'the decoration is the trailing " (<sha1>)"; padding BEFORE it belongs to the name the ' +
        'adapter reported, and the stripper removes exactly what it recognises',
    );
    deepEq(
      dedupeLines(
        ['', '  ' + base + '  ', base, NUNIT_CASE, '   ', NUNIT_CASE].join('\n'),
        (line) => line.length > 0,
      ),
      [base, NUNIT_CASE],
      'the shared line reader drops blanks and padding and keeps each name once',
    );
    deepEq(
      dedupeLines('', () => true),
      [],
      'and an empty listing yields no lines at all',
    );
    // Interaction 4 - the alphabet itself. `HEX_DIGITS` is the set both halves
    // of the rule are decided by, so its membership is the rule.
    assert.strictEqual(HEX_DIGITS.size, 22, 'ten digits plus a-f in both cases');
    assert.strictEqual(HEX_DIGITS.has('0'), true, 'zero is hex');
    assert.strictEqual(HEX_DIGITS.has('9'), true, 'and nine');
    assert.strictEqual(HEX_DIGITS.has('a'), true, 'and lower-case a');
    assert.strictEqual(HEX_DIGITS.has('F'), true, 'and upper-case F');
    assert.strictEqual(HEX_DIGITS.has(' '), false, 'a space is not');
    assert.strictEqual(HEX_DIGITS.has(''), false, 'nor the empty string');
  });

  // [TEST-DISCOVERY-FQN]'s table, row by row, spelled out. Every one of the six
  // framework fixtures contributes four fully-qualified names, and each is
  // asserted on its OWN line rather than through a loop: when the reader breaks
  // it breaks for ONE shape, and the failure has to name which.
  test('each framework name is read back exactly, one row of the table at a time', function () {
    this.timeout(FAST_MS);

    // Interaction 1 — the C# shapes. xUnit's DisplayName happens to equal
    // `Namespace.Class.Method`, which is why scraping the listing worked for
    // xUnit by accident and dropped every NUnit and MSTest test (issue #180).
    const csXunit = fixtureFor('xunit-csharp');
    const csNunit = fixtureFor('nunit-csharp');
    const csMstest = fixtureFor('mstest-csharp');
    eq(withoutAdapterUniqueId(csXunit.passing), csXunit.passing, 'xUnit C#, passing');
    eq(withoutAdapterUniqueId(csXunit.failing), csXunit.failing, 'xUnit C#, failing');
    eq(withoutAdapterUniqueId(csXunit.skipped), csXunit.skipped, 'xUnit C#, skipped');
    eq(withoutAdapterUniqueId(csXunit.parameterized), csXunit.parameterized, 'xUnit C#, [Theory]');
    eq(withoutAdapterUniqueId(csNunit.passing), csNunit.passing, 'NUnit C#, passing');
    eq(withoutAdapterUniqueId(csNunit.failing), csNunit.failing, 'NUnit C#, failing');
    eq(withoutAdapterUniqueId(csNunit.skipped), csNunit.skipped, 'NUnit C#, ignored');
    eq(
      withoutAdapterUniqueId(csNunit.parameterized),
      csNunit.parameterized,
      'NUnit C#, [TestCase] - the shape carrying PARENTHESES the stripper must not touch',
    );
    eq(withoutAdapterUniqueId(csMstest.passing), csMstest.passing, 'MSTest C#, passing');
    eq(withoutAdapterUniqueId(csMstest.failing), csMstest.failing, 'MSTest C#, failing');
    eq(withoutAdapterUniqueId(csMstest.skipped), csMstest.skipped, 'MSTest C#, ignored');
    eq(
      withoutAdapterUniqueId(csMstest.parameterized),
      csMstest.parameterized,
      'MSTest C#, [DataRow] - reported without row data, so one name for every row',
    );

    // Interaction 2 — the F# shapes, which are the ones a C#-shaped reader
    // loses. F# is not a second-class case here ([TEST-OVERVIEW]).
    const fsXunit = fixtureFor('xunit-fsharp');
    const fsNunit = fixtureFor('nunit-fsharp');
    const fsMstest = fixtureFor('mstest-fsharp');
    eq(withoutAdapterUniqueId(fsXunit.passing), fsXunit.passing, 'xUnit F#, passing');
    eq(
      withoutAdapterUniqueId(fsXunit.failing),
      fsXunit.failing,
      'xUnit F#, failing - a backtick binding whose name carries SPACES',
    );
    eq(withoutAdapterUniqueId(fsXunit.skipped), fsXunit.skipped, 'xUnit F#, skipped');
    eq(
      withoutAdapterUniqueId(fsXunit.parameterized),
      fsXunit.parameterized,
      'xUnit F#, [<Theory>]',
    );
    eq(withoutAdapterUniqueId(fsNunit.passing), fsNunit.passing, 'NUnit F#, passing');
    eq(withoutAdapterUniqueId(fsNunit.failing), fsNunit.failing, 'NUnit F#, failing');
    eq(withoutAdapterUniqueId(fsNunit.skipped), fsNunit.skipped, 'NUnit F#, ignored');
    eq(
      withoutAdapterUniqueId(fsNunit.parameterized),
      fsNunit.parameterized,
      'NUnit F#, [<TestCase>] - SPACES and PARENTHESES in one name, which is the shape ' +
        'NUnit’s own filter parser then refuses ([TEST-FILTER-ESCAPE])',
    );
    eq(
      withoutAdapterUniqueId(fsMstest.passing),
      fsMstest.passing,
      'MSTest F#, passing - the CLR nested-type + separator',
    );
    eq(withoutAdapterUniqueId(fsMstest.failing), fsMstest.failing, 'MSTest F#, failing');
    eq(withoutAdapterUniqueId(fsMstest.skipped), fsMstest.skipped, 'MSTest F#, ignored');
    eq(withoutAdapterUniqueId(fsMstest.parameterized), fsMstest.parameterized, 'MSTest F#, row');

    // Interaction 3 — the same twenty-four names, DECORATED, must each reduce
    // to themselves. The adapter decorates whatever it reports, so the
    // decoration lands on the spaced, parenthesised and nested shapes alike.
    const dress = (name: string): string => name + ' (' + UNIQUE_ID + ')';
    eq(withoutAdapterUniqueId(dress(csXunit.passing)), csXunit.passing, 'decorated xUnit C#');
    eq(
      withoutAdapterUniqueId(dress(csXunit.parameterized)),
      csXunit.parameterized,
      'decorated C# theory',
    );
    eq(
      withoutAdapterUniqueId(dress(csNunit.parameterized)),
      csNunit.parameterized,
      'decorated NUnit case',
    );
    eq(
      withoutAdapterUniqueId(dress(csMstest.parameterized)),
      csMstest.parameterized,
      'decorated MSTest row',
    );
    eq(withoutAdapterUniqueId(dress(fsXunit.failing)), fsXunit.failing, 'decorated F# spaced name');
    eq(
      withoutAdapterUniqueId(dress(fsNunit.parameterized)),
      fsNunit.parameterized,
      'decorated F# NUnit case',
    );
    eq(
      withoutAdapterUniqueId(dress(fsMstest.passing)),
      fsMstest.passing,
      'decorated F# nested type',
    );
    eq(
      withoutAdapterUniqueId(dress(fsXunit.failing)).includes(' '),
      true,
      'and the F# spaces survive the stripping that removed the ID',
    );
    eq(
      withoutAdapterUniqueId(dress(csNunit.parameterized)).endsWith(')'),
      true,
      'as do the NUnit parentheses',
    );
    eq(
      withoutAdapterUniqueId(dress(fsMstest.passing)).includes('+'),
      true,
      'and the CLR nested-type separator',
    );

    // Interaction 4 — a listing holding all twenty-four decorated names reduces
    // to exactly twenty-four bare ids, once each, in order.
    const every = everyFixtureName();
    const parsed = parseFullyQualifiedTestList(every.map(dress).join('\r\n'));
    eq(parsed.length, every.length, 'one id per listed name');
    deepEq(parsed, every, 'in listing order, bare');
    eq(new Set(parsed).size, parsed.length, 'with no duplicates');
    eq(
      parsed.some((id) => id.includes(UNIQUE_ID)),
      false,
      'and no unique ID anywhere',
    );
    eq(
      parsed.some((id) => id.includes(' ')),
      true,
      'the spaced F# names are still spaced',
    );
    eq(
      parsed.some((id) => id.includes('(')),
      true,
      'the NUnit cases still carry their rows',
    );
    eq(
      parsed.some((id) => id.includes('+')),
      true,
      'and the nested-type names their separator',
    );
    // Interaction 5 - and the whole table survives the LISTING reader as well
    // as the stripper, undecorated. The two readers must agree: one is what
    // discovery uses, the other is what the file it reads is made of.
    for (const name of everyFixtureName()) {
      assert.deepStrictEqual(
        parseFullyQualifiedTestList(name),
        [name],
        `${name} must round-trip through the listing reader as itself`,
      );
    }
    assert.strictEqual(
      everyFixtureName().length,
      new Set(everyFixtureName()).size,
      'the fixtures declare distinct names, so none of these assertions is duplicated',
    );
  });
});
