// Implements [PKG-UNUSED-UI]: pins the pure `collectProjectPaths` traversal that
// feeds both the "Remove Unused Packages" and "Consolidate Packages" flows. The
// async dotnet/quick-pick driven commands are out of scope for pure-logic tests;
// only the node → project-path collector is directly callable without an LSP host.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TreeItemCollapsibleState } from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { ExplorerNode } from '../../tree.js';
import {
  collectProjectPaths,
  consolidatePackages,
  removeUnusedPackages,
} from '../../package-maintenance.js';

// ── Fixture builders ──────────────────────────────────────────────
//
// `collectProjectPaths` reads only three fields on a node: `contextValue`,
// `projectFilePath`, and `children`. It never reads `nodeType`, so the second
// constructor argument (a non-exported `NodeType` enum) is irrelevant to the
// behavior under test — we hand it a harmless cast string.

interface NodeSpec {
  readonly contextValue?: string;
  readonly projectFilePath?: string;
  readonly children?: ExplorerNode[];
}

/** Build a real ExplorerNode with the only fields the collector inspects set. */
function node(spec: NodeSpec): ExplorerNode {
  const n = new ExplorerNode(
    'fixture',
    'fixture-kind' as unknown as never,
    TreeItemCollapsibleState.None,
  );
  if (spec.contextValue !== undefined) n.contextValue = spec.contextValue;
  if (spec.projectFilePath !== undefined) n.projectFilePath = spec.projectFilePath;
  n.children = spec.children ?? [];
  return n;
}

/** A 'project' context node carrying a concrete project file path. */
function projectNode(filePath: string, children: ExplorerNode[] = []): ExplorerNode {
  return node({ contextValue: 'project', projectFilePath: filePath, children });
}

/** A 'solution' context node parented over the given project nodes. */
function solutionNode(filePath: string, children: ExplorerNode[]): ExplorerNode {
  return node({ contextValue: 'solution', projectFilePath: filePath, children });
}

