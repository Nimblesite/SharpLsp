const { run } = require('./out/test/suite/index.js');

suite('SharpLsp VS Code extension suite', () => {
  test('runs compiled tests', async function () {
    this.timeout(Number.parseInt(process.env.MOCHA_TIMEOUT ?? '600000', 10));
    await run();
  });
});
