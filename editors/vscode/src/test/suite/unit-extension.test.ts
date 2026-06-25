import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as extension from '../../extension.js';

// These tests import the instrumented `out/extension.js` module DIRECTLY (a
// separate module instance from the bundled `dist/extension.js` that the test
// host activates). That isolation is what makes them safe: the module-private
// `lspClient` here is never set, so `deactivate()` never stops the real shared
// client, and `notifyActivationFailure()` can be driven without touching the
// running extension's state.
//
// Only the EXPORTED, non-`registerXxx`, non-`activate` functions are reachable:
//   - notifyActivationFailure(headline, detail)  [DIST-FAILURE-UX]
//   - deactivate()
// `activate`/`activateInner` and the `registerXxx` calls would double-register
// the 75 `sharplsp.*` commands and throw, so they are intentionally untested.

// Minimal mutable view of the `vscode.window` / `vscode.commands` seams we
// monkeypatch. Stubs are always restored in `teardown` so unrelated suites are
// unaffected.
interface MutableWindow {
  showErrorMessage: typeof vscode.window.showErrorMessage;
}
interface MutableCommands {
  executeCommand: typeof vscode.commands.executeCommand;
}

suite('Extension Module — notifyActivationFailure [DIST-FAILURE-UX]', () => {
  const mutWindow = vscode.window as unknown as MutableWindow;
  const mutCommands = vscode.commands as unknown as MutableCommands;
  let origShowErrorMessage: typeof mutWindow.showErrorMessage;
  let origExecuteCommand: typeof mutCommands.executeCommand;

  setup(() => {
    origShowErrorMessage = mutWindow.showErrorMessage;
    origExecuteCommand = mutCommands.executeCommand;
  });

  teardown(() => {
    // ALWAYS restore both seams so other suites see the real implementations.
    mutWindow.showErrorMessage = origShowErrorMessage;
    mutCommands.executeCommand = origExecuteCommand;
  });

  test('resolves when the user dismisses the notification (no choice)', async () => {
    let capturedMessage: string | undefined;
    const capturedButtons: string[] = [];
    mutWindow.showErrorMessage = (async (message: string, ...items: string[]) => {
      capturedMessage = message;
      capturedButtons.push(...items);
      return undefined; // User dismissed — no button clicked.
    }) as unknown as typeof mutWindow.showErrorMessage;

    await assert.doesNotReject(async () => {
      await extension.notifyActivationFailure('Headline went wrong.', 'detailed cause');
    }, 'notifyActivationFailure must resolve when no choice is made');

    // The notification text concatenates headline and detail with a single space.
    assert.strictEqual(
      capturedMessage,
      'Headline went wrong. detailed cause',
      'Message must be `${headline} ${detail}`',
    );
    // Both convenience buttons must be offered, in order.
    assert.deepStrictEqual(
      capturedButtons,
      ['Show Log', 'Restart Window'],
      'Must offer Show Log then Restart Window buttons',
    );
  });

  test("'Show Log' choice resolves without reloading the window", async () => {
    let executeCommandCalled = false;
    mutCommands.executeCommand = (async (command: string) => {
      executeCommandCalled = true;
      assert.notStrictEqual(
        command,
        'workbench.action.reloadWindow',
        'Show Log branch must never reload the window',
      );
      return undefined;
    }) as unknown as typeof mutCommands.executeCommand;
    mutWindow.showErrorMessage = async () => 'Show Log';

    await assert.doesNotReject(async () => {
      await extension.notifyActivationFailure('Boom.', 'log please');
    }, 'Show Log branch must resolve');

    // The Show Log branch reveals the output channel and returns early — it
    // must NOT execute any command (in particular, not a window reload).
    assert.strictEqual(executeCommandCalled, false, 'Show Log branch must not execute any command');
  });

  test("'Restart Window' choice records reload command WITHOUT executing it", async () => {
    const executedCommands: string[] = [];
    // CRITICAL: stub executeCommand so the real `workbench.action.reloadWindow`
    // never runs — that would reload the test host and break every other suite.
    mutCommands.executeCommand = (async (command: string) => {
      executedCommands.push(command);
      return undefined; // Record only; do NOT execute.
    }) as unknown as typeof mutCommands.executeCommand;
    mutWindow.showErrorMessage = async () => 'Restart Window';

    await assert.doesNotReject(async () => {
      await extension.notifyActivationFailure('Crashed.', 'restart please');
    }, 'Restart Window branch must resolve');

    assert.deepStrictEqual(
      executedCommands,
      ['workbench.action.reloadWindow'],
      'Restart Window branch must invoke exactly the reload command',
    );
  });

  test('forwards empty headline and detail to the notification', async () => {
    let capturedMessage: string | undefined;
    mutWindow.showErrorMessage = async (message: string) => {
      capturedMessage = message;
      return undefined;
    };

    await extension.notifyActivationFailure('', '');
    // Empty headline + empty detail still produces the single joining space.
    assert.strictEqual(capturedMessage, ' ', 'Empty inputs must still join with a space');
  });

  test('an unrelated choice value is treated as no-op (no reload)', async () => {
    let executeCommandCalled = false;
    mutCommands.executeCommand = (async () => {
      executeCommandCalled = true;
      return undefined;
    }) as unknown as typeof mutCommands.executeCommand;
    // Return a label that matches neither button to exercise the fall-through.
    mutWindow.showErrorMessage = async () => 'Some Other Button';

    await assert.doesNotReject(async () => {
      await extension.notifyActivationFailure('Headline', 'detail');
    }, 'Unrecognised choice must resolve');
    assert.strictEqual(
      executeCommandCalled,
      false,
      'Unrecognised choice must not execute any command',
    );
  });
});

suite('Extension Module — deactivate()', () => {
  // In this imported module instance `lspClient` was never set (activate() is
  // never called here), so deactivate() takes the `undefined` path: it simply
  // disposes this module instance's log channels and resolves. It cannot stop
  // the real shared client owned by the bundled extension.
  test('resolves without throwing when no client is active', async () => {
    await assert.doesNotReject(async () => {
      await extension.deactivate();
    }, 'deactivate() must resolve when no LSP client is active');
  });

  test('is idempotent — repeated calls still resolve', async () => {
    await extension.deactivate();
    await assert.doesNotReject(async () => {
      await extension.deactivate();
    }, 'deactivate() must be safe to call multiple times');
  });
});