suite('package-maintenance — collectProjectPaths()', () => {
  // ── Empty / undefined inputs ────────────────────────────────────
  suite('empty and undefined nodes', () => {
    test('undefined node returns an empty array', () => {
      const result = collectProjectPaths(undefined);
      assert.ok(Array.isArray(result), 'result must be an array');
      assert.deepStrictEqual(result, []);
      assert.strictEqual(result.length, 0);
    });

    test('a leaf node with no children and no project context yields nothing', () => {
      const result = collectProjectPaths(node({ contextValue: 'symbol' }));
      assert.deepStrictEqual(result, []);
      assert.strictEqual(result.length, 0);
    });

    test("a 'project' node WITHOUT a projectFilePath yields nothing", () => {
      // The collector requires BOTH contextValue === 'project' AND a defined path.
      const result = collectProjectPaths(node({ contextValue: 'project' }));
      assert.deepStrictEqual(result, []);
      assert.strictEqual(result.length, 0);
    });

    test('a node with a path but a non-project contextValue yields nothing', () => {
      const result = collectProjectPaths(
        node({ contextValue: 'nugetPackage', projectFilePath: '/repo/A/A.csproj' }),
      );
      assert.deepStrictEqual(result, []);
    });

    test('a node with no contextValue at all yields nothing even with a path', () => {
      const result = collectProjectPaths(node({ projectFilePath: '/repo/B/B.csproj' }));
      assert.deepStrictEqual(result, []);
    });
  });

  // ── Single project node ─────────────────────────────────────────
  suite('a single project node', () => {
    test("a lone 'project' node returns its own path", () => {
      const result = collectProjectPaths(projectNode('/repo/App/App.csproj'));
      assert.deepStrictEqual(result, ['/repo/App/App.csproj']);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0], '/repo/App/App.csproj');
    });

    test('project self-collection ignores its non-project children', () => {
      const self = projectNode('/repo/App/App.csproj', [
        node({ contextValue: 'dependencyFolder', children: [] }),
        node({ contextValue: 'symbol.namespace', children: [] }),
      ]);
      const result = collectProjectPaths(self);
      assert.deepStrictEqual(result, ['/repo/App/App.csproj']);
    });

    test('an fsproj path is returned verbatim (no extension filtering)', () => {
      const result = collectProjectPaths(projectNode('/repo/Lib/Lib.fsproj'));
      assert.deepStrictEqual(result, ['/repo/Lib/Lib.fsproj']);
    });
  });

  // ── Solution node with child projects ───────────────────────────
  suite('a solution node with child projects', () => {
    test('collects all project children, not the solution path itself', () => {
      const sln = solutionNode('/repo/My.sln', [
        projectNode('/repo/A/A.csproj'),
        projectNode('/repo/B/B.csproj'),
        projectNode('/repo/C/C.fsproj'),
      ]);
      const result = collectProjectPaths(sln);
      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(result, ['/repo/A/A.csproj', '/repo/B/B.csproj', '/repo/C/C.fsproj']);
      assert.ok(!result.includes('/repo/My.sln'), 'the .sln path must NOT be collected');
    });

    test('preserves child insertion order', () => {
      const sln = solutionNode('/repo/My.sln', [
        projectNode('/repo/Zeta/Zeta.csproj'),
        projectNode('/repo/Alpha/Alpha.csproj'),
        projectNode('/repo/Mid/Mid.csproj'),
      ]);
      const result = collectProjectPaths(sln);
      assert.deepStrictEqual(result, [
        '/repo/Zeta/Zeta.csproj',
        '/repo/Alpha/Alpha.csproj',
        '/repo/Mid/Mid.csproj',
      ]);
    });

    test('solution with no children returns an empty array', () => {
      const result = collectProjectPaths(solutionNode('/repo/Empty.sln', []));
      assert.deepStrictEqual(result, []);
    });

    test('solution whose only children are non-projects returns nothing', () => {
      const sln = solutionNode('/repo/My.sln', [
        node({ contextValue: 'symbol' }),
        node({ contextValue: 'dependencyFolder' }),
      ]);
      const result = collectProjectPaths(sln);
      assert.deepStrictEqual(result, []);
    });

    test('a solution node WITH a project contextValue collects its own path too', () => {
      // Defensive: the collector keys on contextValue, so if a "solution" were
      // tagged 'project' it would self-collect — verify that exact branch.
      const weird = node({
        contextValue: 'project',
        projectFilePath: '/repo/Outer.csproj',
        children: [projectNode('/repo/A/A.csproj')],
      });
      const result = collectProjectPaths(weird);
      assert.deepStrictEqual(result, ['/repo/Outer.csproj', '/repo/A/A.csproj']);
      assert.strictEqual(result.length, 2);
    });
  });

  // ── Folder / mixed-kind nodes ───────────────────────────────────
  suite('folder and mixed-kind nodes', () => {
    test('a folder (dependencyFolder) node descends into project descendants', () => {
      const folder = node({
        contextValue: 'dependencyFolder',
        children: [projectNode('/repo/A/A.csproj'), projectNode('/repo/B/B.csproj')],
      });
      const result = collectProjectPaths(folder);
      assert.deepStrictEqual(result, ['/repo/A/A.csproj', '/repo/B/B.csproj']);
    });

    test('mixed children: only project-context nodes contribute', () => {
      const sln = solutionNode('/repo/Mixed.sln', [
        node({ contextValue: 'symbol', projectFilePath: '/repo/ignore-1' }),
        projectNode('/repo/Keep/Keep.csproj'),
        node({ contextValue: 'nugetPackage', projectFilePath: '/repo/ignore-2' }),
        projectNode('/repo/AlsoKeep/AlsoKeep.fsproj'),
        node({ contextValue: 'projectReference', projectFilePath: '/repo/ignore-3' }),
      ]);
      const result = collectProjectPaths(sln);
      assert.deepStrictEqual(result, ['/repo/Keep/Keep.csproj', '/repo/AlsoKeep/AlsoKeep.fsproj']);
      assert.ok(!result.includes('/repo/ignore-1'));
      assert.ok(!result.includes('/repo/ignore-2'));
      assert.ok(!result.includes('/repo/ignore-3'));
    });
  });

  // ── Deep / nested traversal ─────────────────────────────────────
  suite('deep and nested traversal', () => {
    test('collects projects nested several levels under non-project folders', () => {
      const deep = node({
        contextValue: 'solution',
        projectFilePath: '/repo/Deep.sln',
        children: [
          node({
            contextValue: 'folder',
            children: [
              node({
                contextValue: 'folder',
                children: [projectNode('/repo/Nested/Deeply/Deeply.csproj')],
              }),
            ],
          }),
        ],
      });
      const result = collectProjectPaths(deep);
      assert.deepStrictEqual(result, ['/repo/Nested/Deeply/Deeply.csproj']);
    });

    test('collects a project AND its project-context descendant', () => {
      const outer = projectNode('/repo/Outer/Outer.csproj', [
        node({
          contextValue: 'dependencyFolder',
          children: [projectNode('/repo/Inner/Inner.csproj')],
        }),
      ]);
      const result = collectProjectPaths(outer);
      assert.deepStrictEqual(result, ['/repo/Outer/Outer.csproj', '/repo/Inner/Inner.csproj']);
    });

    test('a wide-and-deep tree collects every project exactly once in order', () => {
      const sln = solutionNode('/repo/Big.sln', [
        projectNode('/repo/P1/P1.csproj', [
          node({
            contextValue: 'folder',
            children: [projectNode('/repo/P1a/P1a.csproj')],
          }),
        ]),
        node({
          contextValue: 'folder',
          children: [projectNode('/repo/P2/P2.csproj'), projectNode('/repo/P3/P3.fsproj')],
        }),
      ]);
      const result = collectProjectPaths(sln);
      assert.deepStrictEqual(result, [
        '/repo/P1/P1.csproj',
        '/repo/P1a/P1a.csproj',
        '/repo/P2/P2.csproj',
        '/repo/P3/P3.fsproj',
      ]);
      assert.strictEqual(result.length, 4);
    });
  });

  // ── Deduplication (Set semantics) ───────────────────────────────
  suite('deduplication via Set', () => {
    test('the same project path appearing twice is collected once', () => {
      const sln = solutionNode('/repo/Dup.sln', [
        projectNode('/repo/A/A.csproj'),
        projectNode('/repo/A/A.csproj'),
      ]);
      const result = collectProjectPaths(sln);
      assert.deepStrictEqual(result, ['/repo/A/A.csproj']);
      assert.strictEqual(result.length, 1);
    });

    test('dedup keeps first occurrence order across nested duplicates', () => {
      const sln = solutionNode('/repo/Dup.sln', [
        projectNode('/repo/A/A.csproj'),
        projectNode('/repo/B/B.csproj'),
        node({
          contextValue: 'folder',
          children: [projectNode('/repo/A/A.csproj'), projectNode('/repo/C/C.csproj')],
        }),
      ]);
      const result = collectProjectPaths(sln);
      assert.deepStrictEqual(result, ['/repo/A/A.csproj', '/repo/B/B.csproj', '/repo/C/C.csproj']);
      assert.strictEqual(result.length, 3);
    });

    test('a self-project that also duplicates a child is collected once', () => {
      const outer = projectNode('/repo/Shared.csproj', [projectNode('/repo/Shared.csproj')]);
      const result = collectProjectPaths(outer);
      assert.deepStrictEqual(result, ['/repo/Shared.csproj']);
      assert.strictEqual(result.length, 1);
    });
  });

  // ── Edge-case path strings ──────────────────────────────────────
  suite('edge-case path strings', () => {
    test('an empty-string projectFilePath IS collected (it is !== undefined)', () => {
      // '' is a defined string, so the guard `projectFilePath !== undefined` passes.
      const result = collectProjectPaths(node({ contextValue: 'project', projectFilePath: '' }));
      assert.deepStrictEqual(result, ['']);
      assert.strictEqual(result.length, 1);
    });

    test('whitespace-only path is preserved verbatim', () => {
      const result = collectProjectPaths(projectNode('   '));
      assert.deepStrictEqual(result, ['   ']);
    });

    test('unicode path is preserved byte-for-byte', () => {
      const p = '/repo/проект/Проéкт日本.csproj';
      const result = collectProjectPaths(projectNode(p));
      assert.deepStrictEqual(result, [p]);
      assert.strictEqual(result[0], p);
    });

    test('paths with special regex characters are preserved verbatim', () => {
      const p = '/repo/A.B+C(d)[e]/My.$Proj^.csproj';
      const result = collectProjectPaths(projectNode(p));
      assert.deepStrictEqual(result, [p]);
    });

    test('windows-style backslash path is preserved verbatim', () => {
      const p = 'C:\\src\\App\\App.csproj';
      const result = collectProjectPaths(projectNode(p));
      assert.deepStrictEqual(result, [p]);
    });

    test('two distinct empty-ish paths are NOT collapsed beyond Set identity', () => {
      const sln = solutionNode('/repo/W.sln', [
        node({ contextValue: 'project', projectFilePath: '' }),
        node({ contextValue: 'project', projectFilePath: ' ' }),
      ]);
      const result = collectProjectPaths(sln);
      assert.deepStrictEqual(result, ['', ' ']);
      assert.strictEqual(result.length, 2);
    });
  });

  // ── Return contract ─────────────────────────────────────────────
  suite('return contract', () => {
    test('always returns a fresh array (callers may mutate freely)', () => {
      const n = projectNode('/repo/A/A.csproj');
      const first = collectProjectPaths(n);
      const second = collectProjectPaths(n);
      assert.notStrictEqual(first, second, 'each call returns a new array instance');
      assert.deepStrictEqual(first, second);
      first.push('/mutated');
      assert.deepStrictEqual(
        second,
        ['/repo/A/A.csproj'],
        'mutating one must not affect the other',
      );
    });

    test('every element is a string', () => {
      const sln = solutionNode('/repo/My.sln', [
        projectNode('/repo/A/A.csproj'),
        projectNode('/repo/B/B.fsproj'),
      ]);
      for (const entry of collectProjectPaths(sln)) {
        assert.strictEqual(typeof entry, 'string');
      }
    });
  });
});

