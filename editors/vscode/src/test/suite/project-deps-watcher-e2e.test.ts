// Covers VSCODE-REACTIVITY-SPEC §4 (project-dependencies watcher).
//
// Reproduces the Windows crash where deleting a tracked project's directory
// fired the node FSWatcher's async 'error' event (EPERM) with no listener
// attached, raising an uncaught exception that killed the extension host —
// and with it, entire e2e runs (suite teardowns delete fixture trees while
// watchers are live). Drives the REAL store against a REAL csproj on disk:
// the watcher, the deletion, and the signal update are all real.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
  ensureTracked,
  initProjectDepsStore,
  projectDependencies,
  resetForTests,
} from '../../project-deps-store.js';

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.4" /></ItemGroup>
</Project>
`;

async function pollUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

suite('Project-deps node watcher survives project dir deletion', () => {
  suiteSetup(() => {
    resetForTests();
    // Minimal real-shaped context: the store only pushes onto `subscriptions`.
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    initProjectDepsStore(context);
  });

  suiteTeardown(() => {
    resetForTests();
  });

  test('deleting a watched project directory neither crashes the host nor leaves it tracked', async function () {
    this.timeout(20_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-watch-'));
    const projectPath = path.join(dir, 'Deleted.csproj');
    fs.writeFileSync(projectPath, CSPROJ);

    const parsed = ensureTracked(projectPath);
    assert.strictEqual(parsed.nugetPackages.length, 1, 'tracked project parses its PackageReference');
    assert.ok(projectDependencies.value.has(projectPath), 'project is tracked after ensureTracked');

    // Delete the tree out from under the node fs.watch. On Windows this fires
    // the watcher's async 'error' (EPERM); without an 'error' listener Node
    // raises it as an uncaught exception, which mocha attributes to this test.
    fs.rmSync(dir, { recursive: true, force: true });

    const removed = await pollUntil(() => !projectDependencies.value.has(projectPath), 10_000);
    assert.ok(removed, 'deleted project must be dropped from projectDependencies');
    assert.ok(!fs.existsSync(projectPath), 'fixture tree really was deleted');
  });
});
