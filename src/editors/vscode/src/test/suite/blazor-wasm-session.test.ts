// The shipped Blazor handoff must observe VS Code's actual event ordering.
// js-debug's Node adapter exercises the same workbench lifecycle as its browser
// adapter, without replacing startDebugging or either session event.
// Tests [DEBUG-FEATURES-LAUNCH-BLAZOR-WASM].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { launchBlazorWasm, startBrowserSession, useBlazorWasmHost } from '../../blazor-wasm-launch';
import { directoryOf, resolvePath } from '../../paths';
import { ok } from '../../result';
import { fakeFolder } from './run-debug-kit';
import { pollUntilResult, requireWorkspaceRoot } from './test-helpers';
import { DEBUG_SESSION_MS, POLL_INTERVAL_MS } from './test-timeouts';

suite('Blazor browser session lifetime', () => {
  test('a relaunch waits for the previous DevServer to exit before starting another', async function () {
    this.timeout(DEBUG_SESSION_MS);
    const project = resolvePath(
      requireWorkspaceRoot(),
      '../../../../sharplsp/tests/fixtures/blazor-wasm/BlazorWasmApp.csproj',
    );
    const config = { type: 'sharplsp-blazorwasm', request: 'launch', name: 'Relaunch', project };
    const folder = fakeFolder(directoryOf(project));
    let starts = 0;
    let stops = 0;
    let finishFirst: () => void = () => undefined;
    const restore = useBlazorWasmHost({
      startProcess: (_args, _cwd, onOutput) => {
        const first = ++starts === 1;
        onOutput('Now listening on: http://127.0.0.1:54321\n');
        return {
          ended: first
            ? new Promise((resolve) => {
                finishFirst = () => {
                  resolve(ok(undefined));
                };
              })
            : Promise.resolve(ok(undefined)),
          stop: () => {
            if (first) stops += 1;
          },
        };
      },
      startBrowserSession: () => Promise.resolve({ ended: new Promise<void>(() => undefined) }),
    });
    try {
      const first = await launchBlazorWasm(folder, config);
      assert.ok(first.ok, 'the first DevServer is serving');
      assert.equal(starts, 1);
      const replacement = launchBlazorWasm(folder, config);
      await pollUntilResult(
        () => Promise.resolve(stops),
        (value) => value > 0,
        DEBUG_SESSION_MS,
        POLL_INTERVAL_MS,
        'the old DevServer to receive stop',
      );
      assert.equal(stops, 1, 'stop is sent to the old process');
      assert.equal(starts, 1, 'the replacement must not compete for the old process port');
      finishFirst();
      await replacement;
      assert.equal(starts, 2, 'the replacement starts once the old process exits');
    } finally {
      finishFirst();
      restore();
    }
  });

  test('observes the session started before startDebugging resolves and ends on stop', async function () {
    this.timeout(DEBUG_SESSION_MS * 3);
    for (const attempt of [1, 2]) {
      const name = `Blazor browser lifetime ${String(attempt)}`;
      let running: vscode.DebugSession | undefined;
      const listener = vscode.debug.onDidStartDebugSession((session) => {
        if (session.name === name) running = session;
      });
      try {
        const browser = await startBrowserSession(undefined, {
          type: 'pwa-node',
          request: 'launch',
          name,
          runtimeExecutable: 'node',
          runtimeArgs: ['-e', 'setInterval(() => {}, 1000)'],
          console: 'internalConsole',
        });
        assert.ok(browser, 'the real js-debug session started');
        assert.ok(running, 'VS Code emitted its start before startDebugging returned');
        let ended = false;
        void browser.ended.then(() => {
          ended = true;
        });
        assert.strictEqual(ended, false, 'the lifetime stays open while the session runs');
        await vscode.debug.stopDebugging(running);
        await pollUntilResult(
          () => Promise.resolve(ended),
          (value) => value,
          DEBUG_SESSION_MS,
          POLL_INTERVAL_MS,
          'the Blazor browser lifetime to end after the actual session stops',
        );
        assert.strictEqual(ended, true, 'stopping the session releases the Blazor lifetime');
      } finally {
        listener.dispose();
        if (running !== undefined) await vscode.debug.stopDebugging(running);
      }
    }
  });
});
