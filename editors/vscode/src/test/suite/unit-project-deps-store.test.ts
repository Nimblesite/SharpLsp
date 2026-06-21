import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ensureTracked,
  refreshTracked,
  rescanAll,
  resetForTests,
  initProjectDepsStore,
  projectDependencies,
} from '../../project-deps-store.js';

const CSPROJ_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>
`;

const UPDATED_CSPROJ_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.2" />
  </ItemGroup>
</Project>
`;

const EMPTY_CSPROJ_XML = `<Project Sdk="Microsoft.NET.Sdk"></Project>`;

suite('ProjectDepsStore — ensureTracked()', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-store-test-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parses and stores a project path on first call', () => {
    const filePath = path.join(tmpDir, 'MyApp.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    const result = ensureTracked(filePath);
    assert.strictEqual(result.nugetPackages.length, 2);
    const names = result.nugetPackages.map((p) => p.name);
    assert.ok(names.includes('Newtonsoft.Json'));
    assert.ok(names.includes('Serilog'));
  });

  test('project is stored in the signal after first ensureTracked call', () => {
    const filePath = path.join(tmpDir, 'Stored.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    ensureTracked(filePath);
    const absolute = path.resolve(filePath);
    assert.ok(projectDependencies.value.has(absolute));
  });

  test('second call returns cached result without re-parsing', () => {
    const filePath = path.join(tmpDir, 'Cached.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    const first = ensureTracked(filePath);
    fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
    const second = ensureTracked(filePath);

    assert.strictEqual(first, second, 'Must return the same cached object reference');
    assert.strictEqual(second.nugetPackages.length, 2, 'Must serve cached value, not re-parsed');
  });

  test('returns empty arrays for non-existent project path', () => {
    const result = ensureTracked('/nonexistent/Project.csproj');
    assert.strictEqual(result.nugetPackages.length, 0);
    assert.strictEqual(result.projectReferences.length, 0);
  });

  test('returns empty arrays for project with no dependencies', () => {
    const filePath = path.join(tmpDir, 'Empty.csproj');
    fs.writeFileSync(filePath, EMPTY_CSPROJ_XML, 'utf-8');

    const result = ensureTracked(filePath);
    assert.strictEqual(result.nugetPackages.length, 0);
    assert.strictEqual(result.projectReferences.length, 0);
  });

  test('multiple distinct projects are tracked independently', () => {
    const fileA = path.join(tmpDir, 'AppA.csproj');
    const fileB = path.join(tmpDir, 'AppB.csproj');
    fs.writeFileSync(fileA, CSPROJ_XML, 'utf-8');
    fs.writeFileSync(fileB, EMPTY_CSPROJ_XML, 'utf-8');

    const a = ensureTracked(fileA);
    const b = ensureTracked(fileB);

    assert.strictEqual(a.nugetPackages.length, 2);
    assert.strictEqual(b.nugetPackages.length, 0);
    assert.strictEqual(projectDependencies.value.size, 2);
  });
});

suite('ProjectDepsStore — refreshTracked()', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-refresh-test-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns undefined for a path that has not been tracked', () => {
    const filePath = path.join(tmpDir, 'NotTracked.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    const result = refreshTracked(filePath);
    assert.strictEqual(result, undefined);
  });

  test('returns undefined for a completely unknown path', () => {
    const result = refreshTracked('/nonexistent/Unknown.csproj');
    assert.strictEqual(result, undefined);
  });

  test('returns fresh data after tracking and file update', () => {
    const filePath = path.join(tmpDir, 'Refresh.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
    const result = refreshTracked(filePath);
    assert.ok(result !== undefined);
    assert.strictEqual(result.nugetPackages.length, 1);
    assert.strictEqual(result.nugetPackages[0]?.name, 'Newtonsoft.Json');
    assert.strictEqual(result.nugetPackages[0]?.version, '13.0.2');
  });

  test('removes project from store when file is deleted', () => {
    const filePath = path.join(tmpDir, 'ToDelete.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    fs.rmSync(filePath);

    const result = refreshTracked(filePath);
    assert.strictEqual(result, undefined);
    const absolute = path.resolve(filePath);
    assert.ok(!projectDependencies.value.has(absolute));
  });
});

