// A launch whose runtime misses netcoredbg's startup wait.
//
// netcoredbg gives a launched .NET runtime five seconds to call back, then
// refuses `configurationDone` with E_FAIL (`0x80004005`) and the session dies
// before any breakpoint is bound. A cold machine misses that window: the first
// `dotnet` start on a CI runner (debug-breakpoints, PR #632) refused after
// exactly 5s, and the user's F5 ended with nothing but a raw HRESULT.
//
// Driven against the stub adapter, which refuses the first configurationDone
// it is ever sent, across respawns, exactly as a cold runtime does.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER] "Adapter lifecycle" and
// [DEBUG-FEATURES-LAUNCH].
import * as os from 'node:os';
import * as path from 'node:path';
import type { DapMessage } from '../../dap-emulate';
import { assertContainsAll, eq } from './test-helpers';
import { withDriver } from './debug-flow-kit';
import {
  BEHAVIOUR,
  STARTUP_REFUSAL,
  TEST_DEADLINE_MS,
  type WedgeDriver,
  useStub,
} from './dap-stub-kit';

const SOURCE = path.join(os.tmpdir(), 'ColdStart', 'Program.cs');

/** The VS Code handshake up to `configurationDone`, returning its answer. */
async function configure(driver: WedgeDriver, request: 'launch' | 'attach'): Promise<DapMessage> {
  eq((await driver.request('initialize')).success, true, 'the adapter is speaking DAP');
  const target =
    request === 'launch'
      ? { program: path.join(os.tmpdir(), 'ColdStart', 'ColdStart.dll') }
      : { processId: process.pid };
  eq((await driver.request(request, target)).success, true, `the ${request} is accepted`);
  const armed = await driver.request('setBreakpoints', {
    source: { path: SOURCE },
    breakpoints: [{ line: 3 }],
  });
  eq(armed.success, true, 'the breakpoint is accepted, pending the runtime');
  return await driver.request('configurationDone');
}

/** The commands each adapter process was sent, one list per spawn. */
function perProcess(driver: WedgeDriver): string[][] {
  return driver.commands().reduce<string[][]>((processes, entry) => {
    if (entry === 'spawn') return [...processes, []];
    processes.at(-1)?.push(entry);
    return processes;
  }, []);
}

/** Long enough for a second, unwanted respawn to have shown itself. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TEST_DEADLINE_MS * 2));
}

suite('An adapter whose launched runtime misses its startup wait', () => {
  const start = useStub('sharplsp-coldstart-');

  test('the launch is made again by a fresh adapter and the client is answered once', () =>
    withDriver(start, BEHAVIOUR.coldStart, async (driver) => {
      const done = await configure(driver, 'launch');
      eq(done.success, true, 'the user is answered by the second attempt, not shown E_FAIL');
      eq(driver.answers('configurationDone').length, 1, 'one answer per request, never two');
      eq(driver.answers('launch').length, 1, 'the replayed launch answer is swallowed');
      eq(driver.answers('initialize').length, 1, 'the replayed initialize answer is swallowed');
      await settle();
      const processes = perProcess(driver);
      eq(processes.length, 2, 'exactly one fresh adapter replaced the refused one');
      assertContainsAll(
        (processes[1] ?? []).join(' '),
        ['initialize', 'launch', 'setBreakpoints', 'configurationDone'],
        'the fresh adapter is given the whole session again, breakpoints included',
      );
      eq(driver.events('terminated').length, 0, 'the refused adapter never ended the session');
      eq(driver.events('exited').length, 0, 'nor did its teardown reach the client');
    }));

  test('a runtime that never starts is refused to the client after one retry', () =>
    withDriver(start, BEHAVIOUR.coldStartAlways, async (driver) => {
      const done = await configure(driver, 'launch');
      eq(done.success, false, 'a second refusal is the truth and the client sees it');
      assertContainsAll(String(done.message ?? ''), ['0x80004005'], 'the adapter refusal');
      eq(done.message, STARTUP_REFUSAL, 'the refusal is forwarded verbatim');
      await settle();
      eq(perProcess(driver).length, 2, 'one retry only: no respawn loop');
      eq(driver.answers('configurationDone').length, 1, 'one answer, the final refusal');
    }));

  test('an attach is never relaunched: there is no runtime the router started', () =>
    withDriver(start, BEHAVIOUR.coldStart, async (driver) => {
      const done = await configure(driver, 'attach');
      eq(done.success, false, 'an attach refusal is not a missed startup wait');
      eq(done.message, STARTUP_REFUSAL, 'forwarded as the adapter gave it');
      await settle();
      eq(perProcess(driver).length, 1, 'no fresh adapter for an attach');
    }));
});
