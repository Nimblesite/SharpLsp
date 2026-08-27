// The pure readers the Test Explorer's run path depends on, exercised against
// the shapes a WINDOWS agent produces: a UTF-8 BOM, CRLF line endings,
// drive-letter stack traces, and every fully-qualified-name shape VSTest emits
// (a plain C# method, an F# backtick name carrying SPACES, an NUnit case name
// carrying PARENTHESES, and an F# MSTest class carrying the CLR nested-type `+`).
//
// These readers decide what the user actually sees:
//
//   • `parseTrxReport` attributes an outcome, a duration and the real assertion
//     text to each individual test. Keying on the result's `testName` instead of
//     the definition's `className.name` would mis-key every NUnit and MSTest
//     result, because those frameworks render the DISPLAY name as the BARE
//     method name.
//   • Its `RunInfo` entries are how a run tells the difference between "the
//     filter matched nothing" (`outcome="Warning"`) and "the adapter REFUSED the
//     filter" (`outcome="Error"`) — the NUnit adapter does the latter for every
//     F# backtick name, and that signal is what triggers the unfiltered retry.
//   • `parseRunSummary` decides whether a run as a whole passed. Reporting a
//     `Skipped!` summary as a failure is the headline bug this replaced.
//   • The spawned child's locale and buffer limits decide whether ANY of it
//     parses on a non-English or slow machine.
//
// Split out of `test-explorer-windows.test.ts` so each file stays under the
// project's 500-line ceiling; that suite keeps the on-disk, hostile-path flows.
//
// Covers [TEST-RUN-TRX], [TEST-ENV-LOCALE] and [DIST-CI-WIN-VSIX].
import * as assert from 'node:assert/strict';
import {
  DOTNET_CLI_LANGUAGE,
  DOTNET_MAX_BUFFER,
  DOTNET_TIMEOUT_MS,
  currentDotnetExecutable,
} from '../../dotnet-process.js';
import {
  parseAnnouncedAssemblies,
  parseTestAssemblies,
  resolveAnnouncedAssembly,
  unescapeMsBuildPath,
} from '../../test-discovery.js';
import { parseFailureMessage, parseRunSummary } from '../../test-run-output.js';
import { isRunError, parseTrx, parseTrxDuration, parseTrxReport } from '../../test-trx.js';
import { fixtureFor } from './test-explorer-fixtures';

const CS = fixtureFor('xunit-csharp');

/** The idiomatic F# backtick binding whose xUnit FQN literally contains spaces. */
const FS_FACT_SPACED = 'Fs.Xunit.Fixtures.adds two numbers with spaces';

/** The real NUnit `[TestCase]` FQN — parentheses and commas, verbatim. */
const NUNIT_CASE = 'Cs.Nunit.Fixtures.CalculatorTests.Adds_Case(2,2,4)';

/** The F# MSTest FQN, carrying the CLR nested-type `+` separator. */
const FS_MSTEST_NESTED = 'Fs.Mstest.Fixtures+CalculatorTests.AddsTwoNumbers';

/**
 * A TRX report in the shape VSTest writes on Windows: a UTF-8 BOM, CRLF line
 * endings, one `<UnitTest>` definition per `<UnitTestResult>`, and the three
 * outcome spellings. The definitions cover every FQN shape the Test Explorer has
 * to key on: a plain C# method, an F# backtick name carrying SPACES, an NUnit
 * case name carrying PARENTHESES, and an F# MSTest class carrying the `+`.
 */
