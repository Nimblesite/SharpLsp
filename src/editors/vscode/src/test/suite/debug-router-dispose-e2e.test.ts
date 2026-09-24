// The debuggee a LAUNCH started never outlives the router that owned it.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER] "Adapter lifecycle": ending the
// debuggee is netcoredbg's job while netcoredbg lives, and the router's the
// moment it stops trusting netcoredbg to do it. Disposing the router is that
// moment - VS Code disposes an adapter after the session is over, and this
// suite family disposes one after every test - and a debuggee paused under a
// debugger that has been signalled away stays suspended for good: no handler
// runs, no exit code comes, and every `make ci` on one machine stacked another
// nineteen of them, holding their files and ports.
import * as assert from 'node:assert/strict';
import { isProcessAlive } from '../../attach-target';
import { MODE } from './debug-fixture-programs';
import { LiveRouter } from './debug-router-kit';
import { useDebuggee } from './debug-suite-kit';
import { pollUntilResult } from './test-helpers';
import { DEBUG_TEST_MS, SETTLE_MS } from './test-timeouts';

for (const language of ['fsharp', 'csharp'] as const) {
  suite(`Disposing the router ends the ${language} debuggee it launched`, () => {
    const debuggee = useDebuggee(`debug-dispose-${language}-`, language);

    test('a debuggee paused on an exception does not survive the router that owned it', async function () {
      this.timeout(DEBUG_TEST_MS);
      const driver = new LiveRouter();
      let disposed = false;
      try {
        // 1. The user debugs to an exception stop, then the session is torn down
        //    without a `disconnect` reaching the adapter first.
        await driver.launch(debuggee().fixture, MODE.caught, { break_on: 'all' });
        const threadId = await driver.exceptionStop();
        const pid = await driver.launchedPid();
        assert.ok(isProcessAlive(pid), 'the paused debuggee is alive');
        assert.ok(threadId > 0, 'and paused on a real thread');
        driver.dispose();
        disposed = true;

        // 2. The debuggee goes with it: the router signals a debuggee whose
        //    debugger it just signalled away, because nothing else ever will.
        //    The wait is for the process, not for a count of events, and it
        //    sits under this test's ceiling ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
        await pollUntilResult(
          async () => isProcessAlive(pid),
          (alive) => !alive,
          SETTLE_MS,
          50,
          `debuggee ${String(pid)} to end after its router was disposed`,
        );
        assert.ok(!isProcessAlive(pid), 'the debuggee is gone');
      } finally {
        if (!disposed) driver.dispose();
      }
    });
  });
}
