/**
 * Reading a VSTest **TRX** report — the per-test result record `dotnet test`
 * writes when handed `--logger trx`.
 *
 * The Test Explorer used to infer a whole run's outcome from whether the console
 * summary contained the word `Passed!`. That cannot attribute a result to an
 * individual test, so running a class of twenty tests meant twenty separate
 * `dotnet test` invocations — twenty builds — and a skipped test came back as a
 * failure. TRX is the structured record of the same run: one entry per test,
 * with its outcome, duration, assertion message and stack trace.
 *
 * Crucially, a result's `testName` is the DISPLAY name, which NUnit and MSTest
 * render as the bare method name. The fully-qualified name the Test Explorer
 * keys on is reconstructed from the test's definition instead
 * (`TestMethod/@className` + `.` + `TestMethod/@name`), which reproduces
 * `TestCase.FullyQualifiedName` exactly for xUnit, NUnit and MSTest in both C#
 * and F# — including F# backtick names carrying spaces and NUnit `[TestCase]`
 * names carrying parentheses.
 *
 * Implements [TEST-RUN-TRX].
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { TestOutcome } from './test-run-output.js';

/** A run-level message VSTest recorded, outside any individual test. */
export interface TrxRunInfo {
  /** `Error`, `Warning`, … verbatim from the report. */
  readonly outcome: string;
  readonly text: string;
}

/** Everything one TRX file says: per-test results plus run-level messages. */
export interface TrxReport {
  readonly results: readonly TrxTestResult[];
  readonly runInfos: readonly TrxRunInfo[];
}

/** One test's result, keyed by the fully-qualified name the tree uses. */
export interface TrxTestResult {
  readonly fullyQualifiedName: string;
  readonly displayName: string;
  readonly outcome: TestOutcome;
  readonly durationMs: number | undefined;
  readonly message: string | undefined;
  readonly stackTrace: string | undefined;
}

interface TrxUnitTestResult {
  readonly '@_testId'?: string;
  readonly '@_testName'?: string;
  readonly '@_outcome'?: string;
  readonly '@_duration'?: string;
  readonly Output?: { readonly ErrorInfo?: { readonly Message?: string; readonly StackTrace?: string } };
}

interface TrxTestMethod {
  readonly '@_className'?: string;
  readonly '@_name'?: string;
}

interface TrxUnitTest {
  readonly '@_id'?: string;
  readonly '@_name'?: string;
  readonly TestMethod?: TrxTestMethod;
}

interface TrxRunInfoElement {
  readonly '@_outcome'?: string;
  readonly Text?: string;
}

interface TrxDocument {
  readonly TestRun?: {
    readonly Results?: { readonly UnitTestResult?: TrxUnitTestResult[] };
    readonly TestDefinitions?: { readonly UnitTest?: TrxUnitTest[] };
    readonly ResultSummary?: { readonly RunInfos?: { readonly RunInfo?: TrxRunInfoElement[] } };
  };
}

const trxParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  isArray: (tagName) =>
    tagName === 'UnitTestResult' || tagName === 'UnitTest' || tagName === 'RunInfo',
});

/** TRX outcome strings mapped onto the Testing API's three states. */
const OUTCOMES = new Map<string, TestOutcome>([
  ['passed', 'passed'],
  ['failed', 'failed'],
  ['error', 'failed'],
  ['timeout', 'failed'],
  ['aborted', 'failed'],
  ['notexecuted', 'skipped'],
  ['inconclusive', 'skipped'],
  ['warning', 'skipped'],
]);

/** Locate `<name>` directly inside `dir`, or `undefined`. */
export function findTrxFile(dir: string, name: string): string | undefined {
  const candidate = path.join(dir, name);
  return fs.existsSync(candidate) ? candidate : undefined;
}

/** Parse TRX text into per-test results keyed by fully-qualified name. */
export function parseTrx(xml: string): TrxTestResult[] {
  return [...parseTrxReport(xml).results];
}

/**
 * Parse TRX text into results AND run-level messages.
 *
 * The `RunInfo` entries are the structured record of what went wrong at the RUN
 * level rather than inside a test: `outcome="Warning"` for "No test matches the
 * given testcase filter", and `outcome="Error"` when an adapter REJECTED the
 * filter outright — which the NUnit adapter does for any fully-qualified name
 * containing a space, i.e. every idiomatic F# backtick test. Reading that from
 * the report is what lets a run recover instead of reporting a phantom failure.
 */
export function parseTrxReport(xml: string): TrxReport {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- fast-xml-parser is untyped; TrxDocument mirrors the TRX schema
  const doc: TrxDocument = trxParser.parse(xml);
  const definitions = doc.TestRun?.TestDefinitions?.UnitTest ?? [];
  const namesById = new Map(definitions.map((unit) => [unit['@_id'] ?? '', qualifiedName(unit)]));
  const results = (doc.TestRun?.Results?.UnitTestResult ?? []).map((result) =>
    toTestResult(result, namesById),
  );
  const runInfos = (doc.TestRun?.ResultSummary?.RunInfos?.RunInfo ?? []).map((info) => ({
    outcome: info['@_outcome'] ?? '',
    text: textOrUndefined(info.Text) ?? '',
  }));
  return { results, runInfos };
}

/** True when an adapter refused to run, as opposed to matching nothing. */
export function isRunError(info: TrxRunInfo): boolean {
  return info.outcome.toLowerCase() === 'error';
}

/** `className.name` from the definition; the display name is the last resort. */
function qualifiedName(unit: TrxUnitTest): string {
  const className = unit.TestMethod?.['@_className'];
  const method = unit.TestMethod?.['@_name'];
  if (className === undefined || className === '' || method === undefined) {
    return unit['@_name'] ?? '';
  }
  return `${className}.${method}`;
}

/** Shape one `<UnitTestResult>` into a {@link TrxTestResult}. */
function toTestResult(
  result: TrxUnitTestResult,
  namesById: ReadonlyMap<string, string>,
): TrxTestResult {
  const displayName = result['@_testName'] ?? '';
  const resolved = namesById.get(result['@_testId'] ?? '');
  const error = result.Output?.ErrorInfo;
  return {
    fullyQualifiedName: resolved === undefined || resolved === '' ? displayName : resolved,
    displayName,
    outcome: OUTCOMES.get((result['@_outcome'] ?? '').toLowerCase()) ?? 'notRun',
    durationMs: parseTrxDuration(result['@_duration']),
    message: textOrUndefined(error?.Message),
    stackTrace: textOrUndefined(error?.StackTrace),
  };
}

/** TRX writes `hh:mm:ss.fffffff`; the Testing API wants milliseconds. */
export function parseTrxDuration(duration: string | undefined): number | undefined {
  if (duration === undefined) return undefined;
  const parts = duration.split(':');
  if (parts.length !== 3) return undefined;
  const [hours, minutes, seconds] = parts.map(Number);
  if (hours === undefined || minutes === undefined || seconds === undefined) return undefined;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return undefined;
  }
  return Math.round((hours * 3_600 + minutes * 60 + seconds) * 1_000);
}

/** Trim XML text content, collapsing empty and non-string values to undefined. */
function textOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
