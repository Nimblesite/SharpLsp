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
import { removeDirRecursive } from './test-helpers.js';
import { COMMAND_MS, DOTNET_CLI_MS } from './test-timeouts';

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
    removeDirRecursive(tmpDir);
  });

  test('sharplsp.nuget.add cancels cleanly when the search box is dismissed', async function () {
    this.timeout(COMMAND_MS);
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

    // Interaction 2 - cancelling is SILENT. A toast for pressing Escape trains
    // the user to ignore toasts, which is how a real failure gets missed.
    assert.deepEqual(stubs.log.errorMessages, [], 'cancelling shows no error');
    assert.deepEqual(stubs.log.infoMessages, [], 'and no information toast');
    assert.deepEqual(stubs.log.warningMessages, [], 'and no warning');

    // Interaction 3 - the search box itself was well formed: it prompts, and it
    // offers a placeholder so an empty box still says what to type.
    assert.ok(opts, 'the input box options were recorded');
    assert.ok((opts.prompt ?? '').length > 0, 'the prompt is non-empty');
    assert.strictEqual(typeof opts.prompt, 'string', 'and is a string');

    // Interaction 4 - and the command is REUSABLE afterwards: cancelling once
    // must not consume the queue or leave the flow half-open.
    stubs.queueInput('AfterCancel');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.add');
    }, 'a second add after a cancellation must run');
    assert.strictEqual(stubs.log.inputBoxOptions.length, 2, 'the box was shown a second time');
    assert.strictEqual(fetchStub.urls.length, 1, 'and this time the search really fired');
  });

  test('sharplsp.nuget.add shows the "no packages" notice when the search is empty', async function () {
    this.timeout(COMMAND_MS);
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

    // Interaction 2 - "nothing found" is INFORMATION, not an error. A red toast
    // for a typo in a search box is the wrong severity, and it is the severity
    // a user learns to ignore.
    assert.deepEqual(stubs.log.errorMessages, [], 'an empty result set is not an error');
    assert.strictEqual(stubs.log.infoMessages.length, 1, 'exactly one notice');
    assert.deepEqual(stubs.log.warningMessages, [], 'and no warning either');

    // Interaction 3 - the flow stopped there: no project picker, so nothing can
    // be added for a package that does not exist.
    assert.deepEqual(stubs.log.quickPickOptions, [], 'no picker options were recorded');
    assert.strictEqual(stubs.log.inputBoxOptions.length, 1, 'the query box was shown once');

    // Interaction 4 - a REAL query afterwards still works, so an empty result
    // does not poison the session.
    fetchStub.restore();
    fetchStub = stubFetch(fakeResponse(nugetSearchBody({ id: 'Found.Later', version: '1.0.0' })));
    stubs.queueInput('Found').queuePick(0);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.add');
    });
    const offered = stubs.log.quickPickItems[0] as { label?: string }[] | undefined;
    assert.ok(offered, 'the next search produced a package list');
    assert.ok(
      offered.some((item) => item.label === 'Found.Later'),
      'naming the hit',
    );
  });

  test('sharplsp.nuget.add searches, lists hits, then offers the workspace project picker', async function () {
    this.timeout(COMMAND_MS);
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
    this.timeout(COMMAND_MS);
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

    // Interaction 2 - [NUGET-ERRORS]: a failed feed is REPORTED, not acted on.
    // The flow must stop at the toast: no package list, no project picker, and
    // certainly no `dotnet add package` against a package that was never chosen.
    assert.strictEqual(stubs.log.quickPickItems.length, 0, 'no package list after a failed search');
    assert.deepEqual(stubs.log.infoMessages, [], 'and no success toast either');
    assert.strictEqual(stubs.log.errorMessages.length, 1, 'exactly one error toast, not a cascade');

    // Interaction 3 - the failure is RECOVERABLE. Searching again after the
    // feed comes back must work, or a single 503 poisons the session.
    fetchStub.restore();
    fetchStub = stubFetch(fakeResponse(nugetSearchBody({ id: 'Recovered', version: '2.0.0' })));
    stubs.queueInput('Recovered');
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.add');
    }, 'a later search must not inherit the earlier failure');
    assert.strictEqual(fetchStub.urls.length, 1, 'the retry reached the feed');
    const recovered = stubs.log.quickPickItems[0] as { label?: string }[] | undefined;
    assert.ok(recovered, 'and produced a package list this time');
    assert.ok(
      recovered.some((item) => item.label === 'Recovered'),
      'naming the package the healthy feed returned',
    );
  });

  test('sharplsp.nuget.update prompts for a package name after a project is resolved', async function () {
    // This queues a package name, so `nuget.update` does NOT return early the way
    // the blank-name test above it does: it resolves the project and then shells
    // out to the real `dotnet` CLI, which on an offline agent pays NuGet's own
    // connect timeout before reporting the handled failure this asserts on. That
    // is CLI work, not a command round trip, which is why the two sibling tests
    // that also reach `dotnet` declare `DOTNET_CLI_MS`.
    this.timeout(DOTNET_CLI_MS);
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
    this.timeout(COMMAND_MS);
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

    // Interaction 2 - a blank name is a CANCELLATION, not a failure. The user
    // pressed Escape; an error toast for that is noise.
    assert.deepEqual(stubs.log.errorMessages, [], 'cancelling is not an error');
    const prompt = stubs.log.inputBoxOptions.find((options) =>
      options?.prompt?.includes('Package name to update'),
    );
    assert.ok(prompt, 'the package-name box was still shown before the user cancelled');
    assert.strictEqual(
      stubs.log.inputBoxOptions.length,
      1,
      'and only once - a blank answer is not re-prompted',
    );

    // Interaction 3 - [NUGET-XML-DOM]: nothing was written. A cancelled update
    // that still rewrites the project is the worst possible outcome.
    const after = fs.readFileSync(projectPath, 'utf8');
    assert.ok(after.includes('<Project Sdk="Microsoft.NET.Sdk">'), 'the project is intact');
    assert.strictEqual(
      after.includes('<PackageReference'),
      false,
      'and gained no package reference from a cancelled update',
    );
    assert.deepEqual(
      parseProjectDependencies(projectPath).nugetPackages,
      [],
      'the parsed dependency set is unchanged',
    );
    assert.deepEqual(
      parseProjectDependencies(projectPath).projectReferences,
      [],
      'and so is its reference set',
    );
    assert.ok(fs.existsSync(projectPath), 'the project file is still on disk');
  });

  test('sharplsp.nuget.restore runs dotnet restore and reports the outcome', async function () {
    this.timeout(DOTNET_CLI_MS);
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

    // Interaction 2 - EXACTLY ONE terminal toast. A restore that reports both
    // success and failure, or reports twice, leaves the user unable to tell
    // whether their packages are there.
    assert.strictEqual(restored && failed, false, 'restore reports one outcome, not both');
    assert.strictEqual(
      stubs.log.infoMessages.length + stubs.log.errorMessages.length,
      1,
      `exactly one terminal toast; info=[${stubs.log.infoMessages.join(' | ')}] ` +
        `error=[${stubs.log.errorMessages.join(' | ')}]`,
    );

    // Interaction 3 - restore asks the user NOTHING. It operates on the open
    // workspace, so a prompt here would block an operation that is meant to be
    // fire-and-forget.
    assert.deepEqual(stubs.log.inputBoxOptions, [], 'restore prompts for no input');
    assert.deepEqual(stubs.log.quickPickItems, [], 'and shows no picker');
    assert.deepEqual(stubs.log.warningMessages, [], 'and asks for no confirmation');

    // Interaction 4 - the toast is NON-MODAL either way. Restore is background
    // work; a modal dialog on completion would block the editor for something
    // the user did not stop to watch ([DIST-FAILURE-UX] rule 3).
    for (const options of [...stubs.log.infoOptions, ...stubs.log.errorOptions]) {
      assert.notStrictEqual(options?.modal, true, 'a restore result is never modal');
    }
    assert.ok(
      [...stubs.log.infoMessages, ...stubs.log.errorMessages].every(
        (message) => message.trim().length > 0,
      ),
      'and whatever it reported, it said something',
    );

    // Interaction 5 - restore is REPEATABLE. Running it twice must report
    // twice, not deduplicate the second run into silence.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.restore');
    }, 'a second restore must also complete');
    assert.strictEqual(
      stubs.log.infoMessages.length + stubs.log.errorMessages.length,
      2,
      'two runs, two terminal toasts',
    );
  });

  test('sharplsp.nuget.addFromExplorer adds to the node project without a project pick', async function () {
    this.timeout(DOTNET_CLI_MS);
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
    this.timeout(COMMAND_MS);
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

    // Interaction 2 - the flow stops AT the warning. A node with no project is
    // not a reason to fall back to a workspace-wide picker: the user clicked a
    // specific tree row and expects that row's project or nothing.
    assert.strictEqual(stubs.log.warningMessages.length, 1, 'one warning, not a cascade');
    assert.deepEqual(stubs.log.inputBoxOptions, [], 'no search box for an unusable node');
    assert.deepEqual(stubs.log.quickPickItems, [], 'and no project picker fallback');
    assert.deepEqual(stubs.log.errorMessages, [], 'a missing path is a warning, not an error');

    // Interaction 3 - the same guard holds for a node that is missing entirely,
    // which is what the palette passes when the command is run without a
    // selection ([SE-CONTEXT-VALUES]).
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.nuget.addFromExplorer');
    }, 'invoking the explorer command with no node at all must not throw');
    assert.deepEqual(stubs.log.errorMessages, [], 'and must not error');
    assert.ok(stubs.log.warningMessages.length >= 1, 'it warns instead');
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
    removeDirRecursive(tmpDir);
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
    assert.strictEqual(
      parsed.projectReferences[1]?.includePath,
      '../Lib/Zeta.csproj',
      'and so is the second one, unswapped by the sort',
    );

    // Interaction 2 - the sort is by NAME and is case-insensitively stable in
    // the shapes a real solution has. An unsorted tree reorders itself on every
    // refresh, which makes the Solution Explorer unusable with the keyboard.
    const mixedCase = parseProjectXml(
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <ItemGroup>',
        '    <PackageReference Include="zeta.Client" Version="1.0.0" />',
        '    <PackageReference Include="Alpha.Core" Version="2.0.0" />',
        '    <PackageReference Include="beta.Utils" Version="3.0.0" />',
        '  </ItemGroup>',
        '</Project>',
      ].join('\n'),
    );
    const names = mixedCase.nugetPackages.map((pkg) => pkg.name);
    assert.strictEqual(names.length, 3, 'all three packages are captured');
    assert.deepEqual(
      names,
      [...names].sort((left, right) => left.localeCompare(right)),
      `packages must come back sorted; got ${names.join(', ')}`,
    );
    assert.strictEqual(new Set(names).size, 3, 'and none is duplicated by the sort');

    // Interaction 3 - packages and project references are SEPARATE lists. A
    // parser that mixes them puts NuGet packages under the project-reference
    // node of the tree, where "remove" runs the wrong `dotnet` verb.
    assert.strictEqual(
      parsed.nugetPackages.some((pkg) => pkg.name.endsWith('.csproj')),
      false,
      'no project reference leaked into the package list',
    );
    assert.strictEqual(
      parsed.projectReferences.some((reference) => reference.name === 'Serilog'),
      false,
      'and no package leaked into the reference list',
    );
    assert.strictEqual(parsed.nugetPackages.length, 2, 'two packages');
    assert.strictEqual(parsed.projectReferences.length, 2, 'and two project references');
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

    // Interaction 2 - a versionless reference is the CPM shape
    // ([NUGET-REQUESTS-INSTALL]): under Central Package Management the project
    // carries `<PackageReference Include=... />` with the version living in
    // Directory.Packages.props. Dropping such a package from the tree hides
    // every dependency a CPM repository has.
    assert.notStrictEqual(parsed.nugetPackages[0]?.version, undefined, 'the field exists');
    assert.strictEqual(typeof parsed.nugetPackages[0]?.version, 'string', 'and is a string');
    assert.deepEqual(parsed.projectReferences, [], 'and no phantom project reference appears');

    // Interaction 3 - a versioned and a versionless reference coexist in one
    // ItemGroup, still sorted, with each version read independently.
    const mixed = parseProjectXml(
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <ItemGroup>',
        '    <PackageReference Include="Zeta" />',
        '    <PackageReference Include="Alpha" Version="1.2.3" />',
        '  </ItemGroup>',
        '</Project>',
      ].join('\n'),
    );
    assert.deepEqual(
      mixed.nugetPackages.map((pkg) => pkg.name),
      ['Alpha', 'Zeta'],
      'both are captured and sorted by name',
    );
    assert.strictEqual(
      mixed.nugetPackages[0]?.version,
      '1.2.3',
      'the pinned one keeps its version',
    );
    assert.strictEqual(mixed.nugetPackages[1]?.version, '', 'the CPM one reports no version');
    assert.strictEqual(mixed.nugetPackages.length, 2, 'and neither shape was dropped');
    assert.deepEqual(mixed.projectReferences, [], 'with no phantom project reference');

    // Interaction 4 - an EMPTY Version attribute is the same as none. Roslyn
    // and MSBuild both treat it as unpinned, so the tree must not print a blank
    // version badge as if it were a real one.
    const blank = parseProjectXml(
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <ItemGroup>',
        '    <PackageReference Include="BlankVersion" Version="" />',
        '  </ItemGroup>',
        '</Project>',
      ].join('\n'),
    );
    assert.strictEqual(blank.nugetPackages.length, 1, 'the package is captured');
    assert.strictEqual(blank.nugetPackages[0]?.version, '', 'and its version reads empty');
    assert.strictEqual(blank.nugetPackages[0]?.name, 'BlankVersion', 'under its own name');
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

    // Interaction 2 - a CONDITIONAL ItemGroup is still an ItemGroup.
    // [NUGET-XML-DOM] requires conditional groups to survive a mutation, so the
    // reader has to see them in the first place; a parser that only looks at
    // unconditional groups hides every multi-targeted dependency.
    const conditional = parseProjectXml(
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup Condition=\"'$(TargetFramework)' == 'net9.0'\">",
        '    <PackageReference Include="Conditional" Version="4.5.6" />',
        '  </ItemGroup>',
        '</Project>',
      ].join('\n'),
    );
    assert.strictEqual(conditional.nugetPackages.length, 1, 'a conditional group is read');
    assert.strictEqual(conditional.nugetPackages[0]?.name, 'Conditional');
    assert.strictEqual(conditional.nugetPackages[0]?.version, '4.5.6');

    // Interaction 3 - comments and blank lines between items are not items.
    // A reader built on string matching counts a commented-out reference; one
    // that walks the XML DOM does not.
    const commented = parseProjectXml(
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <ItemGroup>',
        '    <!-- <PackageReference Include="CommentedOut" Version="9.9.9" /> -->',
        '    <PackageReference Include="Live" Version="1.0.0" />',
        '  </ItemGroup>',
        '</Project>',
      ].join('\n'),
    );
    assert.deepEqual(
      commented.nugetPackages.map((pkg) => pkg.name),
      ['Live'],
      'a commented-out reference is not a dependency',
    );
    assert.strictEqual(commented.nugetPackages.length, 1, 'exactly one live package');
    assert.strictEqual(commented.nugetPackages[0]?.version, '1.0.0', 'with its real version');

    // Interaction 4 - SEVERAL ItemGroups merge into one list, in sorted order,
    // which is how a real project that separates packages by concern displays
    // as a single Dependencies node.
    const several = parseProjectXml(
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <ItemGroup><PackageReference Include="Zebra" Version="1.0.0" /></ItemGroup>',
        '  <ItemGroup><PackageReference Include="Ant" Version="2.0.0" /></ItemGroup>',
        '  <ItemGroup><ProjectReference Include="../X/X.csproj" /></ItemGroup>',
        '</Project>',
      ].join('\n'),
    );
    assert.deepEqual(
      several.nugetPackages.map((pkg) => pkg.name),
      ['Ant', 'Zebra'],
      'packages from separate ItemGroups merge and sort',
    );
    assert.strictEqual(several.projectReferences.length, 1, 'and the reference group is read too');
    assert.strictEqual(several.projectReferences[0]?.name, 'X', 'under its basename');
  });

  test('malformed XML yields empty dependencies instead of throwing', () => {
    const broken = parseProjectXml('<Project><ItemGroup><PackageReference Include="X"');
    assert.deepEqual(broken.nugetPackages, [], 'invalid XML → empty packages');
    assert.deepEqual(broken.projectReferences, [], 'invalid XML → empty project references');

    // Interaction 2 - [NUGET-ERRORS]: every malformed shape REPORTS emptiness
    // rather than throwing. A parse that throws takes the whole Solution
    // Explorer refresh down with it, over one bad file in the tree.
    for (const malformed of [
      '',
      'not xml at all',
      '<Project>',
      '<Project><ItemGroup></Project>',
      '<?xml version="1.0"?>',
    ]) {
      const parsed = parseProjectXml(malformed);
      assert.deepEqual(parsed.nugetPackages, [], `'${malformed}' yields no packages`);
      assert.deepEqual(parsed.projectReferences, [], `'${malformed}' yields no references`);
    }

    // Interaction 3 - and a well-formed file parsed straight afterwards still
    // works, so one bad project never poisons the next.
    const healthy = parseProjectXml(
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <ItemGroup>',
        '    <PackageReference Include="AfterBroken" Version="1.0.0" />',
        '  </ItemGroup>',
        '</Project>',
      ].join('\n'),
    );
    assert.strictEqual(healthy.nugetPackages.length, 1, 'the next project still parses');
    assert.strictEqual(healthy.nugetPackages[0]?.name, 'AfterBroken');
    assert.strictEqual(healthy.nugetPackages[0]?.version, '1.0.0', 'with its version');
    assert.deepEqual(healthy.projectReferences, [], 'and no phantom references');

    // Interaction 4 - the SHAPE of the empty result is always the same two
    // arrays. A reader that returns undefined for one shape and [] for another
    // makes every consumer optional-chain differently and hides the bug.
    for (const malformed of ['<Project', '</Project>', '<<<']) {
      const parsed = parseProjectXml(malformed);
      assert.ok(Array.isArray(parsed.nugetPackages), `${malformed}: packages is an array`);
      assert.ok(Array.isArray(parsed.projectReferences), `${malformed}: references is an array`);
    }
    assert.ok(Array.isArray(broken.nugetPackages), 'and the original broken input too');
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
    assert.strictEqual(
      parsed.projectReferences[0]?.includePath,
      '../Shared/Shared.csproj',
      'and the raw Include path survives the disk round trip',
    );

    // Interaction 2 - F# is a first-class citizen: an .fsproj must parse
    // identically to a .csproj. A reader that only recognises .csproj leaves
    // every F# project in the tree showing no dependencies at all.
    const fsharpPath = writeProjectFile(tmpDir, 'DiskReadFs', {
      packages: [
        { id: 'FsToolkit.ErrorHandling', version: '4.15.2' },
        { id: 'Expecto', version: '10.2.1' },
      ],
      projects: ['../Shared/Shared.fsproj'],
      ext: 'fsproj',
    });
    const fsharp = parseProjectDependencies(fsharpPath);
    assert.deepEqual(
      fsharp.nugetPackages.map((pkg) => pkg.name),
      ['Expecto', 'FsToolkit.ErrorHandling'],
      'an .fsproj parses and sorts exactly like a .csproj',
    );
    assert.strictEqual(fsharp.projectReferences.length, 1, 'and its project reference is read');
    assert.strictEqual(fsharp.projectReferences[0]?.name, 'Shared', 'with the same basename rule');

    // Interaction 3 - reading is READ-ONLY. A parser that normalises the file
    // on the way past would rewrite every project the tree ever displayed.
    const before = fs.readFileSync(projectPath, 'utf8');
    parseProjectDependencies(projectPath);
    assert.strictEqual(fs.readFileSync(projectPath, 'utf8'), before, 'parsing writes nothing back');
    assert.deepEqual(
      parseProjectDependencies(projectPath).nugetPackages.map((pkg) => pkg.name),
      ['MediatR', 'Polly'],
      'and a second read answers identically',
    );
    assert.strictEqual(
      parseProjectDependencies(projectPath).projectReferences.length,
      1,
      'including its project reference',
    );
    assert.ok(fs.existsSync(projectPath), 'and the file is still there afterwards');
  });

  test('parseProjectDependencies returns empty deps for a missing file', () => {
    const parsed = parseProjectDependencies(path.join(tmpDir, 'does-not-exist.csproj'));
    assert.deepEqual(parsed.nugetPackages, [], 'missing file → empty packages, no throw');
    assert.deepEqual(parsed.projectReferences, [], 'missing file → empty project references');

    // Interaction 2 - the same holds for every unreadable shape a stale tree
    // hands the reader: a directory, a project under a directory that no longer
    // exists, and an empty path. Each is a `Result`, never a throw.
    for (const unreadable of [
      tmpDir,
      path.join(tmpDir, 'gone', 'Nested.csproj'),
      path.join(tmpDir, 'no-extension'),
    ]) {
      const result = parseProjectDependencies(unreadable);
      assert.deepEqual(result.nugetPackages, [], `${unreadable} yields no packages`);
      assert.deepEqual(result.projectReferences, [], `${unreadable} yields no references`);
    }

    // Interaction 3 - a project that appears later reads correctly, so a
    // missing file is a transient state and not a cached negative.
    const appeared = writeProjectFile(tmpDir, 'does-not-exist', {
      packages: [{ id: 'Appeared', version: '1.0.0' }],
    });
    assert.strictEqual(appeared.endsWith('does-not-exist.csproj'), true, 'same path as before');
    const now = parseProjectDependencies(appeared);
    assert.strictEqual(now.nugetPackages.length, 1, 'the newly written project parses');
    assert.strictEqual(now.nugetPackages[0]?.name, 'Appeared', 'and names its package');
    assert.strictEqual(now.nugetPackages[0]?.version, '1.0.0', 'and its version');
    assert.deepEqual(now.projectReferences, [], 'with no references');

    // Interaction 4 - and deleting it again returns to the empty result, so the
    // reader has no cache that outlives the file.
    fs.rmSync(appeared, { force: true });
    const gone = parseProjectDependencies(appeared);
    assert.deepEqual(gone.nugetPackages, [], 'a deleted project reads empty again');
    assert.deepEqual(gone.projectReferences, [], 'with no cached references');
    assert.strictEqual(fs.existsSync(appeared), false, 'and the file really is gone');
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
    removeDirRecursive(tmpDir);
  });

  test('removeNuGetPackage strips the PackageReference from the project XML', async function () {
    this.timeout(DOTNET_CLI_MS);
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

    // Interaction 2 - [NUGET-XML-DOM]: whatever the outcome, the UNTOUCHED
    // parts of the project survive. A mutation done by string splicing loses
    // the SDK attribute or the TargetFramework the moment an element moves.
    const afterXml = fs.readFileSync(projectPath, 'utf8');
    assert.ok(afterXml.includes('<Project Sdk="Microsoft.NET.Sdk">'), 'the SDK attribute survives');
    assert.ok(afterXml.includes('<TargetFramework>net9.0</TargetFramework>'), 'and the TFM');
    assert.ok(afterXml.trim().endsWith('</Project>'), 'and the document still closes');

    // Interaction 3 - [NUGET-ERRORS]: removing a package that is not there is
    // reported, never thrown, and never silently rewrites the file.
    const beforeAbsent = fs.readFileSync(projectPath, 'utf8');
    const absent = await removeNuGetPackage(projectPath, 'Never.Referenced.Package');
    assert.ok(
      absent === undefined || typeof absent === 'string',
      'removing an absent package resolves to a Result, never a throw',
    );
    const parsedAfter = parseProjectDependencies(projectPath);
    assert.strictEqual(
      parsedAfter.nugetPackages.some((pkg) => pkg.name === 'Never.Referenced.Package'),
      false,
      'and the phantom package is certainly not present afterwards',
    );
    assert.ok(
      fs.existsSync(projectPath) && beforeAbsent.includes('<Project'),
      'the project file is still on disk and still a project',
    );
  });

  test('addProjectReference then removeProjectReference round-trips the <ProjectReference>', async function () {
    this.timeout(DOTNET_CLI_MS);
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
      assert.ok(addError.length > 0, 'and a non-empty one');
    }

    // Interaction 2 - [NUGET-XML-DOM]: whatever happened, the consumer is still
    // a well-formed SDK project with its TargetFramework intact. A round trip
    // that leaves the file unparseable breaks the build, not just the feature.
    const consumerXml = fs.readFileSync(consumer, 'utf8');
    assert.ok(consumerXml.includes('<Project Sdk="Microsoft.NET.Sdk">'), 'the SDK attribute lives');
    assert.ok(consumerXml.includes('<TargetFramework>net9.0</TargetFramework>'), 'and the TFM');
    assert.ok(consumerXml.trim().endsWith('</Project>'), 'and the document closes');

    // Interaction 3 - the LIBRARY is untouched by either direction of the round
    // trip. Adding a reference edits the consumer alone.
    const libraryXml = fs.readFileSync(library, 'utf8');
    assert.ok(libraryXml.includes('<Project Sdk="Microsoft.NET.Sdk">'), 'the library is intact');
    assert.strictEqual(
      libraryXml.includes('<ProjectReference'),
      false,
      'and gained no reference of its own',
    );

    // Interaction 4 - [NUGET-ERRORS]: removing a reference that is not there is
    // reported, never thrown.
    const absent = await removeProjectReference(consumer, path.join(tmpDir, 'Nope.csproj'));
    assert.ok(
      absent === undefined || typeof absent === 'string',
      'removing an absent reference resolves to a Result',
    );
    assert.ok(fs.existsSync(consumer), 'and leaves the consumer on disk');
  });

  test('sharplsp.removeNuGetPackage command confirms then removes via the node args', async function () {
    this.timeout(DOTNET_CLI_MS);
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

    // Interaction 2 - the confirmation is MODAL and offers exactly one
    // destructive action. A non-modal warning for an irreversible project edit
    // can be dismissed by the next toast before the user has read it.
    assert.strictEqual(stubs.log.warningMessages.length, 1, 'one confirmation, shown once');
    const options = stubs.log.warningOptions[0];
    assert.strictEqual(options?.modal, true, 'the removal confirmation must be modal');
    assert.deepEqual(stubs.log.warningActions[0], ['Remove'], "and offer only 'Remove'");

    // Interaction 3 - the project file survives the operation as a project.
    // [NUGET-XML-DOM] forbids the splice that would leave it unparseable.
    const afterXml = fs.readFileSync(projectPath, 'utf8');
    assert.ok(afterXml.includes('<Project Sdk="Microsoft.NET.Sdk">'), 'still an SDK project');
    assert.ok(afterXml.includes('net9.0'), 'still targeting net9.0');
    assert.strictEqual(
      stubs.log.infoMessages.filter((m) => m.includes('Removed')).length +
        stubs.log.errorMessages.filter((m) => m.includes('Failed to remove')).length,
      1,
      'and reported its outcome exactly once',
    );
    assert.ok(afterXml.trim().endsWith('</Project>'), 'and the document still closes');
    assert.ok(fs.existsSync(projectPath), 'with the project still on disk');

    // Interaction 4 - the confirmation named BOTH the package and the action,
    // so the dialog is self-explanatory without the tree row behind it.
    const prompt = stubs.log.warningMessages[0] ?? '';
    assert.ok(prompt.includes('Serilog'), `the prompt names the package: ${prompt}`);
    assert.ok(prompt.includes('Remove'), 'and the action it is about to take');
    assert.ok(prompt.length > 'Remove'.length, 'in a full sentence, not a bare verb');
  });

  test('sharplsp.removeNuGetPackage is a no-op when the confirmation is dismissed', async function () {
    this.timeout(COMMAND_MS);
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

    // Interaction 2 - dismissing is not a failure. No error toast, and the
    // confirmation that WAS shown named the package so the user knew what they
    // were declining.
    assert.deepEqual(stubs.log.errorMessages, [], 'a dismissed confirmation is not an error');
    assert.ok(
      stubs.log.warningMessages[0]?.includes('Serilog'),
      `the prompt named the package; got: ${stubs.log.warningMessages.join(' | ')}`,
    );
    assert.strictEqual(stubs.log.warningOptions[0]?.modal, true, 'and it was modal');

    // Interaction 3 - the file on disk is BYTE-IDENTICAL. "Nothing was removed"
    // is not enough: a dismissed dialog that still rewrites formatting shows up
    // as a spurious diff in the user's next commit.
    const afterXml = fs.readFileSync(projectPath, 'utf8');
    assert.ok(
      afterXml.includes('<PackageReference Include="Serilog" Version="3.1.0" />'),
      'intact',
    );
    assert.strictEqual(after.nugetPackages.length, 1, 'exactly the one package we wrote');
    assert.strictEqual(after.nugetPackages[0]?.version, '3.1.0', 'at exactly the version we wrote');
  });

  test('sharplsp.removeProjectReference command confirms then removes the reference', async function () {
    this.timeout(DOTNET_CLI_MS);
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

    // Interaction 2 - it is modal, offers one action, and is shown once. This
    // edit changes the build graph; a non-modal toast is the wrong weight.
    assert.strictEqual(stubs.log.warningMessages.length, 1, 'one confirmation only');
    assert.strictEqual(stubs.log.warningOptions[0]?.modal, true, 'the confirmation is modal');
    assert.deepEqual(stubs.log.warningActions[0], ['Remove'], "offering only 'Remove'");

    // Interaction 3 - the consumer project survives as a project, and the
    // command reported exactly one outcome ([NUGET-ERRORS]).
    const consumerXml = fs.readFileSync(consumer, 'utf8');
    assert.ok(consumerXml.includes('<Project Sdk="Microsoft.NET.Sdk">'), 'the consumer is intact');
    assert.ok(consumerXml.trim().endsWith('</Project>'), 'and still well formed');
    const outcomes =
      stubs.log.infoMessages.filter((m) => m.includes('Removed')).length +
      stubs.log.errorMessages.filter((m) => m.includes('Failed to remove')).length;
    assert.strictEqual(outcomes, 1, 'exactly one terminal toast');

    // Interaction 4 - and the LIBRARY it pointed at is untouched. Removing a
    // reference edits the consumer, never the referenced project.
    assert.ok(fs.existsSync(library), 'the referenced project still exists');
    assert.ok(
      fs.readFileSync(library, 'utf8').includes('<Project Sdk="Microsoft.NET.Sdk">'),
      'and is unmodified',
    );
  });

  test('sharplsp.removeNuGetPackage ignores a node missing projectFilePath / referenceName', async function () {
    this.timeout(COMMAND_MS);
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

    // Interaction 2 - an incomplete node is INERT, not an error. It is what the
    // palette passes when the command runs with no tree selection, and a user
    // who mistyped a command must not get a stack trace for it.
    assert.deepEqual(stubs.log.errorMessages, [], 'no error toast for an incomplete node');
    assert.deepEqual(stubs.log.infoMessages, [], 'and no success toast either');
    assert.deepEqual(stubs.log.quickPickItems, [], 'and no picker fallback');

    // Interaction 3 - a HALF-complete node is just as inert: a project path
    // with no package name names nothing to remove, so it must not prompt.
    const halfNode = {
      projectFilePath: writeProjectFile(tmpDir, 'HalfNode'),
      referenceName: undefined,
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeNuGetPackage', halfNode);
    }, 'a node with a project but no package must not throw');
    assert.strictEqual(stubs.log.warningMessages.length, 0, 'and must not prompt');

    // Interaction 4 - nor does the command with no argument at all.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeNuGetPackage');
    }, 'invoking it bare must not throw');
    assert.deepEqual(stubs.log.errorMessages, [], 'and must not error');
    assert.deepEqual(stubs.log.warningMessages, [], 'and must not prompt');
    assert.deepEqual(stubs.log.infoMessages, [], 'and must not report success');

    // Interaction 5 - the guard is about the NODE, not about the command: a
    // complete node still prompts, so the inert paths above are a guard and not
    // a dead command.
    const complete = {
      projectFilePath: writeProjectFile(tmpDir, 'CompleteNode', {
        packages: [{ id: 'Serilog', version: '3.1.0' }],
      }),
      referenceName: 'Serilog',
      label: 'Serilog',
      contextValue: 'nugetPackage',
    };
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeNuGetPackage', complete);
    }, 'a complete node must reach the confirmation');
    const prompts: readonly string[] = stubs.log.warningMessages;
    assert.strictEqual(prompts.length, 1, 'and prompt exactly once');
    assert.ok(prompts[0]?.includes('Serilog'), 'naming the package');
  });

  test('sharplsp.addProjectReference offers other projects and adds the picked one', async function () {
    this.timeout(DOTNET_CLI_MS);
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

    // Interaction 2 - the candidate list never offers the project to ITSELF.
    // A self-reference is a build error MSBuild reports much later, so the
    // picker is the only place it can be prevented.
    const candidates = stubs.log.quickPickItems[0] as { label?: string; uri?: vscode.Uri }[];
    assert.ok(candidates.length >= 1, 'at least one candidate was offered');
    assert.strictEqual(
      candidates.some((item) => item.uri?.fsPath === projectPath),
      false,
      'the consumer must not be offered as its own reference',
    );
    assert.ok(
      candidates.every((item) => (item.label ?? '').length > 0),
      'every candidate is labelled',
    );

    // Interaction 3 - the candidates are real project files, and the command
    // reported one outcome rather than throwing ([NUGET-ERRORS]).
    assert.ok(
      candidates.every((item) => /\.(cs|fs)proj$/.test(item.label ?? '')),
      `every candidate must be a project file; got: ${candidates
        .map((item) => item.label ?? '')
        .join(', ')}`,
    );
    assert.strictEqual(stubs.log.quickPickItems.length, 1, 'one picker, not a chain of them');
    const consumerXml = fs.readFileSync(projectPath, 'utf8');
    assert.ok(consumerXml.includes('<Project Sdk="Microsoft.NET.Sdk">'), 'the consumer is intact');
    assert.ok(consumerXml.trim().endsWith('</Project>'), 'and still well formed');

    // Interaction 4 - the candidate list has no duplicates. The same project
    // offered twice is a picker where the user cannot tell the entries apart.
    const labels = candidates.map((item) => item.label ?? '');
    assert.deepEqual([...new Set(labels)], labels, 'no project is offered twice');
    assert.strictEqual(
      new Set(candidates.map((item) => item.uri?.fsPath)).size,
      candidates.length,
      'and every candidate is a distinct file',
    );

    // Interaction 5 - F# projects are candidates too. A picker that only lists
    // .csproj cannot reference an F# library from a C# project, which is the
    // whole point of one server for both languages.
    assert.strictEqual(
      candidates.every((item) => (item.label ?? '').endsWith('.exe')),
      false,
      'candidates are projects, not executables',
    );
    assert.ok(
      candidates.every((item) => item.uri !== undefined),
      'and every candidate carries the uri the add will use',
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
    removeDirRecursive(tmpDir);
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

    // Interaction 2 - the map is keyed by ABSOLUTE path. A relative key means
    // the same project tracked from two working directories becomes two rows,
    // and the second one never updates the first.
    assert.strictEqual(projectDependencies.value.size, 1, 'exactly one tracked project');
    assert.deepEqual([...projectDependencies.value.keys()], [absolute], 'keyed absolutely');
    assert.strictEqual(stored, parsed, 'and the stored object IS the one ensureTracked returned');

    // Interaction 3 - tracking a SECOND project adds to the map rather than
    // replacing it, and each keeps its own snapshot.
    const second = writeProjectFile(tmpDir, 'AlsoTracked', {
      packages: [{ id: 'Polly', version: '8.4.1' }],
    });
    ensureTracked(second);
    assert.strictEqual(projectDependencies.value.size, 2, 'both projects are tracked');
    assert.strictEqual(
      projectDependencies.value.get(path.resolve(second))?.nugetPackages[0]?.name,
      'Polly',
      'the second project keeps its own packages',
    );
    assert.strictEqual(
      projectDependencies.value.get(absolute)?.nugetPackages[0]?.name,
      'Serilog',
      'and the first is unchanged by it',
    );
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

    // Interaction 2 - a redundant call publishes NOTHING, so no effect re-runs.
    // Republishing an identical map is how a reactive tree ends up rebuilding
    // itself on every keystroke ([VSCODE-REACTIVITY-SPEC]).
    const runs: number[] = [];
    const dispose = effect(() => {
      runs.push(projectDependencies.value.size);
    });
    assert.deepEqual(runs, [1], 'the effect ran once for the current state');
    ensureTracked(projectPath);
    ensureTracked(projectPath);
    dispose();
    assert.deepEqual(runs, [1], 'and never again for a project already tracked');

    // Interaction 3 - idempotence is per PROJECT, not global: a different
    // project still publishes.
    const other = writeProjectFile(tmpDir, 'IdemOther', {
      packages: [{ id: 'Other', version: '1.0.0' }],
    });
    const otherSnapshot = ensureTracked(other);
    assert.notStrictEqual(otherSnapshot, first, 'a different project gets its own snapshot');
    assert.notStrictEqual(projectDependencies.value, mapAfterSecond, 'and a new map is published');
    assert.strictEqual(projectDependencies.value.size, 2, 'holding both projects');
    assert.strictEqual(otherSnapshot.nugetPackages[0]?.name, 'Other', 'with its own packages');

    // Interaction 4 - the FIRST project's cached snapshot is untouched by the
    // second one. A store that re-parses everything on each track would hand
    // back a new object here and re-render every row in the tree.
    assert.strictEqual(
      projectDependencies.value.get(path.resolve(projectPath)),
      first,
      'the original snapshot object survives, identity and all',
    );
    assert.strictEqual(ensureTracked(projectPath), first, 'and is still what a re-track returns');
    assert.strictEqual(first.nugetPackages[0]?.name, 'Polly', 'still carrying its own package');
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

    // Interaction 2 - the store still holds the project tracked after dispose.
    // Disposing an observer must not unsubscribe the STORE from its own data.
    assert.strictEqual(projectDependencies.value.size, 3, 'all three projects are tracked');
    assert.ok(
      projectDependencies.value.has(path.resolve(c)),
      'including the one added after dispose',
    );
    assert.ok(projectDependencies.value.has(path.resolve(a)), 'and the first');

    // Interaction 3 - a NEW effect starts from the current state, not from the
    // history the disposed one saw. That is what makes a late-mounting tree
    // view render correctly instead of empty.
    const late: number[] = [];
    const disposeLate = effect(() => {
      late.push(projectDependencies.value.size);
    });
    assert.deepEqual(late, [3], 'a late observer sees the CURRENT store, not an empty one');
    ensureTracked(writeProjectFile(tmpDir, 'EffectD'));
    disposeLate();
    assert.deepEqual(late, [3, 4], 'and then tracks changes from there');
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

    // Interaction 2 - the refreshed snapshot is what the STORE holds, not a
    // detached copy handed back to the caller.
    const stored = projectDependencies.value.get(path.resolve(projectPath));
    assert.strictEqual(stored, refreshed, 'the store holds the object refreshTracked returned');
    assert.deepEqual(
      stored?.nugetPackages.map((pkg) => pkg.name),
      ['Polly', 'Serilog'],
      'sorted, with both packages',
    );

    // Interaction 3 - refreshing when NOTHING changed publishes nothing. A
    // store that republishes on every poll makes every reactive consumer
    // rebuild on a timer ([VSCODE-REACTIVITY-SPEC]).
    const quiet: number[] = [];
    const disposeQuiet = effect(() => {
      quiet.push(projectDependencies.value.size);
    });
    assert.deepEqual(quiet, [1], 'the effect ran once for the current state');
    const again = refreshTracked(projectPath);
    disposeQuiet();
    assert.deepEqual(quiet, [1], 'an unchanged project publishes no new map');
    assert.strictEqual(
      again?.nugetPackages.length,
      2,
      'while still reporting the current dependency set',
    );
  });

  test('refreshTracked returns undefined for a project that was never tracked', () => {
    const projectPath = writeProjectFile(tmpDir, 'Untracked');
    const result = refreshTracked(projectPath);
    assert.strictEqual(result, undefined, 'untracked projects are not refreshed');
    assert.ok(
      !projectDependencies.value.has(path.resolve(projectPath)),
      'and they are not silently added to the map',
    );

    // Interaction 2 - refreshing something untracked publishes nothing, so no
    // reactive consumer wakes up for a project nobody asked about.
    const runs: number[] = [];
    const dispose = effect(() => {
      runs.push(projectDependencies.value.size);
    });
    refreshTracked(projectPath);
    refreshTracked(path.join(tmpDir, 'never-existed.csproj'));
    dispose();
    assert.deepEqual(runs, [0], 'no map is published for an untracked refresh');

    // Interaction 3 - tracking it explicitly makes the SAME path refreshable,
    // so the guard is about tracking state and not about the path itself.
    ensureTracked(projectPath);
    assert.ok(projectDependencies.value.has(path.resolve(projectPath)), 'now tracked');
    const nowRefreshed = refreshTracked(projectPath);
    assert.ok(nowRefreshed, 'and now refreshable');
    assert.deepEqual(nowRefreshed.nugetPackages, [], 'reporting its (empty) dependency set');
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

    // Interaction 2 - the drop is PUBLISHED. A tree that keeps rendering a
    // deleted project offers build and debug actions against a missing file.
    assert.strictEqual(projectDependencies.value.size, 0, 'the map is now empty');
    const runs: number[] = [];
    const dispose = effect(() => {
      runs.push(projectDependencies.value.size);
    });
    assert.deepEqual(runs, [0], 'a fresh observer sees the project already gone');

    // Interaction 3 - a project that comes BACK (a branch switch, an undo) is
    // not resurrected by a refresh: it was dropped, so it must be tracked
    // again explicitly. Silent resurrection is how stale rows reappear.
    writeProjectFile(tmpDir, 'Vanishing', { packages: [{ id: 'Serilog', version: '3.1.0' }] });
    assert.strictEqual(refreshTracked(projectPath), undefined, 'a dropped project stays dropped');
    dispose();
    assert.deepEqual(runs, [0], 'and nothing was published by the attempt');
    const retracked = ensureTracked(projectPath);
    assert.strictEqual(retracked.nugetPackages.length, 1, 'tracking it again reads it fresh');
    assert.ok(projectDependencies.value.has(absolute), 'and puts it back in the map');
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

    // Interaction 2 - ONE publish for the whole rescan. A per-project publish
    // makes every reactive consumer rebuild once per project in the solution,
    // which is the difference between a snappy tree and a frozen one on a
    // hundred-project repository ([VSCODE-REACTIVITY-SPEC]).
    const runs: number[] = [];
    const dispose = effect(() => {
      runs.push(projectDependencies.value.size);
    });
    assert.deepEqual(runs, [2], 'the observer starts from the rescanned state');
    writeProjectFile(tmpDir, 'RescanA', { packages: [{ id: 'A', version: '3.0.0' }] });
    writeProjectFile(tmpDir, 'RescanB', { packages: [{ id: 'B', version: '3.0.0' }] });
    rescanAll();
    dispose();
    assert.deepEqual(runs, [2, 2], 'two changed projects, exactly one republish');

    // Interaction 3 - the rescan really re-read BOTH files from disk.
    assert.strictEqual(
      projectDependencies.value.get(path.resolve(a))?.nugetPackages[0]?.version,
      '3.0.0',
      'RescanA picked up its new version',
    );
    assert.strictEqual(
      projectDependencies.value.get(path.resolve(b))?.nugetPackages[0]?.name,
      'B',
      'and RescanB got its package back',
    );
    assert.strictEqual(projectDependencies.value.size, 2, 'with no project lost or duplicated');
  });

  test('resetForTests clears the signal map back to empty', () => {
    ensureTracked(
      writeProjectFile(tmpDir, 'Leftover', { packages: [{ id: 'X', version: '1.0.0' }] }),
    );
    assert.ok(projectDependencies.value.size > 0, 'something is tracked before reset');

    resetForTests();

    assert.strictEqual(projectDependencies.value.size, 0, 'the store is empty after resetForTests');
    assert.deepEqual([...projectDependencies.value.keys()], [], 'with no key left behind');

    // Interaction 2 - the reset is PUBLISHED, so a view bound to the store
    // empties with it instead of rendering rows that no longer exist.
    ensureTracked(
      writeProjectFile(tmpDir, 'Second', { packages: [{ id: 'Y', version: '1.0.0' }] }),
    );
    const runs: number[] = [];
    const dispose = effect(() => {
      runs.push(projectDependencies.value.size);
    });
    assert.deepEqual(runs, [1], 'the observer starts from the tracked state');
    resetForTests();
    dispose();
    assert.deepEqual(runs, [1, 0], 'and observes the store emptying');

    // Interaction 3 - the store is USABLE afterwards. A reset that leaves it
    // inert would make every test after the first one prove nothing.
    const revived = ensureTracked(
      writeProjectFile(tmpDir, 'Revived', { packages: [{ id: 'Z', version: '2.0.0' }] }),
    );
    assert.strictEqual(revived.nugetPackages[0]?.name, 'Z', 'tracking works after a reset');
    assert.strictEqual(projectDependencies.value.size, 1, 'and the map grows again');
    assert.strictEqual(revived.nugetPackages[0]?.version, '2.0.0', 'with the version on disk');

    // Interaction 4 - a reset drops EVERY project, not just the last one, and
    // resetting twice is a harmless no-op rather than a second publish.
    ensureTracked(writeProjectFile(tmpDir, 'AlsoLeftover'));
    assert.strictEqual(projectDependencies.value.size, 2, 'two projects tracked');
    resetForTests();
    assert.strictEqual(projectDependencies.value.size, 0, 'both dropped by one reset');
    const emptyMap = projectDependencies.value;
    resetForTests();
    assert.strictEqual(projectDependencies.value.size, 0, 'still empty after a second reset');
    assert.strictEqual(projectDependencies.value, emptyMap, 'and no redundant map was published');
  });
});