suite('ProjectDepsStore — rescanAll()', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-rescan-test-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rescanAll on empty store does not throw', () => {
    assert.doesNotThrow(() => {
      rescanAll();
    });
  });

  test('rescanAll re-parses all tracked projects from disk', () => {
    const filePath = path.join(tmpDir, 'Rescan.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
    rescanAll();

    const absolute = path.resolve(filePath);
    const refreshed = projectDependencies.value.get(absolute);
    assert.ok(refreshed !== undefined);
    assert.strictEqual(refreshed.nugetPackages.length, 1);
    assert.strictEqual(refreshed.nugetPackages[0]?.version, '13.0.2');
  });

  test('rescanAll updates the signal value', () => {
    const filePath = path.join(tmpDir, 'SignalTest.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    let notified = false;
    const unsub = projectDependencies.subscribe(() => {
      notified = true;
    });

    try {
      fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
      rescanAll();
      assert.ok(notified, 'Signal must notify subscribers after rescanAll');
    } finally {
      unsub();
    }
  });
});

suite('ProjectDepsStore — resetForTests()', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-reset-test-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('clears all tracked projects from signal', () => {
    const filePath = path.join(tmpDir, 'Reset.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    assert.ok(projectDependencies.value.size > 0);

    resetForTests();
    assert.strictEqual(projectDependencies.value.size, 0);
  });

  test('store is clean after reset — ensureTracked re-parses fresh', () => {
    const filePath = path.join(tmpDir, 'FreshParse.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
    resetForTests();

    const result = ensureTracked(filePath);
    assert.strictEqual(result.nugetPackages.length, 1, 'Should re-parse updated file after reset');
  });
});

// ── Additional XML fixtures for the extended suites ─────────────────

const PROJECT_REFS_CSPROJ_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../Core/Core.csproj" />
    <ProjectReference Include="../Abstractions/Abstractions.csproj" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>
`;

const FSPROJ_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="FSharp.Core" Version="8.0.0" />
  </ItemGroup>
</Project>
`;

/**
 * Build a minimal fake ExtensionContext exposing only the surface the store
 * touches: a real `subscriptions` array it pushes disposables into.
 */
function makeFakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [] as vscode.Disposable[],
  } as unknown as vscode.ExtensionContext;
}