const WINDOWS_TRX = `\uFEFF${[
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<TestRun id="a1" name="agent 2026-08-27" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">',
  '  <Results>',
  '    <UnitTestResult testId="r1" testName="Adds_TwoNumbers" outcome="Passed" duration="00:00:00.0010748" />',
  '    <UnitTestResult testId="r2" testName="Fails_OnPurpose" outcome="Failed" duration="00:00:00.0250000">',
  '      <Output>',
  '        <ErrorInfo>',
  '          <Message>Assert.Equal() Failure: Values differ',
  'Expected: 4',
  'Actual:   3</Message>',
  '          <StackTrace>   at Cs.Xunit.Fixtures.CalculatorTests.Fails_OnPurpose()',
  '   in C:\\Program Files (x86) copy\\My Tests\\XunitCs\\Tests.cs:line 9</StackTrace>',
  '        </ErrorInfo>',
  '      </Output>',
  '    </UnitTestResult>',
  '    <UnitTestResult testId="r3" testName="Skipped_OnPurpose" outcome="NotExecuted" />',
  '    <UnitTestResult testId="r4" testName="AddsTwoNumbers" outcome="Passed" duration="00:00:01.5000000" />',
  '    <UnitTestResult testId="r5" testName="adds two numbers with spaces" outcome="Passed" duration="00:00:00.0020000" />',
  '    <UnitTestResult testId="r6" testName="Adds_Case(2,2,4)" outcome="Passed" duration="00:00:00.0030000" />',
  '  </Results>',
  '  <TestDefinitions>',
  '    <UnitTest id="r1" name="Adds_TwoNumbers"><TestMethod className="Cs.Xunit.Fixtures.CalculatorTests" name="Adds_TwoNumbers" /></UnitTest>',
  '    <UnitTest id="r2" name="Fails_OnPurpose"><TestMethod className="Cs.Xunit.Fixtures.CalculatorTests" name="Fails_OnPurpose" /></UnitTest>',
  '    <UnitTest id="r3" name="Skipped_OnPurpose"><TestMethod className="Cs.Xunit.Fixtures.CalculatorTests" name="Skipped_OnPurpose" /></UnitTest>',
  '    <UnitTest id="r4" name="AddsTwoNumbers"><TestMethod className="Fs.Mstest.Fixtures+CalculatorTests" name="AddsTwoNumbers" /></UnitTest>',
  '    <UnitTest id="r5" name="adds two numbers with spaces"><TestMethod className="Fs.Xunit.Fixtures" name="adds two numbers with spaces" /></UnitTest>',
  '    <UnitTest id="r6" name="Adds_Case(2,2,4)"><TestMethod className="Cs.Nunit.Fixtures.CalculatorTests" name="Adds_Case(2,2,4)" /></UnitTest>',
  '  </TestDefinitions>',
  '</TestRun>',
].join('\r\n')}`;

/** The identical report a Unix agent writes: no BOM, LF endings. */
const PLAIN_TRX = WINDOWS_TRX.slice(1).split('\r\n').join('\n');

/** A one-result TRX whose result has NO matching `<TestDefinitions>` entry. */
function orphanTrx(outcome: string): string {
  return `<TestRun><Results><UnitTestResult testId="x" testName="Orphan" outcome="${outcome}" /></Results></TestRun>`;
}

/** The state `parseTrx` maps one TRX outcome spelling onto. */
function mappedOutcome(outcome: string): string | undefined {
  return parseTrx(orphanTrx(outcome))[0]?.outcome;
}

/** One assembly's `dotnet test` console summary, in VSTest's exact spacing. */
function summaryLine(
  verdict: 'Passed' | 'Failed' | 'Skipped',
  failed: number,
  passed: number,
  skipped: number,
  assembly: string,
): string {
  const total = failed + passed + skipped;
  const counts = `Failed:     ${String(failed)}, Passed:     ${String(passed)}, Skipped:     ${String(skipped)}, Total:     ${String(total)}`;
  return `${verdict}!  - ${counts}, Duration: 3 ms - ${assembly} (net10.0)`;
}

/**
 * The TRX a filtered run writes when the NUnit adapter REFUSES the expression.
 * `outcome="Error"` on the run info, no results at all — the exact document the
 * unfiltered retry keys on. Written with CRLF, as a Windows agent would.
 */
const REJECTED_FILTER_TRX = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<TestRun id="b1">',
  '  <Results />',
  '  <TestDefinitions />',
  '  <ResultSummary outcome="Failed">',
  '    <Counters total="0" executed="0" passed="0" failed="0" />',
  '    <RunInfos>',
  '      <RunInfo computerName="AGENT" outcome="Error" timestamp="2026-08-27T11:24:32.5214490+10:00">',
  "        <Text>An exception occurred while invoking executor 'executor://nunit3testexecutor/': Unexpected Word 'on' at position 43 in selection expression.</Text>",
  '      </RunInfo>',
  '    </RunInfos>',
  '  </ResultSummary>',
  '</TestRun>',
].join('\r\n');

