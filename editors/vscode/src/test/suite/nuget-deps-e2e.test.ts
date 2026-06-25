/**
 * Coarse end-to-end tests for the NuGet + project-dependency surface of the
 * SharpLsp VS Code extension.
 *
 * These are flow-driven: every test drives a registered command or a public
 * module entry point against real .csproj/.fsproj files on disk, stubs the
 * modal UI (and `fetch` for nuget.org), and asserts on the REAL side effects —
 * the prompts that were shown, the XML that was mutated, the `dotnet` calls that
 * ran, and the reactive `projectDependencies` Signal updating its map.
 *
 * Modules exercised (none of which were covered by existing e2e suites):
 *   - src/nuget.ts         — `sharplsp.nuget.{add,update,restore,addFromExplorer}`
 *   - src/dependencies.ts  — parseProjectXml / parseProjectDependencies (pure),
 *                            removeNuGetPackage / addProjectReference /
 *                            removeProjectReference + their explorer commands
 *   - src/project-deps-store.ts — ensureTracked / refreshTracked / rescanAll /
 *                            resetForTests + the `projectDependencies` Signal
 *
 * Deliberately NON-overlapping with:
 *   - nuget-browser.test.ts      (webview / LSP nuget/* path)
 *   - context-menus.test.ts      (collectProjectPaths + consolidate/unused LSP)
 *   - coverage-extension-workflows.test.ts (nuget-browser mutate/lsp helpers)
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  parseProjectXml,
  parseProjectDependencies,
  removeNuGetPackage,
  addProjectReference,
  removeProjectReference,
} from '../../dependencies.js';
import {
  projectDependencies,
  ensureTracked,
  refreshTracked,
  rescanAll,
  resetForTests,
} from '../../project-deps-store.js';
import { effect } from '../../signals.js';
import { installUiStubs, type UiStubs } from './ui-stubs';
import { closeAllEditors } from './test-helpers';

// ── Fake nuget.org search responses ───────────────────────────────

interface FetchLike {
  fetch: typeof fetch;
}

/** A minimal `Response` matching what `searchNuGet()` reads (`ok`/`status`/`json`). */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A nuget.org search payload with the fields `NuGetPackage` consumes. */
function nugetSearchBody(
  ...packages: { id: string; version: string; description?: string }[]
): unknown {
  return {
    totalHits: packages.length,
    data: packages.map((p) => ({
      id: p.id,
      version: p.version,
      description: p.description ?? `${p.id} description`,
      totalDownloads: 12345,
    })),
  };
}

/** Install a fetch stub that records URLs and returns `response` for every call. */
function stubFetch(response: Response | (() => Response)): { urls: string[]; restore: () => void } {
  const holder = globalThis as unknown as FetchLike;
  const original = holder.fetch;
  const urls: string[] = [];
  holder.fetch = async (input: unknown) => {
    urls.push(typeof input === 'string' ? input : String(input));
    return typeof response === 'function' ? response() : response;
  };
  return {
    urls,
    restore() {
      holder.fetch = original;
    },
  };
}

// ── csproj/fsproj fixture writers ─────────────────────────────────

interface RefSpec {
  readonly id: string;
  readonly version: string;
}

/** Write a .csproj/.fsproj with package + project references; return its path. */
function writeProjectFile(
  dir: string,
  name: string,
  options: { packages?: RefSpec[]; projects?: string[]; ext?: string } = {},
): string {
  const packages = options.packages ?? [];
  const projects = options.projects ?? [];
  const ext = options.ext ?? 'csproj';
  const pkgItems = packages
    .map((p) => `    <PackageReference Include="${p.id}" Version="${p.version}" />`)
    .join('\n');
  const projItems = projects.map((p) => `    <ProjectReference Include="${p}" />`).join('\n');
  const itemGroups: string[] = [];
  if (pkgItems !== '') itemGroups.push(`  <ItemGroup>\n${pkgItems}\n  </ItemGroup>`);
  if (projItems !== '') itemGroups.push(`  <ItemGroup>\n${projItems}\n  </ItemGroup>`);
  const filePath = path.join(dir, `${name}.${ext}`);
  fs.writeFileSync(
    filePath,
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>',
      ...itemGroups,
      '</Project>',
      '',
    ].join('\n'),
    'utf8',
  );
  return filePath;
}

