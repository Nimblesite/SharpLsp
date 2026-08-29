import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DapRouter } from '../../dap-router.js';
import { SharpLspDebugAdapterFactory } from '../../debug.js';
import { debugSessionFor } from './run-debug-kit';
import { writeSpawnableAdapter } from './run-debug-fixtures';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { removeDirRecursive } from './test-helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Spec: [DEBUG-ADAPTER-NETCOREDBG], [DEBUG-ARCHITECTURE-ROUTER].
//
// Starting the adapter must be TOTAL. `createDebugAdapterDescriptor` now builds
// an inline `DapRouter`, which spawns netcoredbg inside its own constructor —
// so a spawn failure is no longer contained at VS Code's executable-adapter
// boundary. Node's `cp.spawn` throws SYNCHRONOUSLY for any failure outside its
// EACCES/EAGAIN/EMFILE/ENFILE/ENOENT allowlist; a wrong-architecture or corrupt
// `netcoredbg.exe` on Windows raises `spawn UNKNOWN` that way, and it escaped
// the factory into the extension host.
//
// These cases pin BOTH halves of the contract: the synchronous throw becomes a
// `Result`, and the asynchronous `error` event still ends the session honestly.
// ─────────────────────────────────────────────────────────────────────────────

/** The shape of the DAP events this suite inspects. */
interface DapEvent {
  readonly event: string;
  readonly body?: { readonly output?: unknown; readonly category?: unknown };
}

/** A path `cp.spawn` rejects synchronously on every platform. */
const UNSPAWNABLE = `${path.sep}sharplsp\0netcoredbg`;

/** The binary name netcoredbg ships under on this platform. */
const EXE = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';

/**
 * A live process in the extension host's OWN process group.
 *
 * `ChildProcess.kill()` forwards to `kill(this.pid, ...)`, and a child whose
 * spawn FAILED carries NO pid — Node then issues `kill(0, ...)`, which POSIX
 * defines as "every process in the CALLER'S process group". In the extension
 * host that group is the whole VS Code tree, and under CI it also holds `make`
 * and the runner agent, so one unstartable netcoredbg terminated the entire job
 * with no test output at all. Only a process inside that group can witness the
 * difference between signalling the adapter and signalling ourselves.
 */
function processGroupCanary(): cp.ChildProcess {
  return cp.spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 30000)'], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

/** True while `canary` has neither exited nor been signalled. */
function stillAlive(canary: cp.ChildProcess): boolean {
  return canary.exitCode === null && canary.signalCode === null;
}

/**
 * Count SIGTERMs aimed at the host instead of dying from them.
 *
 * Node terminates on SIGTERM only while nothing listens, so this turns a
 * regression into a FAILED ASSERTION rather than a host that vanishes mid-run
 * and reports nothing at all.
 */
function catchHostSigterm(): { readonly count: () => number; readonly stop: () => void } {
  let seen = 0;
  const onTerm = (): void => {
    seen += 1;
  };
  process.on('SIGTERM', onTerm);
  return {
    count: () => seen,
    stop: () => {
      process.off('SIGTERM', onTerm);
    },
  };
}

