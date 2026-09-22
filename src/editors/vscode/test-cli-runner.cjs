const { run } = require('./out/test/suite/index.js');
const { WHOLE_RUN_MS } = require('./out/test/suite/test-timeouts.js');
const { chunks } = require('./test-chunks.json');

/**
 * The whole-run ceiling for THIS run ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 *
 * `WHOLE_RUN_MS` bounds ONE chunk. A run with no `MOCHA_FILES` is every chunk
 * in one process — `make test` — so it is bounded by one chunk's ceiling per
 * chunk. Applying the single-chunk ceiling to it killed the run part-way through,
 * before mocha could print a report.
 */
function wholeRunCeiling() {
  if (process.env.MOCHA_TIMEOUT) return Number.parseInt(process.env.MOCHA_TIMEOUT, 10);
  const oneChunk = Boolean(process.env.MOCHA_FILES?.trim());
  return oneChunk ? WHOLE_RUN_MS : WHOLE_RUN_MS * Object.keys(chunks).length;
}

suite('SharpLsp VS Code extension suite', () => {
  test('runs compiled tests', async function () {
    // Whole-run ceiling, not a per-test timeout — the inner mocha in
    // out/test/suite/index.js owns those, from the tiers in
    // src/test/suite/test-timeouts.ts. This exists only so a run that hangs
    // outright still produces a mocha report before the CI job is killed.
    this.timeout(wholeRunCeiling());
    await run();
  });
});