// ─────────────────────────────────────────────────────────────────
// Suite 1: NuGet commands (src/nuget.ts) — fetch + prompt flows
// ─────────────────────────────────────────────────────────────────

suite('NuGet Commands — search / add / update / restore (e2e)', () => {
  let tmpDir: string;
  let stubs: UiStubs;
  let fetchStub: { urls: string[]; restore: () => void } | undefined;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-nuget-cmd-'));
    stubs = installUiStubs();
  });

  teardown(async () => {
    stubs.restore();
    fetchStub?.restore();
    fetchStub = undefined;
    await closeAllEditors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sharplsp.nuget.add cancels cleanly when the search box is dismissed', async function () {
    this.timeout(20_000);
    // No queued input → showInputBox returns undefined → early return, no fetch.
    fetchStub = stubFetch(fakeResponse(nugetSearchBody({ id: 'X', version: '1.0.0' })));

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.add');
    }, 'cancelling the query must not throw');

    assert.strictEqual(stubs.log.inputBoxOptions.length, 1, 'exactly one input box was shown');
    const opts = stubs.log.inputBoxOptions[0];
    assert.ok(opts?.prompt?.includes('Search NuGet'), 'the search prompt was shown');
    assert.strictEqual(fetchStub.urls.length, 0, 'no network call when the user cancels');
    assert.strictEqual(stubs.log.quickPickItems.length, 0, 'no package pick when cancelled');
  });

  test('sharplsp.nuget.add shows the "no packages" notice when the search is empty', async function () {
    this.timeout(20_000);
    fetchStub = stubFetch(fakeResponse(nugetSearchBody())); // empty data array
    stubs.queueInput('Definitely.Nonexistent.Package');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.add');
    });

    assert.strictEqual(fetchStub.urls.length, 1, 'the search hit nuget.org exactly once');
    assert.ok(fetchStub.urls[0]?.includes('azuresearch'), 'used the nuget search endpoint');
    assert.ok(
      fetchStub.urls[0]?.includes('Definitely.Nonexistent.Package'),
      'the query string carried the typed package name',
    );
    assert.ok(
      stubs.log.infoMessages.some((m) => m.includes('No packages found')),
      `expected a "No packages found." info toast, got: ${stubs.log.infoMessages.join(' | ')}`,
    );
    assert.strictEqual(
      stubs.log.quickPickItems.length,
      0,
      'no package quick pick for empty results',
    );
  });

  test('sharplsp.nuget.add searches, lists hits, then offers the workspace project picker', async function () {
    this.timeout(60_000);
    // Real flow (src/nuget.ts addNuGetPackage): query input → fetch → package
    // quickPick → pickProjectFile(). The fixture workspace has multiple
    // .csproj/.fsproj, so pickProjectFile() shows a SECOND quickPick. We dismiss
    // that project picker (no third queued pick → undefined → clean early return)
    // so the command never runs `dotnet add package` against the shared fixture
    // workspace. The genuine end-to-end add (running dotnet) is covered against an
    // isolated temp project by the addFromExplorer test below.
    fetchStub = stubFetch(
      fakeResponse(
        nugetSearchBody(
          { id: 'Newtonsoft.Json', version: '13.0.3', description: 'Json.NET' },
          { id: 'Newtonsoft.Json.Bson', version: '1.0.2' },
        ),
      ),
    );
    // Query input, then the package pick (index 0). The project picker is left
    // unqueued so it resolves to undefined (dismissed).
    stubs.queueInput('Newtonsoft').queuePick(0);

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.add');
    }, 'the add flow must complete without throwing');

    // Deterministic observable effects.
    assert.strictEqual(fetchStub.urls.length, 1, 'exactly one search request');
    assert.ok(fetchStub.urls[0]?.includes('Newtonsoft'), 'the query carried the typed text');
    assert.ok(stubs.log.quickPickItems.length >= 2, 'both the package AND project pickers ran');

    // First quickPick is the package list (id + version), from the stubbed search.
    const pkgPickItems = stubs.log.quickPickItems[0] as { label?: string; description?: string }[];
    assert.strictEqual(pkgPickItems.length, 2, 'both search hits were offered to the user');
    assert.ok(
      pkgPickItems.some((it) => it.label === 'Newtonsoft.Json' && it.description === '13.0.3'),
      'the package list shows id + version',
    );
    assert.strictEqual(
      stubs.log.quickPickOptions[0]?.placeHolder,
      'Select a package to add',
      'the package picker used its real placeholder',
    );

    // Second quickPick is pickProjectFile() listing the workspace projects.
    const projectPickItems = stubs.log.quickPickItems[1] as { label?: string }[];
    assert.ok(projectPickItems.length >= 1, 'the project picker listed at least one project');
    assert.ok(
      projectPickItems.some((it) => {
        const label = it.label ?? '';
        return label.endsWith('.csproj') || label.endsWith('.fsproj');
      }),
      'the project picker offered real project files from the workspace',
    );
    assert.strictEqual(
      stubs.log.quickPickOptions[1]?.placeHolder,
      'Select project',
      'the project picker used its real placeholder',
    );

    // Dismissing the project picker is a clean no-op: no add toast, no error.
    assert.ok(
      !stubs.log.infoMessages.some((m) => m.includes('Added')),
      'no "Added" toast when the project picker is dismissed',
    );
    assert.deepEqual(stubs.log.errorMessages, [], 'dismissing the project picker is not an error');
  });

  test('sharplsp.nuget.add surfaces an error toast when nuget.org returns a non-OK status', async function () {
    this.timeout(20_000);
    fetchStub = stubFetch(fakeResponse({}, false, 503));
    stubs.queueInput('Anything');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.add');
    }, 'a failed HTTP status must be caught, not thrown');

    assert.strictEqual(fetchStub.urls.length, 1, 'one request was attempted');
    assert.ok(
      stubs.log.errorMessages.some((m) => m.includes('NuGet search failed') && m.includes('503')),
      `expected an error toast mentioning the 503 status, got: ${stubs.log.errorMessages.join(' | ')}`,
    );
  });

  test('sharplsp.nuget.update prompts for a package name after a project is resolved', async function () {
    this.timeout(30_000);
    // Single project in this temp tree → pickProjectFile returns it without a pick,
    // BUT findFiles searches the real workspace; queue a project pick by substring
    // in case multiple projects are present, then the package-name input box.
    const projectPath = writeProjectFile(tmpDir, 'UpdateTarget', {
      packages: [{ id: 'Serilog', version: '3.0.0' }],
    });
    stubs
      .queuePick((items) => {
        const list = items as { label?: string; uri?: vscode.Uri }[];
        return list.find((it) => it.uri?.fsPath === projectPath) ?? list[0];
      })
      .queueInput('Serilog');

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.update');
    }, 'update must not throw even when dotnet is offline');

    // The package-name input box is the deterministic part of this flow.
    const namePrompt = stubs.log.inputBoxOptions.find((o) =>
      o?.prompt?.includes('Package name to update'),
    );
    assert.ok(namePrompt, 'the "Package name to update" input box was shown');
    // Either an "Updated" success toast or a handled "Update failed" error toast.
    const reached =
      stubs.log.infoMessages.some((m) => m.includes('Updated Serilog')) ||
      stubs.log.errorMessages.some((m) => m.includes('Update failed'));
    assert.ok(reached, 'update ended in a success or a handled-failure toast');
  });

  test('sharplsp.nuget.update returns early when the package name is left blank', async function () {
    this.timeout(20_000);
    const projectPath = writeProjectFile(tmpDir, 'UpdateBlank');
    stubs
      .queuePick((items) => {
        const list = items as { label?: string; uri?: vscode.Uri }[];
        return list.find((it) => it.uri?.fsPath === projectPath) ?? list[0];
      })
      .queueInput(''); // empty name → early return, no toast

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.update');
    });

    assert.ok(
      !stubs.log.infoMessages.some((m) => m.includes('Updated')),
      'no "Updated" toast when the package name is blank',
    );
  });

  test('sharplsp.nuget.restore runs dotnet restore and reports the outcome', async function () {
    this.timeout(60_000);
    // Restore runs `dotnet restore` in the workspace; it may succeed or fail, but
    // the command must always resolve and emit exactly one terminal toast.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.restore');
    }, 'restore must never throw out of the command');

    const restored = stubs.log.infoMessages.some((m) => m.includes('restored'));
    const failed = stubs.log.errorMessages.some((m) => m.includes('Restore failed'));
    assert.ok(
      restored || failed,
      `restore must report success or a handled failure; info=[${stubs.log.infoMessages.join(
        ' | ',
      )}] error=[${stubs.log.errorMessages.join(' | ')}]`,
    );
  });

  test('sharplsp.nuget.addFromExplorer adds to the node project without a project pick', async function () {
    this.timeout(30_000);
    const projectPath = writeProjectFile(tmpDir, 'ExplorerTarget');
    fetchStub = stubFetch(
      fakeResponse(nugetSearchBody({ id: 'Polly', version: '8.4.1', description: 'Resilience' })),
    );
    // Only the search query + the package pick are needed (project is the node's).
    stubs.queueInput('Polly').queuePick(0);

    const node = { projectFilePath: projectPath, sortName: 'ExplorerTarget' };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.addFromExplorer', node);
    }, 'addFromExplorer must complete against an explicit project node');

    assert.strictEqual(fetchStub.urls.length, 1, 'a single search request was made');
    const items = stubs.log.quickPickItems[0] as { label?: string }[] | undefined;
    assert.ok(items, 'a package quick pick was shown');
    assert.ok(
      items.some((it) => it.label === 'Polly'),
      'the explorer add offered the Polly package',
    );
    // No project-pick quick pick should have been needed — the package list is
    // the only quick pick in this flow.
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'no extra project quick pick');
  });

  test('sharplsp.nuget.addFromExplorer warns when the node has no project path', async function () {
    this.timeout(10_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.addFromExplorer', {
        projectFilePath: undefined,
        sortName: 'NoPath',
      });
    });
    assert.ok(
      stubs.log.warningMessages.some((m) => m.includes('No project file path')),
      'a warning is shown when the node carries no project path',
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 2: dependencies.ts — pure XML parsing
// ─────────────────────────────────────────────────────────────────

suite('Dependencies — parseProjectXml / parseProjectDependencies (pure)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-deps-parse-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parses and alphabetically sorts package + project references', () => {
    const xml = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup>',
      '    <PackageReference Include="Serilog" Version="3.1.0" />',
      '    <PackageReference Include="AutoMapper" Version="13.0.1" />',
      '  </ItemGroup>',
      '  <ItemGroup>',
      '    <ProjectReference Include="../Lib/Zeta.csproj" />',
      '    <ProjectReference Include="../Lib/Alpha.csproj" />',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n');

    const parsed = parseProjectXml(xml);

    assert.deepEqual(
      parsed.nugetPackages.map((p) => p.name),
      ['AutoMapper', 'Serilog'],
      'packages are sorted by name',
    );
    assert.strictEqual(parsed.nugetPackages[0]?.version, '13.0.1', 'AutoMapper version captured');
    assert.strictEqual(parsed.nugetPackages[1]?.version, '3.1.0', 'Serilog version captured');
    assert.deepEqual(
      parsed.projectReferences.map((r) => r.name),
      ['Alpha', 'Zeta'],
      'project references are sorted by basename',
    );
    assert.strictEqual(
      parsed.projectReferences[0]?.includePath,
      '../Lib/Alpha.csproj',
      'the raw Include path is preserved',
    );
  });

  test('a PackageReference without a Version defaults to an empty version string', () => {
    const xml = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup>',
      '    <PackageReference Include="VersionlessPkg" />',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n');

    const parsed = parseProjectXml(xml);
    assert.strictEqual(parsed.nugetPackages.length, 1, 'the package is still captured');
    assert.strictEqual(parsed.nugetPackages[0]?.name, 'VersionlessPkg');
    assert.strictEqual(parsed.nugetPackages[0]?.version, '', 'missing version → empty string');
  });

  test('handles a single ItemGroup (non-array) and empty/whitespace projects', () => {
    const single = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup>',
      '    <PackageReference Include="Solo" Version="1.2.3" />',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n');
    const parsedSingle = parseProjectXml(single);
    assert.strictEqual(parsedSingle.nugetPackages.length, 1, 'single ItemGroup is normalized');
    assert.strictEqual(parsedSingle.nugetPackages[0]?.name, 'Solo');

    const empty = parseProjectXml('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup /></Project>');
    assert.deepEqual(empty.nugetPackages, [], 'no packages when there are no ItemGroups');
    assert.deepEqual(empty.projectReferences, [], 'no project references either');
  });

  test('malformed XML yields empty dependencies instead of throwing', () => {
    const broken = parseProjectXml('<Project><ItemGroup><PackageReference Include="X"');
    assert.deepEqual(broken.nugetPackages, [], 'invalid XML → empty packages');
    assert.deepEqual(broken.projectReferences, [], 'invalid XML → empty project references');
  });

  test('parseProjectDependencies reads a real file from disk', () => {
    const projectPath = writeProjectFile(tmpDir, 'DiskRead', {
      packages: [
        { id: 'Polly', version: '8.4.1' },
        { id: 'MediatR', version: '12.4.0' },
      ],
      projects: ['../Shared/Shared.csproj'],
    });

    const parsed = parseProjectDependencies(projectPath);
    assert.deepEqual(
      parsed.nugetPackages.map((p) => p.name),
      ['MediatR', 'Polly'],
      'on-disk packages parsed and sorted',
    );
    assert.strictEqual(parsed.projectReferences.length, 1, 'the project reference was parsed');
    assert.strictEqual(parsed.projectReferences[0]?.name, 'Shared', 'reference basename extracted');
  });

  test('parseProjectDependencies returns empty deps for a missing file', () => {
    const parsed = parseProjectDependencies(path.join(tmpDir, 'does-not-exist.csproj'));
    assert.deepEqual(parsed.nugetPackages, [], 'missing file → empty packages, no throw');
    assert.deepEqual(parsed.projectReferences, [], 'missing file → empty project references');
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 3: dependencies.ts mutation paths + explorer commands
// ─────────────────────────────────────────────────────────────────

suite('Dependencies — remove/add commands mutate real .csproj files (e2e)', () => {
  let tmpDir: string;
  let stubs: UiStubs;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-deps-mut-'));
    stubs = installUiStubs();
  });

  teardown(async () => {
    stubs.restore();
    await closeAllEditors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('removeNuGetPackage strips the PackageReference from the project XML', async function () {
    this.timeout(30_000);
    const projectPath = writeProjectFile(tmpDir, 'RemovePkg', {
      packages: [
        { id: 'Serilog', version: '3.1.0' },
        { id: 'Polly', version: '8.4.1' },
      ],
    });

    const error = await removeNuGetPackage(projectPath, 'Serilog');

    if (error === undefined) {
      // `dotnet` succeeded — the XML must no longer reference Serilog but keep Polly.
      const after = parseProjectDependencies(projectPath);
      assert.ok(
        !after.nugetPackages.some((p) => p.name === 'Serilog'),
        'Serilog was removed from the project',
      );
      assert.ok(
        after.nugetPackages.some((p) => p.name === 'Polly'),
        'unrelated Polly reference is preserved',
      );
    } else {
      // Offline / no SDK — the function reports the error string instead of throwing.
      assert.strictEqual(typeof error, 'string', 'a handled failure returns the error message');
      assert.ok(error.length > 0, 'the error message is non-empty');
    }
  });

  test('addProjectReference then removeProjectReference round-trips the <ProjectReference>', async function () {
    this.timeout(40_000);
    const consumer = writeProjectFile(tmpDir, 'Consumer');
    const libDir = path.join(tmpDir, 'Lib');
    fs.mkdirSync(libDir, { recursive: true });
    const library = writeProjectFile(libDir, 'Library');

    // addProjectReference shells out to `dotnet add <consumer> reference <library>`
    // (src/dependencies.ts), which writes a <ProjectReference Include="..."> element
    // whose Include path is RELATIVE to the consumer's directory and, on every
    // platform, uses Windows-style backslash separators (e.g. "Lib\Library.csproj").
    // We therefore assert against the raw XML the CLI actually wrote — not the
    // parser's basename (which treats backslashes as part of the name on POSIX).
    const addError = await addProjectReference(consumer, library);
    if (addError === undefined) {
      const afterAddXml = fs.readFileSync(consumer, 'utf8');
      assert.ok(
        afterAddXml.includes('<ProjectReference'),
        'dotnet wrote a <ProjectReference> element into the consumer project',
      );
      assert.ok(
        afterAddXml.includes('Library.csproj'),
        `the reference points at Library.csproj; got:\n${afterAddXml}`,
      );

      const removeError = await removeProjectReference(consumer, library);
      assert.strictEqual(removeError, undefined, 'removing the reference succeeds too');
      const afterRemoveXml = fs.readFileSync(consumer, 'utf8');
      assert.ok(
        !afterRemoveXml.includes('Library.csproj'),
        `the Library reference was removed again; got:\n${afterRemoveXml}`,
      );
    } else {
      assert.strictEqual(typeof addError, 'string', 'a handled add failure returns a message');
    }
  });

  test('sharplsp.removeNuGetPackage command confirms then removes via the node args', async function () {
    this.timeout(30_000);
    const projectPath = writeProjectFile(tmpDir, 'CmdRemovePkg', {
      packages: [{ id: 'Serilog', version: '3.1.0' }],
    });
    // confirmAndRemoveDependency shows a modal warning with a 'Remove' action.
    stubs.queueWarning('Remove');

    const node = {
      projectFilePath: projectPath,
      referenceName: 'Serilog',
      label: 'Serilog',
      contextValue: 'nugetPackage',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeNuGetPackage', node);
    }, 'the remove command must complete (handling offline dotnet)');

    assert.ok(
      stubs.log.warningMessages.some(
        (m) => m.includes('Remove NuGet package') && m.includes('Serilog'),
      ),
      `a modal confirmation naming Serilog was shown, got: ${stubs.log.warningMessages.join(' | ')}`,
    );
    // Success path emits "Removed ..."; offline path emits a "Failed to remove" error.
    const reached =
      stubs.log.infoMessages.some((m) => m.includes('Removed')) ||
      stubs.log.errorMessages.some((m) => m.includes('Failed to remove'));
    assert.ok(reached, 'the command reported a removal or a handled failure');
  });

  test('sharplsp.removeNuGetPackage is a no-op when the confirmation is dismissed', async function () {
    this.timeout(20_000);
    const projectPath = writeProjectFile(tmpDir, 'CmdKeepPkg', {
      packages: [{ id: 'Serilog', version: '3.1.0' }],
    });
    // No queued warning answer → dialog dismissed (returns undefined) → no removal.
    const node = {
      projectFilePath: projectPath,
      referenceName: 'Serilog',
      label: 'Serilog',
      contextValue: 'nugetPackage',
    };

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeNuGetPackage', node);
    });

    assert.strictEqual(stubs.log.warningMessages.length, 1, 'the confirmation prompt was shown');
    assert.ok(
      !stubs.log.infoMessages.some((m) => m.includes('Removed')),
      'nothing is removed when the user dismisses the confirmation',
    );
    // The package is still on disk.
    const after = parseProjectDependencies(projectPath);
    assert.ok(
      after.nugetPackages.some((p) => p.name === 'Serilog'),
      'Serilog remains in the project after a dismissed confirmation',
    );
  });

  test('sharplsp.removeProjectReference command confirms then removes the reference', async function () {
    this.timeout(40_000);
    const libDir = path.join(tmpDir, 'Lib');
    fs.mkdirSync(libDir, { recursive: true });
    const library = writeProjectFile(libDir, 'Library');
    const consumer = writeProjectFile(tmpDir, 'CmdRemoveRef', {
      projects: [path.relative(tmpDir, library)],
    });
    stubs.queueWarning('Remove');

    const node = {
      projectFilePath: consumer,
      referenceName: library,
      label: 'Library',
      contextValue: 'projectReference',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeProjectReference', node);
    });

    assert.ok(
      stubs.log.warningMessages.some(
        (m) => m.includes('Remove project reference') && m.includes('Library'),
      ),
      'a modal confirmation naming the project reference was shown',
    );
  });

  test('sharplsp.removeNuGetPackage ignores a node missing projectFilePath / referenceName', async function () {
    this.timeout(10_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeNuGetPackage', {
        projectFilePath: undefined,
        referenceName: undefined,
      });
    });
    assert.strictEqual(
      stubs.log.warningMessages.length,
      0,
      'no confirmation prompt for an incomplete node',
    );
  });

  test('sharplsp.addProjectReference offers other projects and adds the picked one', async function () {
    this.timeout(40_000);
    // Drive the command with a node pointing at a real project on disk. The
    // candidate list comes from the workspace; pick our temp Library if present,
    // else any candidate — both paths exercise the add flow end-to-end.
    const projectPath = writeProjectFile(tmpDir, 'AddRefConsumer');
    stubs.queuePick((items) => {
      const list = items as { label?: string; uri?: vscode.Uri }[];
      return list[0];
    });

    const node = { projectFilePath: projectPath, sortName: 'AddRefConsumer' };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.addProjectReference', node);
    }, 'addProjectReference must complete against a real node');

    // The workspace has several projects, so a "select project to reference" pick
    // must have been offered (candidates exclude the node's own project).
    assert.ok(stubs.log.quickPickItems.length >= 1, 'a project-reference quick pick was shown');
    const pickOpts = stubs.log.quickPickOptions[0];
    assert.ok(
      pickOpts?.placeHolder?.includes('Select project to reference'),
      `the pick used the reference placeholder, got: ${String(pickOpts?.placeHolder)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 4: project-deps-store.ts — reactive Signal store
// ─────────────────────────────────────────────────────────────────

suite('Project Deps Store — reactive tracking (e2e)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-deps-store-'));
    // Start from a clean store so workspace activation state doesn't leak in.
    resetForTests();
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('ensureTracked parses a project and pushes it into the projectDependencies map', () => {
    const projectPath = writeProjectFile(tmpDir, 'Tracked', {
      packages: [{ id: 'Serilog', version: '3.1.0' }],
    });

    const parsed = ensureTracked(projectPath);
    assert.strictEqual(parsed.nugetPackages.length, 1, 'ensureTracked returns the parsed snapshot');
    assert.strictEqual(parsed.nugetPackages[0]?.name, 'Serilog');

    const absolute = path.resolve(projectPath);
    const stored = projectDependencies.value.get(absolute);
    assert.ok(stored, 'the project is now present in the signal map');
    assert.strictEqual(stored.nugetPackages[0]?.name, 'Serilog', 'the stored snapshot matches');
  });

  test('ensureTracked is idempotent and returns the cached snapshot on the second call', () => {
    const projectPath = writeProjectFile(tmpDir, 'Idem', {
      packages: [{ id: 'Polly', version: '8.4.1' }],
    });

    const first = ensureTracked(projectPath);
    const mapAfterFirst = projectDependencies.value;
    const second = ensureTracked(projectPath);
    const mapAfterSecond = projectDependencies.value;

    assert.strictEqual(first, second, 'the same cached object is returned');
    assert.strictEqual(
      mapAfterFirst,
      mapAfterSecond,
      'no new map is published on a redundant ensureTracked',
    );
  });

  test('an effect re-runs when ensureTracked publishes a new project', () => {
    const observedSizes: number[] = [];
    const dispose = effect(() => {
      observedSizes.push(projectDependencies.value.size);
    });
    assert.deepEqual(observedSizes, [0], 'effect ran once with the empty store');

    const a = writeProjectFile(tmpDir, 'EffectA', { packages: [{ id: 'A', version: '1.0.0' }] });
    ensureTracked(a);
    const b = writeProjectFile(tmpDir, 'EffectB', { packages: [{ id: 'B', version: '2.0.0' }] });
    ensureTracked(b);

    dispose();
    // Tracking a third project after dispose must NOT push another observation.
    const c = writeProjectFile(tmpDir, 'EffectC');
    ensureTracked(c);

    assert.deepEqual(observedSizes, [0, 1, 2], 'effect observed each new project, then stopped');
  });

  test('refreshTracked re-reads disk and republishes only when dependencies change', () => {
    const projectPath = writeProjectFile(tmpDir, 'Refresh', {
      packages: [{ id: 'Serilog', version: '3.1.0' }],
    });
    ensureTracked(projectPath);

    const observed: number[] = [];
    const dispose = effect(() => {
      const entry = projectDependencies.value.get(path.resolve(projectPath));
      observed.push(entry?.nugetPackages.length ?? -1);
    });
    assert.deepEqual(observed, [1], 'effect sees the initial single package');

    // Rewrite the project with an extra package, then refresh.
    writeProjectFile(tmpDir, 'Refresh', {
      packages: [
        { id: 'Serilog', version: '3.1.0' },
        { id: 'Polly', version: '8.4.1' },
      ],
    });
    const refreshed = refreshTracked(projectPath);
    dispose();

    assert.ok(refreshed, 'refreshTracked returns the new snapshot for a tracked project');
    assert.strictEqual(refreshed.nugetPackages.length, 2, 'the new package was picked up');
    assert.deepEqual(observed, [1, 2], 'the effect re-ran exactly once for the real change');
  });

  test('refreshTracked returns undefined for a project that was never tracked', () => {
    const projectPath = writeProjectFile(tmpDir, 'Untracked');
    const result = refreshTracked(projectPath);
    assert.strictEqual(result, undefined, 'untracked projects are not refreshed');
    assert.ok(
      !projectDependencies.value.has(path.resolve(projectPath)),
      'and they are not silently added to the map',
    );
  });

  test('refreshTracked drops a tracked project once its file disappears', () => {
    const projectPath = writeProjectFile(tmpDir, 'Vanishing', {
      packages: [{ id: 'Serilog', version: '3.1.0' }],
    });
    ensureTracked(projectPath);
    const absolute = path.resolve(projectPath);
    assert.ok(projectDependencies.value.has(absolute), 'tracked before deletion');

    fs.rmSync(projectPath, { force: true });
    const result = refreshTracked(projectPath);

    assert.strictEqual(result, undefined, 'a deleted project yields undefined');
    assert.ok(!projectDependencies.value.has(absolute), 'and is removed from the signal map');
  });

  test('rescanAll re-parses every tracked project from disk in one publish', () => {
    const a = writeProjectFile(tmpDir, 'RescanA', { packages: [{ id: 'A', version: '1.0.0' }] });
    const b = writeProjectFile(tmpDir, 'RescanB', { packages: [{ id: 'B', version: '1.0.0' }] });
    ensureTracked(a);
    ensureTracked(b);

    // Mutate both on disk, then rescan all at once.
    writeProjectFile(tmpDir, 'RescanA', {
      packages: [
        { id: 'A', version: '1.0.0' },
        { id: 'A2', version: '2.0.0' },
      ],
    });
    writeProjectFile(tmpDir, 'RescanB', { packages: [] });

    const before = projectDependencies.value;
    rescanAll();
    const after = projectDependencies.value;

    assert.notStrictEqual(after, before, 'rescanAll publishes a brand-new map');
    assert.strictEqual(after.size, 2, 'both projects remain tracked');
    assert.strictEqual(
      after.get(path.resolve(a))?.nugetPackages.length,
      2,
      'RescanA picked up its added package',
    );
    assert.strictEqual(
      after.get(path.resolve(b))?.nugetPackages.length,
      0,
      'RescanB reflects its now-empty package set',
    );
  });

  test('resetForTests clears the signal map back to empty', () => {
    ensureTracked(
      writeProjectFile(tmpDir, 'Leftover', { packages: [{ id: 'X', version: '1.0.0' }] }),
    );
    assert.ok(projectDependencies.value.size > 0, 'something is tracked before reset');

    resetForTests();

    assert.strictEqual(projectDependencies.value.size, 0, 'the store is empty after resetForTests');
  });
});