// ── Async command harness ─────────────────────────────────────────
//
// `removeUnusedPackages` and `consolidatePackages` drive `vscode.window.*`
// dialogs and an injected `LanguageClient.sendRequest` seam. We monkeypatch
// every window method they touch (saving + restoring around each test) and
// feed a fake LanguageClient, so the full detect → confirm → apply flow runs
// with NO LSP host and NO real dialogs. The apply branch of removal is driven
// through the cancel/empty/error paths so no real `dotnet` is spawned.

/** A captured `showXxxMessage` invocation: the message plus modal-ness. */
interface MsgCall {
  readonly message: string;
  readonly modal: boolean;
}

/** A stub dialog: receives the message + options/items, resolves to a choice. */
type StubDialog = (message: string, ...rest: unknown[]) => Promise<string | undefined>;

/** Mutable view of the `vscode.window` methods these commands invoke. */
interface MutableWindow {
  showWarningMessage: StubDialog;
  showInformationMessage: StubDialog;
  showErrorMessage: StubDialog;
}

/** Records of everything the SUT showed during a single test. */
interface WindowSpy {
  readonly warnings: MsgCall[];
  readonly infos: MsgCall[];
  readonly errors: MsgCall[];
}

const mutableWindow = vscode.window as unknown as MutableWindow;