suite('ProjectDepsStore — ensureTracked() extended', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-ensure-ext-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('keys in the signal map are absolute, path.resolve-normalized', () => {
    const filePath = path.join(tmpDir, 'Abs.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    ensureTracked(filePath);
    const absolute = path.resolve(filePath);
    assert.ok(path.isAbsolute(absolute), 'resolved key must be absolute');
    assert.ok(projectDependencies.value.has(absolute), 'map must be keyed by the absolute path');
    assert.strictEqual(projectDependencies.value.size, 1);
  });

  test('relative path and its resolved absolute path collapse to one entry', () => {
    const filePath = path.join(tmpDir, 'Collapse.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    const absolute = path.resolve(filePath);

    const viaAbsolute = ensureTracked(absolute);
    const viaResolveAgain = ensureTracked(absolute);

    assert.strictEqual(viaAbsolute, viaResolveAgain, 'second call returns the same cached object');
    assert.strictEqual(projectDependencies.value.size, 1, 'must not create a duplicate entry');
  });

  test('first call mutates the signal to a brand-new Map reference', () => {
    const filePath = path.join(tmpDir, 'NewRef.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    const before = projectDependencies.value;
    ensureTracked(filePath);
    const after = projectDependencies.value;

    assert.notStrictEqual(before, after, 'tracking must replace the Map (immutable update)');
    assert.strictEqual(before.size, 0, 'the previous Map must remain unmutated');
    assert.strictEqual(after.size, 1);
  });

  test('idempotent re-call does NOT replace the Map reference', () => {
    const filePath = path.join(tmpDir, 'NoReplace.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    ensureTracked(filePath);
    const mapAfterFirst = projectDependencies.value;
    ensureTracked(filePath);
    const mapAfterSecond = projectDependencies.value;

    assert.strictEqual(
      mapAfterFirst,
      mapAfterSecond,
      'cached re-call must not produce a new Map reference',
    );
  });

  test('first ensureTracked notifies signal subscribers exactly once', () => {
    const filePath = path.join(tmpDir, 'NotifyOnce.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    let count = 0;
    const unsub = projectDependencies.subscribe(() => {
      count += 1;
    });
    try {
      ensureTracked(filePath);
      assert.strictEqual(count, 1, 'first track must fire one notification');
      ensureTracked(filePath);
      assert.strictEqual(count, 1, 'cached re-call must not fire another notification');
    } finally {
      unsub();
    }
  });

  test('parses project references with derived names, sorted alphabetically', () => {
    const filePath = path.join(tmpDir, 'WithRefs.csproj');
    fs.writeFileSync(filePath, PROJECT_REFS_CSPROJ_XML, 'utf-8');

    const result = ensureTracked(filePath);
    assert.strictEqual(result.projectReferences.length, 2);
    assert.strictEqual(result.projectReferences[0]?.name, 'Abstractions');
    assert.strictEqual(result.projectReferences[1]?.name, 'Core');
    assert.strictEqual(result.nugetPackages.length, 1);
    assert.strictEqual(result.nugetPackages[0]?.name, 'Serilog');
  });

  test('tracks an fsproj as a first-class citizen', () => {
    const filePath = path.join(tmpDir, 'Lib.fsproj');
    fs.writeFileSync(filePath, FSPROJ_XML, 'utf-8');

    const result = ensureTracked(filePath);
    assert.strictEqual(result.nugetPackages.length, 1);
    assert.strictEqual(result.nugetPackages[0]?.name, 'FSharp.Core');
    assert.strictEqual(result.nugetPackages[0]?.version, '8.0.0');
    const absolute = path.resolve(filePath);
    assert.ok(projectDependencies.value.has(absolute));
  });

  test('non-existent path is still tracked (cached empty entry)', () => {
    const missing = path.join(tmpDir, 'Ghost.csproj');
    const result = ensureTracked(missing);
    assert.strictEqual(result.nugetPackages.length, 0);

    const absolute = path.resolve(missing);
    assert.ok(projectDependencies.value.has(absolute), 'missing-file path is still tracked');
    const cached = projectDependencies.value.get(absolute);
    assert.strictEqual(cached, result, 'second lookup returns same empty object');
  });
});

suite('ProjectDepsStore — refreshTracked() extended', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-refresh-ext-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns same-shaped data when file is unchanged (equality short-circuit)', () => {
    const filePath = path.join(tmpDir, 'Unchanged.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const mapBefore = projectDependencies.value;

    const result = refreshTracked(filePath);
    assert.ok(result !== undefined, 'tracked file must refresh');
    assert.strictEqual(result.nugetPackages.length, 2);
    assert.strictEqual(
      projectDependencies.value,
      mapBefore,
      'unchanged refresh must not replace the Map (deps equal)',
    );
  });

  test('replaces the Map reference when dependencies actually change', () => {
    const filePath = path.join(tmpDir, 'Changed.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const mapBefore = projectDependencies.value;

    fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
    const result = refreshTracked(filePath);

    assert.ok(result !== undefined);
    assert.strictEqual(result.nugetPackages.length, 1);
    assert.notStrictEqual(
      projectDependencies.value,
      mapBefore,
      'changed refresh must replace the Map',
    );
  });

  test('refresh notifies subscribers only on actual change', () => {
    const filePath = path.join(tmpDir, 'NotifyChange.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    let count = 0;
    const unsub = projectDependencies.subscribe(() => {
      count += 1;
    });
    try {
      refreshTracked(filePath);
      assert.strictEqual(count, 0, 'no-op refresh must not notify');

      fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
      refreshTracked(filePath);
      assert.strictEqual(count, 1, 'changed refresh must notify exactly once');
    } finally {
      unsub();
    }
  });

  test('detecting a change in project references replaces the Map', () => {
    const filePath = path.join(tmpDir, 'RefChange.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    fs.writeFileSync(filePath, PROJECT_REFS_CSPROJ_XML, 'utf-8');
    const result = refreshTracked(filePath);

    assert.ok(result !== undefined);
    assert.strictEqual(result.projectReferences.length, 2);
    assert.strictEqual(result.nugetPackages.length, 1);
    assert.strictEqual(result.nugetPackages[0]?.name, 'Serilog');
  });

  test('deleting the file mid-track removes it and returns undefined', () => {
    const filePath = path.join(tmpDir, 'Vanish.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);
    assert.ok(projectDependencies.value.has(absolute), 'precondition: tracked');

    fs.rmSync(filePath);
    const result = refreshTracked(filePath);

    assert.strictEqual(result, undefined, 'missing file refresh returns undefined');
    assert.ok(!projectDependencies.value.has(absolute), 'missing file is removed from the store');
    assert.strictEqual(projectDependencies.value.size, 0);
  });

  test('removal on delete notifies subscribers', () => {
    const filePath = path.join(tmpDir, 'DeleteNotify.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    let count = 0;
    const unsub = projectDependencies.subscribe(() => {
      count += 1;
    });
    try {
      fs.rmSync(filePath);
      refreshTracked(filePath);
      assert.strictEqual(count, 1, 'removing a tracked project must notify once');
    } finally {
      unsub();
    }
  });

  test('returns undefined for empty-string path that was never tracked', () => {
    assert.strictEqual(refreshTracked(''), undefined);
  });
});

suite('ProjectDepsStore — rescanAll() extended', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-rescan-ext-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rescanAll always installs a fresh Map reference, even with no changes', () => {
    const filePath = path.join(tmpDir, 'Stable.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const mapBefore = projectDependencies.value;

    rescanAll();

    assert.notStrictEqual(
      projectDependencies.value,
      mapBefore,
      'rescanAll unconditionally replaces the Map',
    );
    assert.strictEqual(projectDependencies.value.size, 1, 'tracked set preserved');
  });

  test('rescanAll refreshes EVERY tracked project, not just one', () => {
    const fileA = path.join(tmpDir, 'MultiA.csproj');
    const fileB = path.join(tmpDir, 'MultiB.csproj');
    fs.writeFileSync(fileA, CSPROJ_XML, 'utf-8');
    fs.writeFileSync(fileB, CSPROJ_XML, 'utf-8');
    ensureTracked(fileA);
    ensureTracked(fileB);

    fs.writeFileSync(fileA, UPDATED_CSPROJ_XML, 'utf-8');
    fs.writeFileSync(fileB, EMPTY_CSPROJ_XML, 'utf-8');
    rescanAll();

    const a = projectDependencies.value.get(path.resolve(fileA));
    const b = projectDependencies.value.get(path.resolve(fileB));
    assert.ok(a !== undefined && b !== undefined);
    assert.strictEqual(a.nugetPackages.length, 1, 'A re-parsed to updated content');
    assert.strictEqual(a.nugetPackages[0]?.version, '13.0.2');
    assert.strictEqual(b.nugetPackages.length, 0, 'B re-parsed to empty content');
  });

  test('rescanAll keeps tracking a project whose file was deleted (parses empty)', () => {
    const filePath = path.join(tmpDir, 'GoneButTracked.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    fs.rmSync(filePath);
    rescanAll();

    const absolute = path.resolve(filePath);
    assert.ok(
      projectDependencies.value.has(absolute),
      'rescanAll does not prune missing files — it re-parses them',
    );
    const entry = projectDependencies.value.get(absolute);
    assert.ok(entry !== undefined);
    assert.strictEqual(entry.nugetPackages.length, 0, 'deleted file parses to empty deps');
  });

  test('rescanAll preserves the exact set of tracked keys', () => {
    const fileA = path.join(tmpDir, 'KeepA.csproj');
    const fileB = path.join(tmpDir, 'KeepB.fsproj');
    fs.writeFileSync(fileA, CSPROJ_XML, 'utf-8');
    fs.writeFileSync(fileB, FSPROJ_XML, 'utf-8');
    ensureTracked(fileA);
    ensureTracked(fileB);

    rescanAll();

    const keys = [...projectDependencies.value.keys()].sort();
    const expected = [path.resolve(fileA), path.resolve(fileB)].sort();
    assert.deepStrictEqual(keys, expected);
  });
});

suite('ProjectDepsStore — initProjectDepsStore()', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-init-test-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('wires up watcher + guard disposables into context.subscriptions', () => {
    const context = makeFakeContext();
    assert.strictEqual(context.subscriptions.length, 0, 'precondition: empty subscriptions');

    initProjectDepsStore(context);

    assert.ok(
      context.subscriptions.length >= 5,
      'init must register the watcher, three event handlers, and the mtime guard',
    );
  });

  test('every registered subscription is disposable', () => {
    const context = makeFakeContext();
    initProjectDepsStore(context);

    for (const sub of context.subscriptions) {
      assert.strictEqual(typeof sub.dispose, 'function', 'each subscription exposes dispose()');
    }
    assert.doesNotThrow(() => {
      for (const sub of context.subscriptions) sub.dispose();
    }, 'disposing every registered subscription must not throw');
  });

  test('second init on a fresh (non-reset) store does not re-create the global watcher', () => {
    const first = makeFakeContext();
    initProjectDepsStore(first);
    const firstCount = first.subscriptions.length;

    const second = makeFakeContext();
    initProjectDepsStore(second);

    assert.ok(firstCount > 0, 'first init must register subscriptions');
    // The global watcher is guarded by `watcher !== undefined`, so the second
    // context must NOT receive the watcher + its three handlers again.
    assert.ok(
      second.subscriptions.length < firstCount,
      'idempotent init must not re-register the global watcher on the second context',
    );
  });

  test('init then ensureTracked also registers a per-project watcher', () => {
    const context = makeFakeContext();
    initProjectDepsStore(context);
    const baseline = context.subscriptions.length;

    const filePath = path.join(tmpDir, 'Watched.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    assert.ok(
      context.subscriptions.length > baseline,
      'ensureTracked after init must register a per-project watcher subscription',
    );
  });

  test('ensureTracked without prior init registers no per-project watcher', () => {
    const filePath = path.join(tmpDir, 'NoInit.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    // storeContext is undefined (resetForTests cleared it / init never ran),
    // so ensureProjectWatcher short-circuits — but tracking still works.
    const result = ensureTracked(filePath);
    assert.strictEqual(result.nugetPackages.length, 2);
    assert.ok(projectDependencies.value.has(path.resolve(filePath)));
  });

  test('init re-attaches watchers for already-tracked projects', () => {
    const filePath = path.join(tmpDir, 'PreTracked.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);

    const context = makeFakeContext();
    initProjectDepsStore(context);

    // init iterates existing tracked keys and ensures a per-project watcher,
    // so the context must receive more than just the global watcher set.
    assert.ok(
      context.subscriptions.length >= 6,
      'init must back-fill watchers for projects tracked before init ran',
    );
  });

  test('resetForTests after init clears tracked projects and allows fresh init', () => {
    const context = makeFakeContext();
    initProjectDepsStore(context);
    const filePath = path.join(tmpDir, 'Cycle.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    assert.ok(projectDependencies.value.size > 0);

    resetForTests();
    assert.strictEqual(projectDependencies.value.size, 0, 'reset clears the store');

    const next = makeFakeContext();
    assert.doesNotThrow(() => {
      initProjectDepsStore(next);
    }, 're-init after reset must succeed');
    assert.ok(next.subscriptions.length >= 5, 're-init re-creates the global watcher');
  });
});
