// Implements [PKG-UNUSED-UI]: pins the pure `collectProjectPaths` traversal that
// feeds both the "Remove Unused Packages" and "Consolidate Packages" flows. The
// async dotnet/quick-pick driven commands are out of scope for pure-logic tests;
// only the node → project-path collector is directly callable without an LSP host.
import * as assert from 'node:assert/strict';
import { TreeItemCollapsibleState } from 'vscode';
import { ExplorerNode } from '../../tree.js';
import { collectProjectPaths } from '../../package-maintenance.js';

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
      assert.deepStrictEqual(result, [
        '/repo/A/A.csproj',
        '/repo/B/B.csproj',
        '/repo/C/C.fsproj',
      ]);
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
      assert.deepStrictEqual(result, [
        '/repo/Keep/Keep.csproj',
        '/repo/AlsoKeep/AlsoKeep.fsproj',
      ]);
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
      assert.deepStrictEqual(result, [
        '/repo/Outer/Outer.csproj',
        '/repo/Inner/Inner.csproj',
      ]);
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
          children: [
            projectNode('/repo/P2/P2.csproj'),
            projectNode('/repo/P3/P3.fsproj'),
          ],
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
          children: [
            projectNode('/repo/A/A.csproj'),
            projectNode('/repo/C/C.csproj'),
          ],
        }),
      ]);
      const result = collectProjectPaths(sln);
      assert.deepStrictEqual(result, [
        '/repo/A/A.csproj',
        '/repo/B/B.csproj',
        '/repo/C/C.csproj',
      ]);
      assert.strictEqual(result.length, 3);
    });

    test('a self-project that also duplicates a child is collected once', () => {
      const outer = projectNode('/repo/Shared.csproj', [
        projectNode('/repo/Shared.csproj'),
      ]);
      const result = collectProjectPaths(outer);
      assert.deepStrictEqual(result, ['/repo/Shared.csproj']);
      assert.strictEqual(result.length, 1);
    });
  });

  // ── Edge-case path strings ──────────────────────────────────────
  suite('edge-case path strings', () => {
    test("an empty-string projectFilePath IS collected (it is !== undefined)", () => {
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
      assert.deepStrictEqual(second, ['/repo/A/A.csproj'], 'mutating one must not affect the other');
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