interface SavedWindow {
  readonly showWarningMessage: StubDialog;
  readonly showInformationMessage: StubDialog;
  readonly showErrorMessage: StubDialog;
}

/** Snapshot the real window methods so teardown can restore them. */
function saveWindow(): SavedWindow {
  return {
    showWarningMessage: mutableWindow.showWarningMessage,
    showInformationMessage: mutableWindow.showInformationMessage,
    showErrorMessage: mutableWindow.showErrorMessage,
  };
}

/** Restore the real window methods captured by {@link saveWindow}. */
function restoreWindow(saved: SavedWindow): void {
  mutableWindow.showWarningMessage = saved.showWarningMessage;
  mutableWindow.showInformationMessage = saved.showInformationMessage;
  mutableWindow.showErrorMessage = saved.showErrorMessage;
}

/** Was this `showXxxMessage(message, options?, ...items)` call modal? */
function isModalCall(args: unknown[]): boolean {
  const options = args[1];
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { modal?: boolean }).modal === true
  );
}

/**
 * Install spies on every window dialog. `warningAnswer` is what a modal
 * warning resolves to (drives the confirm/cancel branches).
 */
function installWindowSpy(warningAnswer: string | undefined): WindowSpy {
  const spy: WindowSpy = { warnings: [], infos: [], errors: [] };
  mutableWindow.showWarningMessage = (message: string, ...rest: unknown[]) => {
    spy.warnings.push({ message, modal: isModalCall([message, ...rest]) });
    return Promise.resolve(warningAnswer);
  };
  mutableWindow.showInformationMessage = (message: string, ...rest: unknown[]) => {
    spy.infos.push({ message, modal: isModalCall([message, ...rest]) });
    return Promise.resolve(undefined);
  };
  mutableWindow.showErrorMessage = (message: string, ...rest: unknown[]) => {
    spy.errors.push({ message, modal: isModalCall([message, ...rest]) });
    return Promise.resolve(undefined);
  };
  return spy;
}

