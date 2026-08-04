const { run } = require('./out/test/suite/index.js');

suite('SharpLsp VS Code extension suite', () => {
  test('runs compiled tests', async function () {
    // Whole-run ceiling, not a per-test timeout (the inner mocha in
    // out/test/suite/index.js owns those). The real-repo stress suites
    // clone + restore + cold-load three real solutions, so the full run
    // legitimately exceeds the old 10-minute ceiling.
    this.timeout(Number.parseInt(process.env.MOCHA_TIMEOUT ?? '3600000', 10));
    await run();
  });
});
