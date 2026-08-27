/**
 * Reading a `dotnet test` run's console output back into a result.
 *
 * The Test Explorer used to decide pass/fail with `output.includes('Passed!')`.
 * That is wrong in three ways this module fixes:
 *
 *   • a SKIPPED test prints `Skipped! - Failed: 0, Passed: 0, Skipped: 1` and so
 *     was reported to the user as a FAILURE,
 *   • a filter that matches nothing prints no summary at all and was likewise
 *     reported as a failure rather than as "no test matched",
 *   • the assertion text lives in an `Error Message:` block that `--verbosity
 *     quiet` suppresses entirely, so every failure read "Test failed".
 *
 * A solution run prints one summary line PER ASSEMBLY, so the counts are summed
 * across all of them rather than read off the first line found.
 *
 * Implements [TEST-RUN-TRX].
 */

/** How a run ended, as the VS Code Testing API models it. */
export type TestOutcome = 'passed' | 'failed' | 'skipped' | 'notRun';

/** Aggregate counts across every assembly a run touched. */
export interface TestRunSummary {
  readonly outcome: TestOutcome;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
}

/** The per-assembly summary line VSTest prints once a run finishes. */
const SUMMARY_PATTERN =
  /^(?:Passed|Failed|Skipped)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/;

/** Header of the block carrying an assertion's text. */
const ERROR_MESSAGE_HEADER = 'Error Message:';

/** Lines that terminate an `Error Message:` block. */
const ERROR_MESSAGE_TERMINATORS = ['Stack Trace:', 'Error Message:', 'Failed ', 'Passed ', 'Test run for '];

/** Sum the per-assembly summary lines; `undefined` when a run printed none. */
export function parseRunSummary(output: string): TestRunSummary | undefined {
  const totals = { passed: 0, failed: 0, skipped: 0, total: 0 };
  let seen = false;
  for (const raw of output.split('\n')) {
    const match = SUMMARY_PATTERN.exec(raw.trim());
    if (match === null) continue;
    seen = true;
    totals.failed += Number(match[1]);
    totals.passed += Number(match[2]);
    totals.skipped += Number(match[3]);
    totals.total += Number(match[4]);
  }
  return seen ? { ...totals, outcome: outcomeOf(totals) } : undefined;
}

/** Failure dominates, then "ran nothing", then a skip, else a pass. */
function outcomeOf(totals: {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}): TestOutcome {
  if (totals.failed > 0) return 'failed';
  if (totals.total === 0) return 'notRun';
  if (totals.passed === 0 && totals.skipped > 0) return 'skipped';
  return 'passed';
}

/**
 * The assertion text VSTest printed for the first failing test, if any.
 *
 * `dotnet test` writes it as an indented block between `Error Message:` and
 * `Stack Trace:`; the block's own lines are NOT reliably indented (xUnit's
 * `Expected:`/`Actual:` lines start at column 0), so the block is delimited by
 * its terminators rather than by indentation.
 */
export function parseFailureMessage(output: string): string | undefined {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.trim() === ERROR_MESSAGE_HEADER);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isErrorMessageTerminator(line)) break;
    body.push(line.trimEnd());
  }
  const message = body.join('\n').trim();
  return message === '' ? undefined : message;
}

/** True when `line` closes an `Error Message:` block. */
function isErrorMessageTerminator(line: string): boolean {
  const trimmed = line.trim();
  return ERROR_MESSAGE_TERMINATORS.some((terminator) => trimmed.startsWith(terminator));
}
