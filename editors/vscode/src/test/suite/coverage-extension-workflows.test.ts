import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applyOptimisticInstall,
  applyOptimisticUninstall,
  buildInstallToast,
  buildUninstallToast,
  enrichPackageMetadata,
  fetchInstalledMetadata,
  findOrSynthesizePackage,
  revertOptimisticInstall,
  revertOptimisticUninstall,
} from '../../nuget-browser/mutate.js';
import {
  fetchInstalled,
  fetchTargets,
  fetchVersions,
  installPackage,
  searchPackages,
  uninstallPackage,
} from '../../nuget-browser/lsp.js';
import { type NuGetSearchResult, type NuGetTarget } from '../../nuget-browser/types.js';
import { Signal, effect } from '../../signals.js';
import { findSolutions, selectSolution, toSolutionSelections } from '../../solution.js';
import { isHotReloadRunning } from '../../hot-reload.js';

suite('Extension Workflow Coverage', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-workflow-'));
  });

  teardown(async () => {
    if (isHotReloadRunning()) {
      await vscode.commands.executeCommand('sharplsp.hotReload.stop');
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('generates an F# signature file through the registered command', async function () {
    this.timeout(20_000);
    const fsPath = path.join(tmpDir, 'Workflow.fs');
    fs.writeFileSync(
      fsPath,
      [
        'namespace Workflow',
        '',
        'type Greeter =',
        '    member _.Name = "SharpLsp"',
        '',
        'let publicValue = 42',
        'let private hidden = 13',
      ].join('\n'),
      'utf8',
    );

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('sharplsp.fsi.generateSignature');

    const signaturePath = path.join(tmpDir, 'Workflow.fsi');
    assert.ok(fs.existsSync(signaturePath), 'generateSignature must create a .fsi file');
    const signature = fs.readFileSync(signaturePath, 'utf8');
    assert.ok(signature.includes('namespace Workflow'));
    assert.ok(signature.includes('type Greeter'));
    assert.ok(signature.includes('val publicValue :'));
    assert.ok(!signature.includes('hidden'));
  });

  test('starts, rejects duplicate start, toggles, and stops hot reload', async function () {
    this.timeout(20_000);
    assert.strictEqual(isHotReloadRunning(), false);

    await vscode.commands.executeCommand('sharplsp.hotReload.start');
    assert.strictEqual(isHotReloadRunning(), true);

    await vscode.commands.executeCommand('sharplsp.hotReload.start');
    assert.strictEqual(isHotReloadRunning(), true);

    await vscode.commands.executeCommand('sharplsp.hotReload.toggle');
    assert.strictEqual(isHotReloadRunning(), false);

    await vscode.commands.executeCommand('sharplsp.hotReload.toggle');
    assert.strictEqual(isHotReloadRunning(), true);

    await vscode.commands.executeCommand('sharplsp.hotReload.stop');
    assert.strictEqual(isHotReloadRunning(), false);

    await vscode.commands.executeCommand('sharplsp.hotReload.stop');
    assert.strictEqual(isHotReloadRunning(), false);
  });

  test('discovers and sorts real solution selections', async function () {
    this.timeout(10_000);
    const selections = toSolutionSelections([
      path.join(tmpDir, 'Zeta.slnx'),
      path.join(tmpDir, 'Alpha.sln'),
      path.join(tmpDir, 'Alpha.slnx'),
    ]);

    assert.deepStrictEqual(
      selections.map((selection) => selection.name),
      ['Alpha.sln', 'Alpha.slnx', 'Zeta.slnx'],
    );

    const workspaceSolutions = await findSolutions();
    assert.ok(workspaceSolutions.some((selection) => selection.name.endsWith('.sln')));
    const selected = await selectSolution();
    assert.ok(
      selected === undefined || selected.name.endsWith('.sln') || selected.name.endsWith('.slnx'),
    );
  });

  test('reactive signals rerun effects, retrack dependencies, notify, and dispose', () => {
    const primary = new Signal(1);
    const secondary = new Signal(10);
    const useSecondary = new Signal(false);
    const observed: number[] = [];

    const dispose = effect(() => {
      observed.push(useSecondary.value ? secondary.value : primary.value);
    });

    primary.value = 2;
    useSecondary.value = true;
    primary.value = 3;
    secondary.value = 11;
    secondary.notify();
    dispose();
    secondary.value = 12;

    assert.deepStrictEqual(observed, [1, 2, 10, 11, 11]);
  });

  test('NuGet optimistic mutations update and revert installed package state', () => {
    const target = nugetTarget();
    const installed = new Map<string, string>([['Existing.Package', '1.0.0']]);
    const searchResults: NuGetSearchResult[] = [
      nugetPackage('Existing.Package', '1.0.0'),
      nugetPackage('New.Package', '2.0.0'),
    ];

    const installSnapshot = applyOptimisticInstall(
      installed,
      searchResults,
      'New.Package',
      '2.0.0',
    );
    assert.strictEqual(installed.get('New.Package'), '2.0.0');
    assert.strictEqual(searchResults[1]?.isInstalled, true);
    assert.strictEqual(
      buildInstallToast(target, 'New.Package', '2.0.0'),
      'Installing New.Package 2.0.0 into Test Project...',
    );

    revertOptimisticInstall(installed, 'New.Package', installSnapshot);
    assert.strictEqual(installed.has('New.Package'), false);
    assert.strictEqual(searchResults[1]?.isInstalled, false);

    const uninstallSnapshot = applyOptimisticUninstall(
      installed,
      searchResults,
      'Existing.Package',
    );
    assert.strictEqual(installed.has('Existing.Package'), false);
    assert.strictEqual(searchResults[0]?.isInstalled, false);
    assert.strictEqual(
      buildUninstallToast(target, 'Existing.Package'),
      'Removing Existing.Package from Test Project...',
    );

    revertOptimisticUninstall(installed, 'Existing.Package', uninstallSnapshot);
    assert.strictEqual(installed.get('Existing.Package'), '1.0.0');
    assert.strictEqual(searchResults[0]?.installedVersion, '1.0.0');

    assert.strictEqual(
      findOrSynthesizePackage(searchResults, installed, 'Existing.Package')?.id,
      'Existing.Package',
    );
    assert.strictEqual(
      findOrSynthesizePackage([], installed, 'Existing.Package')?.isInstalled,
      true,
    );
    assert.strictEqual(findOrSynthesizePackage([], installed, 'Missing.Package'), undefined);
  });

  test('NuGet LSP wrappers return results and errors without throwing', async () => {
    const target = nugetTarget();
    const successful = fakeLspClient(async (method) => ({
      method,
      packages: [nugetPackage('Newtonsoft.Json', '13.0.3')],
    }));
    const failing = fakeLspClient(async () => {
      throw new Error('sidecar unavailable');
    });

    assert.strictEqual((await fetchTargets(successful, tmpDir)).ok, true);
    assert.strictEqual((await fetchInstalled(successful, target)).ok, true);
    assert.strictEqual((await searchPackages(successful, target, 'json', 1)).ok, true);
    assert.strictEqual((await fetchVersions(successful, 'Newtonsoft.Json')).ok, true);
    assert.strictEqual(
      (await installPackage(successful, target, 'Newtonsoft.Json', '13.0.3')).ok,
      true,
    );
    assert.strictEqual((await uninstallPackage(successful, target, 'Newtonsoft.Json')).ok, true);

    const failed = await searchPackages(failing, target, 'json');
    assert.strictEqual(failed.ok, false);
    assert.ok(!failed.ok && failed.error.includes('sidecar unavailable'));
  });

  test('NuGet metadata enrichment mutates installed package details in place', async () => {
    const target = nugetTarget();
    const pkg = nugetPackage('Newtonsoft.Json', '12.0.1');
    const lsp = fakeLspClient(async () => ({
      packages: [
        {
          ...nugetPackage('Newtonsoft.Json', '13.0.3'),
          description: 'Json.NET',
          authors: 'Newtonsoft',
          iconUrl: 'https://example.test/icon.png',
          downloadCount: 1000,
        },
      ],
    }));

    await enrichPackageMetadata(lsp, target, pkg);
    assert.strictEqual(pkg.version, '13.0.3');
    assert.strictEqual(pkg.description, 'Json.NET');
    assert.strictEqual(pkg.authors, 'Newtonsoft');

    const installed = await fetchInstalledMetadata(lsp, target, [
      'Newtonsoft.Json',
      'Other.Package',
    ]);
    assert.strictEqual(installed.get('Newtonsoft.Json')?.version, '13.0.3');
    assert.strictEqual(installed.has('Other.Package'), false);
  });
});

function nugetTarget(): NuGetTarget {
  return {
    id: 'test-project',
    displayName: 'Test Project',
    path: '/tmp/TestProject.csproj',
    kind: 'project',
  };
}

function nugetPackage(id: string, version: string): NuGetSearchResult {
  return {
    id,
    version,
    description: 'Package description',
    authors: 'Package authors',
    tags: ['test'],
    isInstalled: false,
    installedVersion: undefined,
  };
}

function fakeLspClient(sendRequest: (method: string, payload: unknown) => Promise<unknown>): never {
  return {
    sendRequest,
  } as never;
}
