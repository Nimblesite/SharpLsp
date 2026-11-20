/**
 * `csharp.solution_path` settles which solution a workspace opens. The server
 * opens it before any document; the extension must show the SAME one and never
 * ask which of the workspace's solutions to load. Asking anyway let one wrong
 * pick point the Solution Explorer and the Test Explorer at a fixture solution
 * while the server had the real one open — an empty Testing view.
 * Implements [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH], [SE-SOLUTION].
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configuredSolution, findSolutions } from '../../solution.js';
import {
  activation,
  assertSameFiles,
  configurationClient,
  NO_COMPILERS as BASE,
  WorkspaceMemory,
} from './solution-loader-kit';
import { removeDirRecursive } from './test-helpers';
import { DEBUG_TEST_MS } from './test-timeouts';
import { installUiStubs, type UiStubs } from './ui-stubs';

suite('A configured solution is loaded without asking [SE-SOLUTION]', () => {
  let stubs: UiStubs;
  setup(() => {
    stubs = installUiStubs();
  });
  teardown(() => {
    stubs.restore();
  });

  test('csharp.solution_path beats the picker and a remembered pick; a stale one does neither', async function () {
    this.timeout(DEBUG_TEST_MS);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-solution-'));
    const toml = path.join(root, 'sharplsp.toml');
    const app = path.join(root, 'app', 'App.sln');
    const other = path.join(root, 'other', 'Other.slnx');
    for (const file of [app, other]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    fs.writeFileSync(toml, BASE);
    const client = configurationClient(root);
    // Every pick is dismissed, so each time a loader asks it lands here.
    const asked: unknown[] = [];
    try {
      await client.start();
      assert.ok((await findSolutions()).length >= 2, 'the premise: several solutions to ask about');

      // 1 — nothing configured: the user is asked, and dismissing loads nothing.
      const unconfigured: string[] = [];
      assert.strictEqual(await configuredSolution(client), undefined, 'no setting, no choice');
      await activation(new WorkspaceMemory(), unconfigured, client, asked).selectAndLoad();
      assert.strictEqual(asked.length, 1, 'an unconfigured workspace asks once');
      assert.deepStrictEqual(unconfigured, [], 'a dismissed pick loads nothing');

      // 2 — a relative entry resolves against the server's root; nobody is asked.
      fs.writeFileSync(toml, `${BASE}solution_path = "app/App.sln"\n`);
      const memory = new WorkspaceMemory();
      const configured: string[] = [];
      const selection = await configuredSolution(client);
      assertSameFiles([selection?.path], [app], 'the relative entry is the file under the root');
      assert.strictEqual(selection?.name, 'App.sln', 'named by its own file');
      await activation(memory, configured, client, asked).selectAndLoad();
      assert.strictEqual(asked.length, 1, 'a configured workspace never asks');
      assertSameFiles(configured, [app], 'the configured solution is the one loaded');

      // 3 — an absolute entry that moves the setting beats what step 2 remembered.
      fs.writeFileSync(toml, `${BASE}solution_path = ${JSON.stringify(other)}\n`);
      const moved: string[] = [];
      await activation(memory, moved, client, asked).selectAndLoad();
      assert.strictEqual(asked.length, 1, 'a moved setting never asks either');
      assert.deepStrictEqual(moved, [other], 'the setting wins over the remembered solution');
      assert.strictEqual((await configuredSolution(client))?.name, 'Other.slnx');

      // 4 — a stale entry is no choice: the remembered solution, else the picker.
      fs.writeFileSync(toml, `${BASE}solution_path = "gone/Gone.sln"\n`);
      const stale: string[] = [];
      assert.strictEqual(
        await configuredSolution(client),
        undefined,
        'a missing file is no choice',
      );
      await activation(memory, stale, client, asked).selectAndLoad();
      assert.deepStrictEqual(stale, [other], 'the remembered solution stands in');
      assert.strictEqual(asked.length, 1, 'and still nobody is asked');
      await activation(new WorkspaceMemory(), stale, client, asked).selectAndLoad();
      assert.strictEqual(asked.length, 2, 'with nothing remembered the user is asked again');
      assert.deepStrictEqual(stale, [other], 'and a dismissed pick loads nothing more');
    } finally {
      if (client.isRunning()) await client.stop();
      removeDirRecursive(root);
    }
  });
});
