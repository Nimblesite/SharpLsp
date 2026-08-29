const { run } = require('./out/test/suite/index.js');
const { WHOLE_RUN_MS } = require('./out/test/suite/test-timeouts.js');

suite('SharpLsp VS Code extension suite', () => {
  test('runs compiled tests', async function () {
    // Whole-run ceiling for one chunk, not a per-test timeout — the inner mocha
    // in out/test/suite/index.js owns those, from the tiers in
    // src/test/suite/test-timeouts.ts. This exists only so a chunk that hangs
    // outright still produces a mocha report before the CI job is killed
    // ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    this.timeout(Number.parseInt(process.env.MOCHA_TIMEOUT ?? String(WHOLE_RUN_MS), 10));
    await run();
  });
});
