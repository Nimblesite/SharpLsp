import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { State } from 'vscode-languageclient/node';
import { DOCUMENT_SELECTOR } from '../../client.js';
import { createOpenSync, type OpenSync } from '../../open-sync.js';
import { delay } from '../../utils.js';
import { closeAllEditors, openCSharpFile, removeDirRecursive } from './test-helpers';
import { ACTIVATION_MS, LSP_RESPONSE_MS } from './test-timeouts';

/**
 * The request hold across a server restart. Implements [DIST-FAILURE-UX]
 * rule 6: a restarted server must serve the documents the user already has
 * open, so a request about one waits until THAT server has been sent it.
 *
 * Drives the real hold the client installs, over real open C# documents,
 * through the client-state sequence a crash produces (Running, Stopped,
 * Starting, Running). The `next` callbacks stand in for the connection: they
 * record what reached the server, and in what order.
 */

/** Far below the hold's safety valve, far above a microtask turn. */
const HOLD_PROBE_MS = 500;
const SYMBOLS = 'textDocument/documentSymbol';
const SERVED = 'served';

type Outcome = 'forwarded' | 'held';

interface Hooks {
  readonly didOpen: NonNullable<OpenSync['middleware']['didOpen']>;
  readonly sendRequest: NonNullable<OpenSync['middleware']['sendRequest']>;
}

function hooksOf(sync: OpenSync): Hooks {
  const { didOpen, sendRequest } = sync.middleware;
  assert.ok(didOpen && sendRequest, 'the hold intercepts didOpen and requests');
  return { didOpen, sendRequest };
}

/** A request about `document`; `wire` records when it reaches the server. */
function ask(hooks: Hooks, document: vscode.TextDocument, wire: string[]): Promise<string> {
  const param = { textDocument: { uri: document.uri.toString() } };
  return hooks.sendRequest(SYMBOLS, param, undefined, () => {
    wire.push(`request ${path.basename(document.fileName)}`);
    return Promise.resolve(SERVED);
  });
}

/** A didOpen the connection delivers. */
function open(hooks: Hooks, document: vscode.TextDocument, wire: string[]): Promise<void> {
  return hooks.didOpen(document, () => {
    wire.push(`didOpen ${path.basename(document.fileName)}`);
    return Promise.resolve();
  });
}

/** Whether `request` reaches the server within the probe window. */
async function outcome(request: Promise<string>): Promise<Outcome> {
  const forwarded = request.then((): Outcome => 'forwarded');
  return await Promise.race([forwarded, delay(HOLD_PROBE_MS).then((): Outcome => 'held')]);
}

/** The client leaves Running for a restart and comes back; `during` runs while it is down. */
function restart<T>(sync: OpenSync, during: () => T): T {
  sync.observe(State.Stopped);
  sync.observe(State.Starting);
  const result = during();
  sync.observe(State.Running);
  return result;
}

suite('Open sync across a restart', () => {
  let tmpDir: string;

  suiteSetup(function () {
    this.timeout(ACTIVATION_MS);
    tmpDir = fs.mkdtempSync(
      path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'sharplsp-test-open-sync-'),
    );
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    removeDirRecursive(tmpDir);
  });

  test('a didOpen the restarting client failed to send never counts as synced', async function () {
    this.timeout(ACTIVATION_MS);
    const { doc } = await openCSharpFile(tmpDir, 'failed-open.cs', 'class FailedOpen { }');
    const sync = createOpenSync(DOCUMENT_SELECTOR);
    const hooks = hooksOf(sync);
    const wire: string[] = [];
    sync.observe(State.Running);

    // A running server that has the document answers at once.
    await open(hooks, doc, wire);
    assert.equal(
      await outcome(ask(hooks, doc, wire)),
      'forwarded',
      'a synced document is not held',
    );
    assert.deepEqual(wire, ['didOpen failed-open.cs', 'request failed-open.cs']);

    // The server dies; the didOpen VS Code sends meanwhile never leaves the client.
    const lost = new Error('Client is not running');
    const rejection = restart(sync, () => hooks.didOpen(doc, () => Promise.reject(lost)));
    await assert.rejects(rejection, lost, 'the failed send still fails its caller');
    const held = ask(hooks, doc, wire);
    assert.equal(await outcome(held), 'held', 'the new server has not been sent the document');
    assert.equal(wire.length, 2, 'nothing about the document reached the new server');

    // The restarted client re-opens the document: the held request follows it.
    await open(hooks, doc, wire);
    assert.equal(await outcome(held), 'forwarded', 'the re-open releases the held request');
    assert.equal(await held, SERVED, 'the held request is answered by the server');
    assert.deepEqual(wire.slice(2), ['didOpen failed-open.cs', 'request failed-open.cs']);
    assert.equal(await outcome(ask(hooks, doc, wire)), 'forwarded', 'later requests are not held');
  });

  test('a didOpen the dead server accepted is not credited to its replacement', async function () {
    this.timeout(ACTIVATION_MS);
    const { doc } = await openCSharpFile(tmpDir, 'stale-open.cs', 'class StaleOpen { }');
    const { doc: other } = await openCSharpFile(tmpDir, 'other-open.cs', 'class OtherOpen { }');
    const sync = createOpenSync(DOCUMENT_SELECTOR);
    const hooks = hooksOf(sync);
    const wire: string[] = [];
    sync.observe(State.Running);

    // The didOpen is written to the old server, and settles only after it died.
    let settle: () => void = () => undefined;
    const inFlight = hooks.didOpen(
      doc,
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    restart(sync, () => {
      settle();
    });
    await inFlight;
    const held = ask(hooks, doc, wire);
    assert.equal(await outcome(held), 'held', 'the old server had it; the new one does not');
    assert.deepEqual(wire, [], 'nothing reached the new server ahead of the document');

    // A document the new server WAS sent is not held behind the other one.
    await open(hooks, other, wire);
    assert.equal(await outcome(ask(hooks, other, wire)), 'forwarded', 'holds are per document');
    assert.equal(await outcome(held), 'held', 'the other document stays held');

    // The restarted client re-opens it: the held request follows its didOpen.
    await open(hooks, doc, wire);
    assert.equal(await outcome(held), 'forwarded', 'the re-open releases the held request');
    assert.deepEqual(wire, [
      'didOpen other-open.cs',
      'request other-open.cs',
      'didOpen stale-open.cs',
      'request stale-open.cs',
    ]);
  });

  test('a request made after the server restarted is held only until its re-open', async function () {
    this.timeout(LSP_RESPONSE_MS);
    const { doc } = await openCSharpFile(tmpDir, 'reopen.cs', 'class Reopen { }');
    const sync = createOpenSync(DOCUMENT_SELECTOR);
    const hooks = hooksOf(sync);
    const wire: string[] = [];
    sync.observe(State.Running);
    await open(hooks, doc, wire);

    // A clean restart forgets what the old server had.
    restart(sync, () => undefined);
    const started = Date.now();
    const held = ask(hooks, doc, wire);
    assert.equal(await outcome(held), 'held', 'the fresh server has no documents yet');

    // The re-open releases it promptly, not at the hold's safety valve.
    await open(hooks, doc, wire);
    assert.equal(await held, SERVED, 'the held request is answered');
    assert.ok(Date.now() - started < LSP_RESPONSE_MS / 2, 'released by the re-open, not the valve');
    assert.deepEqual(wire, ['didOpen reopen.cs', 'didOpen reopen.cs', 'request reopen.cs']);
  });
});
