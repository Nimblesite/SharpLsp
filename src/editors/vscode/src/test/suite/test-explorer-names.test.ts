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
import { fixtureFor } from './test-explorer-fixtures';
import { FAST_MS } from './test-timeouts';

const CS = fixtureFor('xunit-csharp');

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
  });
});