/** The TRX a filter that simply matched nothing writes: a WARNING, not an error. */
const NO_MATCH_TRX = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<TestRun id="b2">',
  '  <Results />',
  '  <ResultSummary outcome="Completed">',
  '    <RunInfos>',
  '      <RunInfo computerName="AGENT" outcome="Warning">',
  '        <Text>No test matches the given testcase filter `FullyQualifiedName=Ns.C.Nope` in C:\\out\\X.dll</Text>',
  '      </RunInfo>',
  '    </RunInfos>',
  '  </ResultSummary>',
  '</TestRun>',
].join('\r\n');


suite('Test Explorer e2e — TRX and console readers on Windows shapes', () => {
  test('the TRX reader survives a BOM, CRLF, and every FQN shape Windows produces', function () {
    this.timeout(60_000);
    const results = parseTrx(WINDOWS_TRX);
    assert.strictEqual(results.length, 6, `every <UnitTestResult> must be read back: got ${String(results.length)}`);

    // A BOM and CRLF are what a Windows agent writes; the identical report with
    // neither must parse to exactly the same thing, field for field.
    assert.deepStrictEqual(parseTrx(PLAIN_TRX), results, 'a BOM and CRLF must not change a single parsed field');
    assert.strictEqual(WINDOWS_TRX.startsWith('\uFEFF'), true, 'the Windows fixture really does carry a BOM');
    assert.strictEqual(WINDOWS_TRX.includes('\r\n'), true, 'the Windows fixture really does use CRLF');
    assert.strictEqual(PLAIN_TRX.includes('\r'), false, 'the Unix fixture really does not');

    const byName = new Map(results.map((result) => [result.fullyQualifiedName, result]));
    assert.strictEqual(byName.size, 6, 'every result keys to a DISTINCT fully-qualified name');

    // A pass: the FQN comes from the DEFINITION, not the display name.
    const pass = byName.get(CS.passing);
    assert.ok(pass, `the C# pass must key on its FQN: ${CS.passing}`);
    assert.strictEqual(pass.outcome, 'passed', 'Passed maps to passed');
    assert.strictEqual(pass.displayName, 'Adds_TwoNumbers', 'the display name is kept alongside the FQN');
    assert.notStrictEqual(pass.displayName, pass.fullyQualifiedName, 'display name and FQN are NOT the same value');
    assert.strictEqual(pass.durationMs, 1, '00:00:00.0010748 rounds to 1ms');
    assert.strictEqual(pass.message, undefined, 'a passing test carries no assertion text');
    assert.strictEqual(pass.stackTrace, undefined, 'nor a stack trace');

    // A failure: the assertion text and the drive-letter stack trace survive.
    const failure = byName.get(CS.failing);
    assert.ok(failure, `the C# failure must key on its FQN: ${CS.failing}`);
    assert.strictEqual(failure.outcome, 'failed', 'Failed maps to failed');
    assert.strictEqual(failure.durationMs, 25, '00:00:00.0250000 is 25ms');
    assert.ok(failure.message?.startsWith('Assert.Equal() Failure'), `the real assertion text must reach the user: ${String(failure.message)}`);
    assert.ok(failure.message?.includes('Expected: 4'), 'including the expected value');
    assert.ok(failure.message?.includes('Actual:   3'), 'and the actual value');
    assert.ok(failure.stackTrace?.includes('Program Files (x86) copy'), 'a stack trace through a hostile Windows path is preserved verbatim');
    assert.ok(failure.stackTrace?.includes('Tests.cs:line 9'), 'down to the file and line');

    // A skip is a SKIP. Reporting NotExecuted as a failure was the headline bug.
    const skipped = byName.get(CS.skipped);
    assert.ok(skipped, `the skipped test must key on its FQN: ${CS.skipped}`);
    assert.strictEqual(skipped.outcome, 'skipped', 'NotExecuted maps to skipped, NOT to failed');
    assert.notStrictEqual(skipped.outcome, 'failed', 'a skipped test is never a failure');
    assert.strictEqual(skipped.durationMs, undefined, 'a test that never ran has no duration');

    // The three hostile FQN shapes.
    assert.ok(byName.has(FS_FACT_SPACED), `an F# name carrying SPACES must key verbatim: ${FS_FACT_SPACED}`);
    assert.strictEqual(byName.get(FS_FACT_SPACED)?.outcome, 'passed', 'and report its own outcome');
    assert.ok(byName.has(NUNIT_CASE), `an NUnit case name carrying PARENTHESES must key verbatim: ${NUNIT_CASE}`);
    assert.strictEqual(byName.get(NUNIT_CASE)?.displayName, 'Adds_Case(2,2,4)', "NUnit's display name is the bare method plus its row");
    assert.ok(byName.has(FS_MSTEST_NESTED), `an F# MSTest class is a CLR NESTED type, so its FQN carries '+': ${FS_MSTEST_NESTED}`);
    assert.strictEqual(byName.get(FS_MSTEST_NESTED)?.displayName, 'AddsTwoNumbers', 'MSTest renders only the bare member name');
    assert.strictEqual(byName.get(FS_MSTEST_NESTED)?.durationMs, 1500, '00:00:01.5000000 is 1500ms');

    // Outcome spellings, and the ones that must NOT become a silent pass.
    assert.strictEqual(mappedOutcome('Passed'), 'passed', 'Passed');
    assert.strictEqual(mappedOutcome('Failed'), 'failed', 'Failed');
    assert.strictEqual(mappedOutcome('Error'), 'failed', 'an Error is a failure');
    assert.strictEqual(mappedOutcome('Timeout'), 'failed', 'a Timeout is a failure');
    assert.strictEqual(mappedOutcome('Aborted'), 'failed', 'an Aborted run is a failure');
    assert.strictEqual(mappedOutcome('NotExecuted'), 'skipped', 'NotExecuted is a skip');
    assert.strictEqual(mappedOutcome('Inconclusive'), 'skipped', 'Inconclusive is a skip');
    assert.strictEqual(mappedOutcome('nOtExEcUtEd'), 'skipped', 'the outcome match is case-insensitive');
    assert.strictEqual(mappedOutcome('Nonsense'), 'notRun', 'an unknown spelling is never silently a pass');
    assert.strictEqual(mappedOutcome(''), 'notRun', 'nor is a missing outcome');

    // A result with no definition falls back to its display name rather than
    // vanishing — losing a result entirely would show the user a phantom.
    assert.strictEqual(parseTrx(orphanTrx('Passed'))[0]?.fullyQualifiedName, 'Orphan', 'an orphaned result keeps its display name as the key');

    // Unreadable input must never throw out of the run path.
    assert.deepStrictEqual(parseTrx(''), [], 'empty input yields no results');
    assert.deepStrictEqual(parseTrx('<not-trx/>'), [], 'a document that is not a TRX yields no results');
    assert.deepStrictEqual(parseTrx('<TestRun></TestRun>'), [], 'a TRX with no results yields none');

    // Durations, including the shapes that must NOT be guessed at.
    assert.strictEqual(parseTrxDuration('00:00:00.0010748'), 1, 'sub-millisecond rounds to 1ms');
    assert.strictEqual(parseTrxDuration('00:00:01.5000000'), 1500, 'one and a half seconds');
    assert.strictEqual(parseTrxDuration('00:01:02.0000000'), 62_000, 'minutes and seconds add up');
    assert.strictEqual(parseTrxDuration('01:00:00.0000000'), 3_600_000, 'a whole hour');
    assert.strictEqual(parseTrxDuration('00:00:00.0000000'), 0, 'a zero duration is zero, not undefined');
    assert.strictEqual(parseTrxDuration('garbage'), undefined, 'an unparseable duration is undefined, never NaN');
    assert.strictEqual(parseTrxDuration(undefined), undefined, 'a missing duration is undefined');
    assert.strictEqual(parseTrxDuration('1:2'), undefined, 'a malformed clock is undefined');
  });

  test('a REFUSED filter and an unmatched filter are told apart by the run info', function () {
    this.timeout(60_000);
    // This distinction is the whole basis of the unfiltered retry. Getting it
    // wrong either re-runs the world on every empty filter, or leaves every F#
    // NUnit test permanently unrunnable.
    const rejected = parseTrxReport(REJECTED_FILTER_TRX);
    assert.strictEqual(rejected.results.length, 0, 'a refused filter produces no test results at all');
    assert.strictEqual(rejected.runInfos.length, 1, 'exactly one run-level message');
    const error = rejected.runInfos[0];
    assert.ok(error, 'the run info must be readable');
    assert.strictEqual(error.outcome, 'Error', 'a refusal is recorded as an Error');
    assert.strictEqual(isRunError(error), true, 'and is classified as one');
    assert.ok(error.text.includes('selection expression'), `the adapter's own words are kept: ${error.text}`);
    assert.ok(error.text.includes('nunit3testexecutor'), 'including which adapter refused');

    const noMatch = parseTrxReport(NO_MATCH_TRX);
    assert.strictEqual(noMatch.results.length, 0, 'an unmatched filter also produces no results');
    assert.strictEqual(noMatch.runInfos.length, 1, 'and one run-level message');
    const warning = noMatch.runInfos[0];
    assert.ok(warning, 'the run info must be readable');
    assert.strictEqual(warning.outcome, 'Warning', 'but it is a WARNING, not an error');
    assert.strictEqual(isRunError(warning), false, 'so it must NOT trigger a retry — the filter simply matched nothing');
    assert.ok(warning.text.includes('No test matches'), `VSTest's own words are kept: ${warning.text}`);

    // A healthy report carries results and no run-level errors at all.
    const healthy = parseTrxReport(WINDOWS_TRX);
    assert.strictEqual(healthy.results.length, 6, 'the healthy report still parses its six results');
    assert.deepStrictEqual([...healthy.runInfos], [], 'and records no run-level message');
    assert.strictEqual(healthy.runInfos.some(isRunError), false, 'so nothing would trigger a retry');
    assert.deepStrictEqual(parseTrxReport('').runInfos, [], 'empty input yields no run info');
    assert.deepStrictEqual(parseTrxReport('<not-trx/>').runInfos, [], 'a non-TRX document yields no run info');
  });

  test('the console reader sums every assembly and never calls a skip a failure', function () {
    this.timeout(60_000);
    const passed = parseRunSummary(summaryLine('Passed', 0, 1, 0, 'XunitCs.dll'));
    assert.ok(passed, 'a passing run prints a summary');
    assert.strictEqual(passed.outcome, 'passed', 'a passing run is a pass');
    assert.deepStrictEqual(
      { passed: passed.passed, failed: passed.failed, skipped: passed.skipped, total: passed.total },
      { passed: 1, failed: 0, skipped: 0, total: 1 },
      'and every count is read exactly',
    );

    const failed = parseRunSummary(summaryLine('Failed', 1, 0, 0, 'XunitCs.dll'));
    assert.ok(failed, 'a failing run prints a summary');
    assert.strictEqual(failed.outcome, 'failed', 'a failing run is a failure');
    assert.strictEqual(failed.failed, 1, 'the failure is counted');

    // THE HEADLINE BUG: `Skipped!` does not contain `Passed!`, so the old
    // `output.includes('Passed!')` test reported every skipped test as FAILED.
    const skipped = parseRunSummary(summaryLine('Skipped', 0, 0, 1, 'XunitFs.dll'));
    assert.ok(skipped, 'a skipped-only run prints a summary too');
    assert.strictEqual(skipped.outcome, 'skipped', 'a skipped-only run is a SKIP, not a failure');
    assert.notStrictEqual(skipped.outcome, 'failed', 'never a failure');
    assert.strictEqual(skipped.skipped, 1, 'the skip is counted');
    assert.strictEqual(skipped.passed, 0, 'nothing passed');

    // A solution run prints ONE summary PER ASSEMBLY; the counts must be SUMMED.
    const solution = [
      summaryLine('Passed', 0, 3, 0, 'XunitCs.dll'),
      summaryLine('Failed', 2, 1, 1, 'XunitFs.dll'),
      summaryLine('Skipped', 0, 0, 2, 'NunitCs.dll'),
    ].join('\r\n');
    const summed = parseRunSummary(solution);
    assert.ok(summed, 'a multi-assembly run prints several summaries');
    assert.deepStrictEqual(
      { passed: summed.passed, failed: summed.failed, skipped: summed.skipped, total: summed.total },
      { passed: 4, failed: 2, skipped: 3, total: 9 },
      'every assembly contributes to the totals — reading only the first would under-count',
    );
    assert.strictEqual(summed.outcome, 'failed', 'one failing assembly makes the whole run a failure');
    assert.strictEqual(summed.total, summed.passed + summed.failed + summed.skipped, 'the totals are self-consistent');

    // CRLF is what Windows writes.
    assert.deepStrictEqual(parseRunSummary(solution.split('\r\n').join('\n')), summed, 'CRLF and LF parse identically');

    // No summary at all is what a filter matching nothing prints, and it is NOT
    // a failure — it is "nothing ran".
    assert.strictEqual(parseRunSummary(''), undefined, 'no output means no summary');
    assert.strictEqual(
      parseRunSummary('No test matches the given testcase filter `FullyQualifiedName=Ns.C.Nope` in X.dll'),
      undefined,
      'an unmatched filter prints no summary at all',
    );
    assert.strictEqual(parseRunSummary('Determining projects to restore...'), undefined, 'build chatter is not a summary');
    const zero = parseRunSummary(summaryLine('Passed', 0, 0, 0, 'Empty.dll'));
    assert.ok(zero, 'an assembly with no tests still prints a summary');
    assert.strictEqual(zero.outcome, 'notRun', 'zero total tests is "nothing ran", not a pass');

    // The assertion text `--verbosity quiet` used to swallow.
    const failureBlock = [
      '  Failed Cs.Xunit.Fixtures.CalculatorTests.Fails_OnPurpose [2 ms]',
      '  Error Message:',
      '   Assert.Equal() Failure: Values differ',
      'Expected: 4',
      'Actual:   3',
      '  Stack Trace:',
      '     at Cs.Xunit.Fixtures.CalculatorTests.Fails_OnPurpose()',
    ].join('\r\n');
    const message = parseFailureMessage(failureBlock);
    assert.ok(message, 'the Error Message block must be found');
    assert.ok(message.startsWith('Assert.Equal() Failure'), `the message starts at the assertion text: ${message}`);
    assert.ok(message.includes('Expected: 4'), 'and keeps the expected value');
    assert.ok(message.includes('Actual:   3'), 'and the actual value');
    assert.strictEqual(message.includes('Stack Trace'), false, 'and stops before the stack trace');
    assert.strictEqual(message.includes('at Cs.Xunit'), false, 'so no stack frame leaks into the message');
    assert.strictEqual(parseFailureMessage('Passed!  - Failed: 0'), undefined, 'output with no Error Message block yields undefined');
    assert.strictEqual(parseFailureMessage(''), undefined, 'empty output yields undefined');
    assert.strictEqual(
      parseFailureMessage(['  Error Message:', '   first failure', '  Failed Ns.C.Second [1 ms]', '   second failure'].join('\n')),
      'first failure',
      "the block ends at the next test's Failed header",
    );
  });

  test('the dotnet child process is pinned to English and sized for a cold Windows restore', function () {
    this.timeout(60_000);
    // EVERY string this file parses — `Passed!`, `Error Message:`, `Test run for`
    // — is English. `dotnet` localizes all of them, so on a German or Japanese
    // Windows install nothing would match and every test would read as failed.
    assert.strictEqual(DOTNET_CLI_LANGUAGE, 'en-US', 'the CLI UI language is pinned so the parsed strings are deterministic');
    assert.strictEqual(typeof DOTNET_CLI_LANGUAGE, 'string', 'and it is a plain string, passed straight into the child env');

    // Node's execFile defaults are 1 MiB of stdout and no timeout unless set.
    // A cold restore of a solution blows the first; a slow agent needs the second.
    assert.strictEqual(DOTNET_MAX_BUFFER, 64 * 1024 * 1024, 'the stdout buffer is 64 MiB');
    assert.ok(DOTNET_MAX_BUFFER >= 16 * 1024 * 1024, `a full build log needs far more than Node's 1 MiB default, got ${String(DOTNET_MAX_BUFFER)}`);
    assert.strictEqual(DOTNET_MAX_BUFFER > 1024 * 1024, true, "and strictly more than Node's default");
    assert.strictEqual(DOTNET_TIMEOUT_MS, 600_000, 'the ceiling is ten minutes');
    assert.ok(DOTNET_TIMEOUT_MS >= 300_000, `a cold Windows restore needs minutes, got ${String(DOTNET_TIMEOUT_MS)}ms`);
    assert.strictEqual(DOTNET_TIMEOUT_MS / 60_000, 10, 'the ceiling is a whole number of minutes');
    assert.strictEqual(Number.isInteger(DOTNET_TIMEOUT_MS), true, 'the timeout is whole milliseconds');

    // The executable itself is resolved, not assumed: [DIST-RUNTIME-ACQUIRE] can
    // install an SDK that is not on PATH, and the controller tracks that signal.
    const executable = currentDotnetExecutable();
    assert.strictEqual(typeof executable, 'string', 'the resolved executable is a string');
    assert.ok(executable.length > 0, 'and never empty — an empty argv[0] cannot spawn');
    assert.ok(
      executable === 'dotnet' || executable.includes('dotnet'),
      `the resolved executable must still be dotnet, got ${executable}`,
    );
  });

  test('MSBuild percent-escaping in the assembly banner is decoded, not dropped', function () {
    this.timeout(60_000);
    // The `Test run for <path>` banner comes through MSBuild, which reserves
    // `%`, `*`, `?`, `@`, `$`, `(`, `)`, `;`, `'` and `,` inside property and
    // item values and encodes them as `%XX`. `C:\\Program Files (x86)\\…` — the
    // commonest hostile Windows path there is — is therefore announced as a path
    // that does not exist. Dropping it skipped the fully-qualified listing and
    // degraded discovery to DISPLAY names, losing every NUnit test, every MSTest
    // test and every theory, silently.
    assert.strictEqual(unescapeMsBuildPath('C:\\Program Files %28x86%29\\bin\\A.dll'), 'C:\\Program Files (x86)\\bin\\A.dll', 'parentheses come back as ( and )');
    assert.strictEqual(unescapeMsBuildPath('/tmp/a %3B b/c.dll'), '/tmp/a ; b/c.dll', 'a semicolon comes back from %3B');
    assert.strictEqual(unescapeMsBuildPath("/tmp/it%27s/c.dll"), "/tmp/it's/c.dll", 'an apostrophe from %27');
    assert.strictEqual(unescapeMsBuildPath('/tmp/a%2Cb/c.dll'), '/tmp/a,b/c.dll', 'a comma from %2C');
    assert.strictEqual(unescapeMsBuildPath('/tmp/a%40b/c.dll'), '/tmp/a@b/c.dll', 'an at sign from %40');
    assert.strictEqual(unescapeMsBuildPath('/tmp/a%24b/c.dll'), '/tmp/a$b/c.dll', 'a dollar from %24');
    assert.strictEqual(unescapeMsBuildPath('/tmp/a%2Ab/c.dll'), '/tmp/a*b/c.dll', 'an asterisk from %2A');
    assert.strictEqual(unescapeMsBuildPath('/tmp/a%3Fb/c.dll'), '/tmp/a?b/c.dll', 'a question mark from %3F');
    assert.strictEqual(unescapeMsBuildPath('/tmp/100%25/c.dll'), '/tmp/100%/c.dll', 'and the percent sign itself from %25');
    assert.strictEqual(unescapeMsBuildPath('/tmp/%28%29%28%29/c.dll'), '/tmp/()()/c.dll', 'several escapes in a row all decode');
    assert.strictEqual(unescapeMsBuildPath('/tmp/%2f/c.dll'), '/tmp///c.dll', 'lower-case hex decodes too');
    assert.strictEqual(unescapeMsBuildPath('/tmp/plain/c.dll'), '/tmp/plain/c.dll', 'a path with nothing to decode is returned unchanged');
    assert.strictEqual(unescapeMsBuildPath('/tmp/50%/c.dll'), '/tmp/50%/c.dll', 'a bare percent is left alone, never dropped');
    assert.strictEqual(unescapeMsBuildPath('/tmp/c.dll%'), '/tmp/c.dll%', 'a trailing percent with no hex survives');
    assert.strictEqual(unescapeMsBuildPath('/tmp/%zz/c.dll'), '/tmp/%zz/c.dll', 'a non-hex escape is not a decode');
    assert.strictEqual(unescapeMsBuildPath('/tmp/%2/c.dll'), '/tmp/%2/c.dll', 'a one-digit escape is not a decode');
    assert.strictEqual(unescapeMsBuildPath(''), '', 'the empty path decodes to itself');

    // And the banner parser keeps the raw, still-escaped spelling: resolving it
    // to a real file is a separate, filesystem-aware step.
    const escaped = 'C:\\Program Files %28x86%29\\repo\\bin\\Debug\\net10.0\\A.dll';
    const banner = `Test run for ${escaped} (.NETCoreApp,Version=v10.0)`;
    assert.deepStrictEqual(parseAnnouncedAssemblies(banner), [escaped], 'the parser reports the banner verbatim, escaping and all');
    assert.deepStrictEqual(parseAnnouncedAssemblies(`${banner}\r\n${banner}`), [escaped], 'a repeated CRLF banner yields one entry');
    assert.deepStrictEqual(parseTestAssemblies(banner), [], 'and neither spelling exists on THIS disk, so nothing survives the filter');
    assert.strictEqual(resolveAnnouncedAssembly(escaped), undefined, 'an assembly that exists in neither spelling resolves to undefined');
  });
});