/** A LanguageClient stub whose sendRequest returns `responses[method]`. */
function lspReturning(responses: Record<string, unknown>): LanguageClient {
  return {
    sendRequest: (method: string): Promise<unknown> => Promise.resolve(responses[method]),
  } as unknown as LanguageClient;
}

/** A LanguageClient stub whose sendRequest always rejects. */
function lspRejecting(error: unknown): LanguageClient {
  return {
    sendRequest: (): Promise<unknown> =>
      Promise.reject(error instanceof Error ? error : new Error(String(error))),
  } as unknown as LanguageClient;
}

/** A LanguageClient stub recording every (method, payload) it receives. */
function lspRecording(
  log: { method: string; payload: unknown }[],
  responses: Record<string, unknown>,
): LanguageClient {
  return {
    sendRequest: (method: string, payload: unknown): Promise<unknown> => {
      log.push({ method, payload });
      return Promise.resolve(responses[method]);
    },
  } as unknown as LanguageClient;
}

/** A refresh callback that counts invocations. */
function countingRefresh(): { fn: () => Promise<void>; count: () => number } {
  let calls = 0;
  return {
    fn: () => {
      calls++;
      return Promise.resolve();
    },
    count: () => calls,
  };
}

// ── removeUnusedPackages() [PKG-UNUSED-UI] ─────────────────────────

