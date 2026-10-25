// Lint failures and live rule settings preserve current truth. [DIAG-TRUTH-GUARANTEES]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { joinPath } from '../../paths';
import {
  ACCURACY_CASES,
  assertCompilerProblem,
  assertFileStillClosed,
  type AccuracyFixture,
} from './diagnostic-accuracy-fixtures';
import {
  assertLintDocument,
  assertLintProblems,
  LINT_SOURCE,
  useLintFixture,
  readLintOracle,
  writeLintSource,
} from './diagnostic-lint-kit';
import { replaceDocumentContent } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

const COMPLEXITY_SOURCE = `module DiagnosticAccuracy.Closed

let classify value =
    if value < 0 then -1
    elif value = 0 then 0
    elif value = 1 then 1
    else 2
`;
const COMPLEXITY_RANGE = { start: { line: 2, character: 4 }, end: { line: 6, character: 10 } };
const COMPLEXITY_FINDING = {
  Code: 'FL0071',
  StartLine: 2,
  StartCharacter: 4,
  EndLine: 6,
  EndCharacter: 10,
};
const FAILURE_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
const HINT_CONFIG = JSON.stringify({ hints: { add: ['not (a = b) ===> a <> b'] } });

/** The supported upstream implementation must independently reject the same invalid configuration. */
async function assertOracleFailure(oracle: string, config: string): Promise<void> {
  await assert.rejects(readLintOracle(oracle, LINT_SOURCE, config), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('"Success":false'), true);
    assert.equal(error.message.includes('"Failure":"CompilerErrors"'), false);
    return true;
  });
}

/** A fresh, independently checked rule threshold applies to the actual closed editor source. */
async function assertComplexityStep(
  fixture: AccuracyFixture,
  oracle: string,
  threshold: number,
): Promise<void> {
  const config = joinPath(fixture.root, 'fsharplint.json');
  const rule = { enabled: true, config: { maxComplexity: threshold } };
  fs.writeFileSync(config, JSON.stringify({ cyclomaticComplexity: rule }));
  const reply = await readLintOracle(oracle, COMPLEXITY_SOURCE, config);
  const count = threshold === 2 ? 1 : 0;
  assert.deepEqual(reply.Findings, count === 0 ? [] : [COMPLEXITY_FINDING]);
  await assertLintProblems(fixture, count, 'FL0071', COMPLEXITY_RANGE);
  await assertLintDocument(fixture, count, 'FL0071', COMPLEXITY_RANGE);
  assertFileStillClosed(fixture);
}

suite('F# lint failures and live rule configuration', () => {
  let oracle: string;
  let fixture: AccuracyFixture;
  useLintFixture((current, independent) => {
    fixture = current;
    oracle = independent;
  });

  for (const [label, invalid] of [
    ['malformed JSON', '{'],
    ['invalid lint hint', JSON.stringify({ hints: { add: ['not a valid hint?'] } })],
  ] as const) {
    test(`${label} stays visible while fresh compiler errors appear and repairs clear both`, async function () {
      this.timeout(6 * LSP_RESPONSE_MS);
      await assertLintProblems(fixture, 1);
      const config = joinPath(fixture.root, 'fsharplint.json');
      fs.writeFileSync(config, invalid);
      await assertOracleFailure(oracle, config);
      const document = await vscode.workspace.openTextDocument(fixture.entryUri);
      assert.equal(await replaceDocumentContent(document, ACCURACY_CASES[0].brokenEntry), true);
      await assertCompilerProblem(fixture, fixture.entryUri, 1, 1);
      await assertLintProblems(fixture, 1, 'SLSPF0104', FAILURE_RANGE);
      await assertLintDocument(fixture, 1, 'SLSPF0104', FAILURE_RANGE);
      fs.writeFileSync(config, HINT_CONFIG);
      await assertLintProblems(fixture, 1);
      await assertLintProblems(fixture, 0, 'SLSPF0104', FAILURE_RANGE);
      await assertCompilerProblem(fixture, fixture.entryUri, 1, 1);
      assert.equal(await replaceDocumentContent(document, ACCURACY_CASES[0].source), true);
      await assertCompilerProblem(fixture, fixture.entryUri, 0, 1);
    });
  }

  for (const thresholds of [
    [2, 10, 2],
    [10, 2, 10],
  ] as const) {
    test(`live complexity thresholds ${thresholds.join(' → ')} apply in the same compiler process`, async function () {
      this.timeout(8 * LSP_RESPONSE_MS);
      await writeLintSource(fixture, oracle, COMPLEXITY_SOURCE, 0);
      for (const threshold of thresholds) await assertComplexityStep(fixture, oracle, threshold);
    });
  }
});
