// Watching what a REAL ▶ writes into the Testing view ([TEST-RUN-OUTPUT]).
//
// VS Code shows a run's output in Test Results — attached to a test when the
// extension names one, else as the run's own output — but its stable API has
// no way to read that back. So the controller's `createTestRun` is wrapped
// for the duration of a suite: every run the profiles create is the real run,
// each call is recorded and then forwarded untouched.
import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import {
  FAILS,
  NOTHING,
  ROWS,
  markerOf,
  primaryOf,
  rowMarkersOf,
  testIdOf,
  type Channel,
  type OutputFixture,
} from './test-output-fixtures';

/** What one run was told: output per test id (or for the run), every chunk, every verdict. */
export interface RunRecord {
  readonly output: Map<string, string>;
  readonly chunks: string[];
  readonly verdicts: Map<string, string>;
  /**
   * Settles when the profile ENDS the run. A Debug handler returns once its
   * session is armed, long before the run it created reports anything.
   */
  readonly ended: Promise<void>;
}

/** The key of output appended with NO test: the run's own output. */
export const RUN_OUTPUT = '<run>';

/** The verdict half of {@link recordingRun}: each call noted, then forwarded. */
function verdictsOf(
  run: vscode.TestRun,
  record: RunRecord,
): Pick<vscode.TestRun, 'passed' | 'failed' | 'errored' | 'skipped'> {
  const note = (test: vscode.TestItem, verdict: string): void => {
    record.verdicts.set(test.id, verdict);
  };
  return {
    passed: (test, ms) => {
      note(test, 'passed');
      run.passed(test, ms);
    },
    failed: (test, message, ms) => {
      note(test, 'failed');
      run.failed(test, message, ms);
    },
    errored: (test, message, ms) => {
      note(test, 'errored');
      run.errored(test, message, ms);
    },
    skipped: (test) => {
      note(test, 'skipped');
      run.skipped(test);
    },
  };
}

/** Note one `appendOutput` call against its test, or against the run. */
function noteOutput(record: RunRecord, output: string, test: vscode.TestItem | undefined): void {
  const key = test?.id ?? RUN_OUTPUT;
  record.output.set(key, `${record.output.get(key) ?? ''}${output}`);
  record.chunks.push(output);
}

/** `run`, recording every verdict and every `appendOutput` before forwarding it. */
function recordingRun(run: vscode.TestRun, record: RunRecord, onEnd: () => void): vscode.TestRun {
  return {
    ...verdictsOf(run, record),
    name: run.name,
    token: run.token,
    isPersisted: run.isPersisted,
    onDidDispose: run.onDidDispose,
    enqueued: (test) => {
      run.enqueued(test);
    },
    started: (test) => {
      run.started(test);
    },
    appendOutput: (output, location, test) => {
      noteOutput(record, output, test);
      run.appendOutput(output, location, test);
    },
    addCoverage: (coverage) => {
      run.addCoverage(coverage);
    },
    end: () => {
      run.end();
      onEnd();
    },
  };
}

/** Every run created on a controller while it is observed. */
export interface RunObserver {
  readonly runs: readonly RunRecord[];
  dispose(): void;
}

/** Record every run `controller` creates until the observer is disposed. */
export function observeRuns(controller: vscode.TestController): RunObserver {
  const original = controller.createTestRun.bind(controller);
  const runs: RunRecord[] = [];
  controller.createTestRun = (request, name, persist) => {
    let onEnd = (): void => undefined;
    const ended = new Promise<void>((resolve) => {
      onEnd = resolve;
    });
    const record: RunRecord = { output: new Map(), chunks: [], verdicts: new Map(), ended };
    runs.push(record);
    return recordingRun(original(request, name, persist), record, onEnd);
  };
  return {
    runs,
    dispose: () => {
      controller.createTestRun = original;
    },
  };
}

/** The lines shown for `key` — a test id or {@link RUN_OUTPUT} — each trimmed. */
export function linesFor(record: RunRecord, key: string): string[] {
  return (record.output.get(key) ?? '').split('\r\n').map((line) => line.trim());
}

/** Every test shown any output, in no particular order. */
export function testsShown(record: RunRecord): string[] {
  return [...record.output.keys()].filter((key) => key !== RUN_OUTPUT);
}

/** Every test whose shown lines include `line` exactly. */
function testsShowing(record: RunRecord, line: string): string[] {
  return testsShown(record).filter((key) => linesFor(record, key).includes(line));
}

/** True when the run's own output carries `text`. */
export function runShows(record: RunRecord, text: string): boolean {
  return (record.output.get(RUN_OUTPUT) ?? '').includes(text);
}

/** One channel's line is shown where its framework sends it, and on no other test. */
function assertChannel(record: RunRecord, fixture: OutputFixture, channel: Channel): void {
  const id = testIdOf(fixture, channel.key);
  const marker = markerOf(fixture, channel.key);
  const tests = testsShowing(record, marker);
  if (channel.destination === 'test') {
    assert.deepEqual(tests, [id], `"${marker}" must be shown on ${id} and only there`);
  } else {
    assert.ok(runShows(record, marker), `"${marker}" must be shown in the run's own output`);
    assert.deepEqual(tests, [], `"${marker}" is the runner's, never a test's`);
  }
  assert.equal(record.verdicts.get(id), 'passed', `${id} must pass`);
}

/** The failing test shows its line AND still fails; the silent test shows nothing. */
function assertFailingAndSilent(record: RunRecord, fixture: OutputFixture): void {
  const failing = testIdOf(fixture, FAILS);
  const shown = testsShowing(record, markerOf(fixture, FAILS));
  assert.deepEqual(
    shown,
    [failing],
    `${failing} must show what it wrote through ${primaryOf(fixture).receiver}`,
  );
  assert.equal(record.verdicts.get(failing), 'failed', `${failing} must still fail`);
  const silent = testIdOf(fixture, NOTHING);
  assert.equal(
    record.output.get(silent),
    undefined,
    `${silent} wrote nothing and must show nothing`,
  );
  assert.equal(record.verdicts.get(silent), 'passed');
}

/** Both rows of the xUnit theory keep their line under the ONE id they share. */
function assertRows(record: RunRecord, fixture: OutputFixture): void {
  if (fixture.framework !== 'xunit') return;
  const id = testIdOf(fixture, ROWS);
  for (const line of rowMarkersOf(fixture)) {
    assert.ok(linesFor(record, id).includes(line), `${id} lost "${line}"`);
  }
  assert.equal(record.verdicts.get(id), 'passed');
}

/** Every chunk is terminal text: CRLF line breaks, XML character references decoded. */
export function assertTerminalText(record: RunRecord): void {
  for (const chunk of record.chunks) {
    const bareLf = chunk.split('\r\n').some((piece) => piece.includes('\n'));
    assert.ok(
      !bareLf,
      `appendOutput needs CRLF line breaks: ${JSON.stringify(chunk.slice(0, 200))}`,
    );
    assert.ok(
      !chunk.includes('&#x'),
      `undecoded XML reference: ${JSON.stringify(chunk.slice(0, 200))}`,
    );
  }
}

/** Every claim [TEST-RUN-OUTPUT] makes, for every project of a run. */
export function assertShownWhereSent(record: RunRecord, fixtures: readonly OutputFixture[]): void {
  for (const fixture of fixtures) {
    for (const channel of fixture.channels) assertChannel(record, fixture, channel);
    assertFailingAndSilent(record, fixture);
    assertRows(record, fixture);
  }
  assertTerminalText(record);
}