suite('package-maintenance — removeUnusedPackages()', () => {
  let saved: SavedWindow;
  setup(() => {
    saved = saveWindow();
  });
  teardown(() => {
    restoreWindow(saved);
  });

  test('with no LSP client: warns and never refreshes', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    await removeUnusedPackages(projectNode('/repo/A/A.csproj'), undefined, refresh.fn);

    assert.strictEqual(spy.warnings.length, 1, 'exactly one warning shown');
    assert.strictEqual(spy.warnings[0]?.message, 'SharpLsp server not available.');
    assert.strictEqual(spy.infos.length, 0);
    assert.strictEqual(spy.errors.length, 0);
    assert.strictEqual(refresh.count(), 0, 'no refresh without a client');
  });

  test('with no project under the node: warns "No project selected."', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    // A symbol node carries no project path -> collectProjectPaths is empty.
    await removeUnusedPackages(node({ contextValue: 'symbol' }), lspReturning({}), refresh.fn);

    assert.strictEqual(spy.warnings.length, 1);
    assert.strictEqual(spy.warnings[0]?.message, 'No project selected.');
    assert.strictEqual(refresh.count(), 0);
  });

  test('undefined node also warns "No project selected."', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    await removeUnusedPackages(undefined, lspReturning({}), refresh.fn);

    assert.strictEqual(spy.warnings.length, 1);
    assert.strictEqual(spy.warnings[0]?.message, 'No project selected.');
  });

  test('no unused packages found: shows info and does not refresh', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    const lsp = lspReturning({
      'sharplsp/nuget/unused': { projectPath: '/repo/A/A.csproj', unused: [] },
    });
    await removeUnusedPackages(projectNode('/repo/A/A.csproj'), lsp, refresh.fn);

    assert.strictEqual(spy.warnings.length, 0, 'no confirmation when nothing to remove');
    assert.strictEqual(spy.infos.length, 1);
    assert.strictEqual(spy.infos[0]?.message, 'No unused packages found.');
    assert.strictEqual(refresh.count(), 0);
  });

  test('a request that throws is swallowed -> treated as no findings', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    await removeUnusedPackages(
      projectNode('/repo/A/A.csproj'),
      lspRejecting(new Error('boom')),
      refresh.fn,
    );

    // detectUnused catches the error and returns undefined -> total === 0.
    assert.strictEqual(spy.infos.length, 1);
    assert.strictEqual(spy.infos[0]?.message, 'No unused packages found.');
    assert.strictEqual(spy.errors.length, 0, 'errors are logged, not surfaced as dialogs');
    assert.strictEqual(refresh.count(), 0);
  });

  test('findings present but user cancels the modal: nothing removed, no refresh', async () => {
    const spy = installWindowSpy(undefined); // modal returns undefined => cancel
    const refresh = countingRefresh();
    const lsp = lspReturning({
      'sharplsp/nuget/unused': {
        projectPath: '/repo/A/A.csproj',
        unused: [
          { id: 'Newtonsoft.Json', version: '13.0.0' },
          { id: 'Serilog', version: '3.1.0' },
        ],
      },
    });
    await removeUnusedPackages(projectNode('/repo/A/A.csproj'), lsp, refresh.fn);

    assert.strictEqual(spy.warnings.length, 1, 'the confirmation modal is shown');
    const confirm = spy.warnings[0];
    assert.ok(confirm);
    assert.strictEqual(confirm.modal, true, 'confirmation is modal');
    assert.ok(confirm.message.startsWith('Remove 2 unused package(s)?'), confirm.message);
    assert.ok(confirm.message.includes('A.csproj:'), 'lists the project basename');
    assert.ok(confirm.message.includes('Newtonsoft.Json'), 'lists each package id');
    assert.ok(confirm.message.includes('Serilog'));
    assert.strictEqual(spy.infos.length, 0, 'no success info on cancel');
    assert.strictEqual(spy.errors.length, 0);
    assert.strictEqual(refresh.count(), 0, 'cancel must not refresh');
  });

  test('aggregates findings across multiple projects in the summary', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    const log: { method: string; payload: unknown }[] = [];
    // A solution over two projects; both report a single unused package.
    const sln = solutionNode('/repo/My.sln', [
      projectNode('/repo/A/A.csproj'),
      projectNode('/repo/B/B.fsproj'),
    ]);
    const lsp = lspRecording(log, {
      'sharplsp/nuget/unused': { unused: [{ id: 'Moq', version: '4.20.0' }] },
    });
    await removeUnusedPackages(sln, lsp, refresh.fn);

    // One request per project path.
    assert.strictEqual(log.length, 2, 'one nuget/unused request per project');
    assert.deepStrictEqual(
      log.map((entry) => entry.method),
      ['sharplsp/nuget/unused', 'sharplsp/nuget/unused'],
    );
    assert.deepStrictEqual(log[0]?.payload, { projectPath: '/repo/A/A.csproj' });
    assert.deepStrictEqual(log[1]?.payload, { projectPath: '/repo/B/B.fsproj' });

    const confirm = spy.warnings[0];
    assert.ok(confirm);
    assert.ok(confirm.message.startsWith('Remove 2 unused package(s)?'), confirm.message);
    assert.ok(confirm.message.includes('A.csproj: Moq'));
    assert.ok(confirm.message.includes('B.fsproj: Moq'));
  });

  test('apply path against a temp project removes/attempts and refreshes once', async function () {
    this.timeout(30_000);
    const spy = installWindowSpy('Remove'); // confirm the modal
    const refresh = countingRefresh();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-rm-'));
    try {
      const projDir = path.join(dir, 'App');
      fs.mkdirSync(projDir, { recursive: true });
      const projectPath = path.join(projDir, 'App.csproj');
      fs.writeFileSync(
        projectPath,
        '<Project Sdk="Microsoft.NET.Sdk">\n' +
          '  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>\n' +
          '  <ItemGroup><PackageReference Include="Ghost.Package" Version="1.0.0" /></ItemGroup>\n' +
          '</Project>\n',
      );
      const lsp = lspReturning({
        'sharplsp/nuget/unused': {
          projectPath,
          unused: [{ id: 'Ghost.Package', version: '1.0.0' }],
        },
      });

      await removeUnusedPackages(projectNode(projectPath), lsp, refresh.fn);

      // Regardless of whether the real `dotnet package remove` succeeds or
      // fails in this environment, the SUT must: show the modal, refresh
      // exactly once, and surface exactly one terminal info OR error message.
      assert.strictEqual(spy.warnings.length, 1, 'the confirmation modal is shown');
      assert.strictEqual(spy.warnings[0]?.modal, true);
      assert.strictEqual(refresh.count(), 1, 'apply path always refreshes once');
      const terminal = spy.infos.length + spy.errors.length;
      assert.strictEqual(terminal, 1, 'exactly one terminal message after apply');
      if (spy.errors.length === 1) {
        assert.ok(spy.errors[0]?.message.includes('Ghost.Package'), spy.errors[0]?.message);
      } else {
        assert.ok(
          spy.infos[0]?.message.startsWith('Removed 1 unused package(s).'),
          spy.infos[0]?.message,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── consolidatePackages() [PKG-CONSOLIDATE-UI] ─────────────────────

suite('package-maintenance — consolidatePackages()', () => {
  let saved: SavedWindow;
  setup(() => {
    saved = saveWindow();
  });
  teardown(() => {
    restoreWindow(saved);
  });

  test('with no LSP client: warns and never refreshes', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    await consolidatePackages(solutionNode('/repo/My.sln', []), undefined, refresh.fn);

    assert.strictEqual(spy.warnings.length, 1);
    assert.strictEqual(spy.warnings[0]?.message, 'SharpLsp server not available.');
    assert.strictEqual(refresh.count(), 0);
  });

  test('node without a projectFilePath: warns "No solution selected."', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    // A folder node has no projectFilePath.
    await consolidatePackages(node({ contextValue: 'folder' }), lspReturning({}), refresh.fn);

    assert.strictEqual(spy.warnings.length, 1);
    assert.strictEqual(spy.warnings[0]?.message, 'No solution selected.');
    assert.strictEqual(refresh.count(), 0);
  });

  test('undefined node: warns "No solution selected."', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    await consolidatePackages(undefined, lspReturning({}), refresh.fn);

    assert.strictEqual(spy.warnings.length, 1);
    assert.strictEqual(spy.warnings[0]?.message, 'No solution selected.');
  });

  test('dry-run preview rejects: error surfaced, no refresh', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    await consolidatePackages(
      solutionNode('/repo/My.sln', []),
      lspRejecting(new Error('scan failed')),
      refresh.fn,
    );

    // requestConsolidate catches and shows an error, then returns undefined.
    assert.strictEqual(spy.errors.length, 1);
    assert.ok(spy.errors[0]?.message.includes('Consolidate failed:'), spy.errors[0]?.message);
    assert.ok(spy.errors[0]?.message.includes('scan failed'));
    assert.strictEqual(spy.infos.length, 0);
    assert.strictEqual(refresh.count(), 0);
  });

  test('preview with no moves: shows the server message and stops', async () => {
    const spy = installWindowSpy(undefined);
    const refresh = countingRefresh();
    const lsp = lspReturning({
      'sharplsp/nuget/consolidate': {
        moved: [],
        modifiedFiles: [],
        message: 'No shared packages to consolidate.',
      },
    });
    await consolidatePackages(solutionNode('/repo/My.sln', []), lsp, refresh.fn);

    assert.strictEqual(spy.infos.length, 1);
    assert.strictEqual(spy.infos[0]?.message, 'No shared packages to consolidate.');
    assert.strictEqual(spy.warnings.length, 0, 'no confirmation when nothing to move');
    assert.strictEqual(refresh.count(), 0);
  });

  test('preview with moves but user cancels the modal: no apply, no refresh', async () => {
    const spy = installWindowSpy(undefined); // modal returns undefined => cancel
    const refresh = countingRefresh();
    const log: { method: string; payload: unknown }[] = [];
    const lsp = lspRecording(log, {
      'sharplsp/nuget/consolidate': {
        moved: [
          {
            id: 'Serilog',
            version: '3.1.0',
            fromProjects: ['/repo/A/A.csproj', '/repo/B/B.csproj'],
          },
          { id: 'Moq', version: '', fromProjects: ['/repo/A/A.csproj'] },
        ],
        modifiedFiles: [],
        message: 'apply message (unused on cancel)',
      },
    });
    await consolidatePackages(solutionNode('/repo/My.sln', []), lsp, refresh.fn);

    // Only the dry-run scan should have run (apply is gated behind confirm).
    assert.strictEqual(log.length, 1, 'only the dry-run scan request fires on cancel');
    assert.strictEqual(log[0]?.method, 'sharplsp/nuget/consolidate');
    assert.deepStrictEqual(log[0]?.payload, { solutionPath: '/repo/My.sln', dryRun: true });

    const confirm = spy.warnings[0];
    assert.ok(confirm);
    assert.strictEqual(confirm.modal, true);
    assert.ok(
      confirm.message.startsWith('Move 2 shared package(s) into Directory.Build.props?'),
      confirm.message,
    );
    // Versioned and version-less entries render distinctly.
    assert.ok(confirm.message.includes('Serilog 3.1.0 (2 projects)'), confirm.message);
    assert.ok(confirm.message.includes('Moq (1 projects)'), confirm.message);
    assert.strictEqual(spy.infos.length, 0, 'no success info on cancel');
    assert.strictEqual(refresh.count(), 0);
  });

  test('confirm path runs apply, refreshes once, shows the apply message', async () => {
    const spy = installWindowSpy('Move'); // confirm the modal
    const refresh = countingRefresh();
    const log: { method: string; payload: unknown }[] = [];
    // Both dry-run and apply share this fixture; dryRun toggles in the payload.
    const lsp = lspRecording(log, {
      'sharplsp/nuget/consolidate': {
        moved: [{ id: 'Serilog', version: '3.1.0', fromProjects: ['/repo/A/A.csproj'] }],
        propsFile: '/repo/Directory.Build.props',
        modifiedFiles: ['/repo/Directory.Build.props', '/repo/A/A.csproj'],
        message: 'Moved 1 package into Directory.Build.props.',
      },
    });
    await consolidatePackages(solutionNode('/repo/My.sln', []), lsp, refresh.fn);

    // Two requests: dry-run scan then the real apply.
    assert.strictEqual(log.length, 2, 'scan then apply');
    assert.deepStrictEqual(log[0]?.payload, { solutionPath: '/repo/My.sln', dryRun: true });
    assert.deepStrictEqual(log[1]?.payload, { solutionPath: '/repo/My.sln', dryRun: false });

    assert.strictEqual(spy.warnings.length, 1, 'one confirmation modal');
    assert.strictEqual(refresh.count(), 1, 'apply refreshes exactly once');
    assert.strictEqual(spy.infos.length, 1);
    assert.strictEqual(spy.infos[0]?.message, 'Moved 1 package into Directory.Build.props.');
  });

  test('apply request rejects: error surfaced, no refresh, no success info', async () => {
    const spy = installWindowSpy('Move'); // confirm the modal
    const refresh = countingRefresh();
    let call = 0;
    // First call (dry-run) resolves with moves; second call (apply) rejects.
    const lsp = {
      sendRequest: (_method: string, payload: unknown): Promise<unknown> => {
        call++;
        const dryRun = (payload as { dryRun: boolean }).dryRun;
        if (dryRun) {
          return Promise.resolve({
            moved: [{ id: 'Serilog', version: '3.1.0', fromProjects: ['/repo/A/A.csproj'] }],
            modifiedFiles: [],
            message: 'scan',
          });
        }
        return Promise.reject(new Error('apply failed'));
      },
    } as unknown as LanguageClient;

    await consolidatePackages(solutionNode('/repo/My.sln', []), lsp, refresh.fn);

    assert.strictEqual(call, 2, 'both scan and apply were attempted');
    assert.strictEqual(spy.warnings.length, 1, 'the confirmation modal was shown');
    assert.strictEqual(spy.errors.length, 1, 'the apply failure is surfaced');
    assert.ok(spy.errors[0]?.message.includes('Consolidate failed:'), spy.errors[0]?.message);
    assert.ok(spy.errors[0]?.message.includes('apply failed'));
    assert.strictEqual(spy.infos.length, 0, 'no success info after a failed apply');
    assert.strictEqual(refresh.count(), 0, 'failed apply must not refresh');
  });
});