suite('Debug adapter startup is total', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  let savedNetcoredbgPath: string | undefined;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-adapter-startup-'));
    stubs = installUiStubs();
    savedNetcoredbgPath = vscode.workspace
      .getConfiguration('sharplsp')
      .inspect<string>('debug.netcoredbgPath')?.globalValue;
  });

  teardown(async () => {
    stubs.restore();
    await vscode.workspace
      .getConfiguration('sharplsp')
      .update('debug.netcoredbgPath', savedNetcoredbgPath, vscode.ConfigurationTarget.Global);
    removeDirRecursive(tmpDir);
  });

  // The premise the whole suite rests on: this really is a SYNCHRONOUS throw,
  // not an `error` event. If Node ever changes that, these cases are testing
  // nothing and must be revisited rather than silently passing.
  test('the premise: cp.spawn throws synchronously for an unspawnable path', () => {
    assert.throws(
      () => cp.spawn(UNSPAWNABLE, ['--interpreter=vscode'], { stdio: 'pipe' }),
      'cp.spawn must still throw synchronously, or this suite proves nothing',
    );
  });

  test('a synchronous spawn failure becomes a Result, never a thrown error', () => {
    let threw: unknown;
    let outcome: ReturnType<typeof DapRouter.start> | undefined;
    try {
      outcome = DapRouter.start(UNSPAWNABLE);
    } catch (cause) {
      threw = cause;
    }
    assert.strictEqual(
      threw,
      undefined,
      `DapRouter.start must not throw; it threw ${String(threw)}`,
    );
    assert.notStrictEqual(outcome, undefined, 'start must return an outcome');
    assert.strictEqual(outcome?.ok, false, 'an unspawnable adapter is a failed Result');
    const reason = outcome.error;
    assert.strictEqual(typeof reason, 'string', 'the failure carries a string reason');
    assert.ok(reason.length > 0, 'the reason names the cause instead of being blank');

    // Repeated failures stay failures and never leak a throw — VS Code retries
    // the factory on every F5, so a one-shot guard is not a guard.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = DapRouter.start(UNSPAWNABLE);
      assert.strictEqual(again.ok, false, `attempt ${String(attempt)} must also fail cleanly`);
    }
  });

  test('the factory refuses the session and says why, instead of crashing the host', async () => {
    await vscode.workspace
      .getConfiguration('sharplsp')
      .update('debug.netcoredbgPath', UNSPAWNABLE, vscode.ConfigurationTarget.Global);
    const factory = new SharpLspDebugAdapterFactory();
    const session = debugSessionFor('Unspawnable', tmpDir);

    let descriptor: unknown;
    assert.doesNotThrow(() => {
      descriptor = factory.createDebugAdapterDescriptor(session);
    }, 'a spawn failure must never propagate out of createDebugAdapterDescriptor');
    assert.strictEqual(
      descriptor,
      undefined,
      'no descriptor means VS Code starts no session, rather than a dead one',
    );

    assert.strictEqual(
      stubs.log.errorMessages.length,
      1,
      `exactly one error is reported; got ${JSON.stringify(stubs.log.errorMessages)}`,
    );
    const reported = stubs.log.errorMessages[0] ?? '';
    assert.match(reported, /netcoredbg/i, 'the message names netcoredbg');
    assert.ok(
      reported.length > 'netcoredbg'.length,
      'the message carries the underlying reason, not just the binary name',
    );
  });

  // The router's teardown must signal the ADAPTER, never the process group the
  // extension host itself sits in. Adapter resolution builds a router purely to
  // read which binary it would spawn and throws it away in the SAME TICK, so
  // `dispose()` routinely runs while the asynchronous spawn failure is still in
  // flight and the router still believes its child is open.
  // Implements [DEBUG-ARCHITECTURE-ROUTER].
  test('disposing a router whose adapter never started signals only that adapter', async () => {
    const missing = path.join(tmpDir, 'never-started', EXE);
    assert.strictEqual(fs.existsSync(missing), false, 'the premise: nothing is at that path');

    const canary = processGroupCanary();
    assert.ok(
      typeof canary.pid === 'number' && canary.pid > 0,
      'the premise: the canary must really be running, in our own process group',
    );
    const host = catchHostSigterm();
    try {
      const outcome = DapRouter.start(missing);
      assert.strictEqual(outcome.ok, true, 'ENOENT fails asynchronously, not at construction');
      if (!outcome.ok) return;
      outcome.value.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 750));

      assert.strictEqual(host.count(), 0, 'the extension host must never signal ITSELF');
      assert.strictEqual(
        stillAlive(canary),
        true,
        `disposing an unstarted adapter killed an unrelated sibling (signal ${String(
          canary.signalCode,
        )}): the kill reached our whole process group instead of the adapter`,
      );
    } finally {
      host.stop();
      canary.kill('SIGKILL');
    }
  });

  // The same hazard on the restart path, where it is worse: `respawn` escalates
  // to SIGKILL after a grace second, and a SIGKILL aimed at our own process
  // group cannot be caught, logged or survived by anything in it.
  test('respawning a router whose adapter never started signals only that adapter', async () => {
    const missing = path.join(tmpDir, 'never-respawned', EXE);
    assert.strictEqual(fs.existsSync(missing), false, 'the premise: nothing is at that path');

    const canary = processGroupCanary();
    assert.ok(
      typeof canary.pid === 'number' && canary.pid > 0,
      'the premise: the canary must really be running, in our own process group',
    );
    const host = catchHostSigterm();
    try {
      const outcome = DapRouter.start(missing);
      assert.strictEqual(outcome.ok, true, 'ENOENT fails asynchronously, not at construction');
      if (!outcome.ok) return;
      outcome.value.respawn([]);
      // Past the SIGKILL escalation, so BOTH signals have had their chance.
      await new Promise<void>((resolve) => setTimeout(resolve, 1_750));
      outcome.value.dispose();

      assert.strictEqual(host.count(), 0, 'the extension host must never signal ITSELF');
      assert.strictEqual(
        stillAlive(canary),
        true,
        `respawning past an unstarted adapter killed an unrelated sibling (signal ${String(
          canary.signalCode,
        )}): the kill reached our whole process group instead of the adapter`,
      );
    } finally {
      host.stop();
      canary.kill('SIGKILL');
    }
  });

  test('a resolvable adapter still starts, so the guard did not disable debugging', () => {
    const good = writeSpawnableAdapter(path.join(tmpDir, 'good', EXE));

    const outcome = DapRouter.start(good);
    assert.strictEqual(outcome.ok, true, 'a spawnable adapter must still produce a router');
    if (!outcome.ok) return;
    assert.ok(outcome.value instanceof DapRouter, 'the value IS the router');
    assert.strictEqual(outcome.value.adapterPath, good, 'and it spawned the path it was given');
    outcome.value.dispose();
    assert.deepStrictEqual(
      stubs.log.errorMessages,
      [],
      'a working adapter reports no error to the user',
    );
  });

  // Implements the write half of [DEBUG-ADAPTER-GAPS]. `write()` guards on
  // `stdin.writable`, but that check can never be enough: netcoredbg can die
  // between the guard and the syscall, and Node then reports the broken pipe
  // ASYNCHRONOUSLY on the stream. With no `error` listener that EPIPE is an
  // uncaught exception in the extension host — observed on Windows CI as
  // `Uncaught Error: write EPIPE` at `DapRouter.write`, which killed the whole
  // run rather than the one session.
  test('writing to an adapter that has died never escapes into the host', async () => {
    const dying = writeSpawnableAdapter(path.join(tmpDir, 'dying', EXE));

    const outcome = DapRouter.start(dying);
    assert.strictEqual(outcome.ok, true, 'the premise: this adapter does start');
    if (!outcome.ok) return;
    const router = outcome.value;

    const seen: DapEvent[] = [];
    const subscription = router.onDidSendMessage((message) => {
      if (typeof (message as DapEvent).event === 'string') seen.push(message as DapEvent);
    });

    // Let it exit, so the pipe is genuinely broken rather than merely closing.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));

    // VS Code keeps forwarding client requests until it is told the session
    // ended, so this is the ordinary sequence, not a contrived one.
    assert.doesNotThrow(() => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        router.handleMessage({
          seq: attempt,
          type: 'request',
          command: 'threads',
          arguments: {},
        });
      }
    }, 'writing to a dead adapter must not throw into the extension host');

    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    subscription.dispose();
    router.dispose();

    const terminations = seen.filter((message) => message.event === 'terminated').length;
    assert.strictEqual(
      terminations,
      1,
      `a dead adapter ends the session exactly once; events: ${JSON.stringify(
        seen.map((message) => message.event),
      )}`,
    );
  });

  test('an asynchronous spawn failure still terminates the session honestly', async () => {
    const missing = path.join(tmpDir, 'absent', EXE);
    assert.strictEqual(fs.existsSync(missing), false, 'the premise: nothing is at that path');

    // ENOENT is inside Node's allowlist, so this failure arrives as an `error`
    // EVENT rather than a throw — the other half of [DEBUG-ADAPTER-GAPS].
    const outcome = DapRouter.start(missing);
    assert.strictEqual(
      outcome.ok,
      true,
      'an absent path fails asynchronously, not at construction',
    );
    if (!outcome.ok) return;
    const router = outcome.value;

    // Whole messages, not just names: the console line has to NAME the failure,
    // and an assertion on the event name alone passes for an empty message.
    const seen: DapEvent[] = [];
    const subscription = router.onDidSendMessage((message) => {
      const event = (message as DapEvent).event;
      if (typeof event === 'string') seen.push(message as DapEvent);
    });
    const events = (): string[] => seen.map((message) => message.event);
    const terminated = await new Promise<boolean>((resolve) => {
      // BOTH exits clear BOTH timers. Resolving out of the timeout while the
      // interval still ran leaked a handle into every later test in the chunk.
      const settle = (value: boolean): void => {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(value);
      };
      const timer = setTimeout(() => {
        settle(events().includes('terminated'));
      }, 5_000);
      const poll = setInterval(() => {
        if (events().includes('terminated')) settle(true);
      }, 50);
    });
    subscription.dispose();
    router.dispose();

    assert.strictEqual(
      terminated,
      true,
      `a dead adapter must end the session; events seen: ${JSON.stringify(events())}`,
    );
    // EXACTLY one of each. A failed spawn emits `error` and then `exit`, so a
    // shutdown that is not idempotent ends the session twice — and `includes`
    // cannot see that, which is how the duplicate survived review.
    const count = (name: string): number => events().filter((event) => event === name).length;
    assert.strictEqual(
      count('terminated'),
      1,
      `the session must be terminated ONCE; events seen: ${JSON.stringify(events())}`,
    );
    assert.strictEqual(
      count('output'),
      1,
      `the user is told why ONCE; events seen: ${JSON.stringify(events())}`,
    );

    // And it must SAY something actionable. An `output` event carrying an empty
    // string satisfies "exactly one output" while telling the user nothing.
    const output = seen.find((message) => message.event === 'output');
    const text = typeof output?.body?.output === 'string' ? output.body.output : '';
    assert.match(text, /netcoredbg/i, `the console line names the adapter; got ${text}`);
    assert.match(text, /ENOENT|failed to start/i, `and names the failure; got ${text}`);
    assert.strictEqual(output?.body?.category, 'stderr', 'a failure belongs on stderr, not stdout');
  });
});
