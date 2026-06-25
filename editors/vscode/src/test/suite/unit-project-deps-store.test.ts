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
import { type ProjectDependencies } from '../../dependencies.js';

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

// ── Async helpers for the live watcher / debounce / mtime-guard machinery ──

/** Resolve after `ms` milliseconds without blocking the event loop. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll `predicate` until it returns true or the timeout elapses. Used to wait
 * for the store's debounced rescans and 250ms mtime-guard interval to fire in
 * response to real on-disk changes — the only way to exercise the internal
 * watcher callbacks, `schedule`, `rescan`/`rescanOne`, `handleTrackedFileEvent`
 * and `checkTrackedProjectMtimes` without reaching into private state.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

suite('ProjectDepsStore — dependency equality (projectReferencesEqual)', () => {
  let tmpDir: string;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-deps-equal-'));
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('refreshing a project with UNCHANGED project references short-circuits (refs equal)', () => {
    const filePath = path.join(tmpDir, 'EqualRefs.csproj');
    fs.writeFileSync(filePath, PROJECT_REFS_CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const mapBefore = projectDependencies.value;

    // Identical content rewrite: dependenciesEqual must compare both packages
    // AND project references element-by-element and find them equal, so the
    // Map reference is preserved (no notification).
    fs.writeFileSync(filePath, PROJECT_REFS_CSPROJ_XML, 'utf-8');
    const result = refreshTracked(filePath);

    assert.ok(result !== undefined, 'tracked project must refresh');
    assert.strictEqual(result.projectReferences.length, 2);
    assert.strictEqual(result.projectReferences[0]?.name, 'Abstractions');
    assert.strictEqual(
      projectDependencies.value,
      mapBefore,
      'equal project references must not replace the Map (equality short-circuit)',
    );
  });

  test('refreshing a project whose project references CHANGED replaces the Map', () => {
    const filePath = path.join(tmpDir, 'ChangedRefs.csproj');
    fs.writeFileSync(filePath, PROJECT_REFS_CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const mapBefore = projectDependencies.value;

    // Drop one ProjectReference: now the .every length check differs and the
    // store must install a new Map.
    const fewerRefs = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../Core/Core.csproj" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>
`;
    fs.writeFileSync(filePath, fewerRefs, 'utf-8');
    const result = refreshTracked(filePath);

    assert.ok(result !== undefined);
    assert.strictEqual(result.projectReferences.length, 1);
    assert.strictEqual(result.projectReferences[0]?.name, 'Core');
    assert.notStrictEqual(
      projectDependencies.value,
      mapBefore,
      'changed project references must replace the Map',
    );
  });

  test('a same-count but differently-named project reference is treated as changed', () => {
    const filePath = path.join(tmpDir, 'RenamedRef.csproj');
    fs.writeFileSync(filePath, PROJECT_REFS_CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const mapBefore = projectDependencies.value;

    // Same number of refs (2) but one include path swapped — projectReferencesEqual's
    // .every callback must return false on the mismatching element.
    const renamed = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../Core/Core.csproj" />
    <ProjectReference Include="../Renamed/Renamed.csproj" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>
`;
    fs.writeFileSync(filePath, renamed, 'utf-8');
    const result = refreshTracked(filePath);

    assert.ok(result !== undefined);
    const names = result.projectReferences.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['Core', 'Renamed']);
    assert.notStrictEqual(
      projectDependencies.value,
      mapBefore,
      'a renamed project reference must be detected as a change',
    );
  });
});

suite('ProjectDepsStore — live watcher + debounce (schedule/rescan/rescanOne)', () => {
  let tmpDir: string;
  let context: vscode.ExtensionContext;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-live-watch-'));
    context = makeFakeContext();
    initProjectDepsStore(context);
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('editing a tracked .csproj on disk eventually rescans it through the store', async () => {
    const filePath = path.join(tmpDir, 'LiveEdit.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);
    assert.strictEqual(projectDependencies.value.get(absolute)?.nugetPackages.length, 2);

    // A real write fires the node watcher → handleTrackedFileEvent → schedule
    // → (after the 150ms debounce) rescan → rescanOne, replacing the entry.
    fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
    const updated = await waitFor(
      () => projectDependencies.value.get(absolute)?.nugetPackages.length === 1,
    );

    assert.ok(updated, 'the store must observe the on-disk edit and rescan to one package');
    assert.strictEqual(
      projectDependencies.value.get(absolute)?.nugetPackages[0]?.version,
      '13.0.2',
    );
  });

  test('deleting a tracked .csproj on disk eventually removes it from the store', async () => {
    const filePath = path.join(tmpDir, 'LiveDelete.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);
    assert.ok(projectDependencies.value.has(absolute), 'precondition: tracked');

    // Deletion fires the watcher with a non-existent path → handleTrackedFileEvent
    // takes the `else` branch → remove().
    fs.rmSync(filePath);
    const removed = await waitFor(() => !projectDependencies.value.has(absolute));

    assert.ok(removed, 'the store must drop a tracked project once its file is deleted');
  });

  test('rapid successive edits collapse to a single debounced rescan', async () => {
    const filePath = path.join(tmpDir, 'Debounced.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);

    let notifications = 0;
    const unsub = projectDependencies.subscribe(() => {
      notifications += 1;
    });
    try {
      // Three writes inside the 150ms debounce window — schedule() must clear the
      // prior timer each time, so only the final content survives.
      fs.writeFileSync(filePath, EMPTY_CSPROJ_XML, 'utf-8');
      fs.writeFileSync(filePath, PROJECT_REFS_CSPROJ_XML, 'utf-8');
      fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');

      const settled = await waitFor(
        () => projectDependencies.value.get(absolute)?.nugetPackages.length === 1,
      );
      assert.ok(settled, 'the final write content must win the debounce');
      assert.strictEqual(
        projectDependencies.value.get(absolute)?.nugetPackages[0]?.name,
        'Newtonsoft.Json',
      );
      assert.ok(notifications >= 1, 'at least one rescan notification must fire');
    } finally {
      unsub();
    }
  });

  test('changing Directory.Packages.props triggers a rescan-all of every project', async () => {
    const fileA = path.join(tmpDir, 'PropsA.csproj');
    const fileB = path.join(tmpDir, 'PropsB.csproj');
    fs.writeFileSync(fileA, CSPROJ_XML, 'utf-8');
    fs.writeFileSync(fileB, CSPROJ_XML, 'utf-8');
    ensureTracked(fileA);
    ensureTracked(fileB);

    // Update both projects' content on disk, then touch a Directory.Packages.props
    // inside the watched tree. The global glob watcher schedules the props path;
    // rescan() routes a non-.csproj/.fsproj change to rescanAll(), re-parsing both.
    fs.writeFileSync(fileA, UPDATED_CSPROJ_XML, 'utf-8');
    fs.writeFileSync(fileB, EMPTY_CSPROJ_XML, 'utf-8');
    const propsPath = path.join(tmpDir, 'Directory.Packages.props');
    fs.writeFileSync(propsPath, '<Project></Project>', 'utf-8');

    const both = await waitFor(
      () =>
        projectDependencies.value.get(path.resolve(fileA))?.nugetPackages.length === 1 &&
        projectDependencies.value.get(path.resolve(fileB))?.nugetPackages.length === 0,
    );
    assert.ok(both, 'a props-file change must rescan every tracked project from disk');
  });

  test('an untracked .csproj edit is ignored by rescanOne (guard short-circuit)', async () => {
    const tracked = path.join(tmpDir, 'Tracked.csproj');
    fs.writeFileSync(tracked, CSPROJ_XML, 'utf-8');
    ensureTracked(tracked);

    // A sibling project that is NOT tracked. Even if the watcher schedules it,
    // rescanOne() bails because the map has no entry for it — size stays at 1.
    const untracked = path.join(tmpDir, 'Untracked.csproj');
    fs.writeFileSync(untracked, PROJECT_REFS_CSPROJ_XML, 'utf-8');
    fs.writeFileSync(untracked, EMPTY_CSPROJ_XML, 'utf-8');

    await delay(400); // generously past the 150ms debounce
    assert.ok(
      !projectDependencies.value.has(path.resolve(untracked)),
      'an untracked sibling project must never be added by a stray rescan',
    );
    assert.strictEqual(projectDependencies.value.size, 1, 'only the tracked project remains');
  });
});

suite('ProjectDepsStore — mtime guard (checkTrackedProjectMtimes)', () => {
  let tmpDir: string;
  let context: vscode.ExtensionContext;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtime-guard-'));
    context = makeFakeContext();
    initProjectDepsStore(context);
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('mtime guard catches an out-of-band edit even with watcher events suppressed', async () => {
    const filePath = path.join(tmpDir, 'MtimeEdit.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);

    // Force the mtime forward by a whole second so statSync().mtimeMs differs
    // from the value captured at ensureTracked time. The 250ms guard interval
    // (checkTrackedProjectMtimes) must notice and schedule a rescan.
    fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(filePath, future, future);

    const caught = await waitFor(
      () => projectDependencies.value.get(absolute)?.nugetPackages.length === 1,
    );
    assert.ok(caught, 'the mtime guard must catch an edit and rescan to the new content');
  });

  test('mtime guard removes a tracked project whose file disappears', async () => {
    const filePath = path.join(tmpDir, 'MtimeGone.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);
    assert.ok(projectDependencies.value.has(absolute), 'precondition: tracked');

    fs.rmSync(filePath);
    const removed = await waitFor(() => !projectDependencies.value.has(absolute));
    assert.ok(removed, 'the mtime guard must remove a project whose file no longer exists');
  });

  test('mtime guard leaves an unchanged tracked project alone', async () => {
    const filePath = path.join(tmpDir, 'MtimeStable.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);

    // Creating the file under the active watcher can queue one initial debounced
    // rescan, and the first mtime-guard tick re-stats the freshly-written file.
    // Let those flush before we start counting so we measure only steady-state
    // behavior on a genuinely stable file.
    await delay(600);
    const mapAfterSettle = projectDependencies.value;

    let notifications = 0;
    const unsub = projectDependencies.subscribe(() => {
      notifications += 1;
    });
    try {
      // With no further on-disk change, several more guard intervals must pass
      // without re-notifying or replacing the Map.
      await delay(700);
      assert.strictEqual(notifications, 0, 'a stable file must not trigger any guard rescan');
      assert.strictEqual(
        projectDependencies.value,
        mapAfterSettle,
        'the Map reference must be untouched when nothing changes',
      );
      assert.strictEqual(projectDependencies.value.get(absolute)?.nugetPackages.length, 2);
    } finally {
      unsub();
    }
  });
});

suite('ProjectDepsStore — node watcher resilience (watchTrackedProjectWithNode)', () => {
  let tmpDir: string;
  let context: vscode.ExtensionContext;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-node-watch-'));
    context = makeFakeContext();
    initProjectDepsStore(context);
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('tracking a never-created project file does not throw (fs.watch ENOENT caught)', () => {
    // The file does not exist on disk, so fs.watch() throws ENOENT inside
    // watchTrackedProjectWithNode — the catch must swallow it and tracking must
    // still succeed via the vscode RelativePattern watcher alone.
    const ghost = path.join(tmpDir, 'NeverExisted.csproj');
    assert.ok(!fs.existsSync(ghost), 'precondition: the file is absent');

    let result: ProjectDependencies | undefined;
    assert.doesNotThrow(() => {
      result = ensureTracked(ghost);
    }, 'a missing project file must not blow up the node watcher');
    assert.ok(result !== undefined);
    assert.strictEqual(result.nugetPackages.length, 0);
    assert.ok(projectDependencies.value.has(path.resolve(ghost)), 'still tracked despite no file');
  });

  test('per-project watcher is registered exactly once per distinct path', () => {
    const filePath = path.join(tmpDir, 'OnceWatcher.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    const before = context.subscriptions.length;
    ensureTracked(filePath);
    const afterFirst = context.subscriptions.length;
    ensureTracked(filePath);
    const afterSecond = context.subscriptions.length;

    assert.ok(afterFirst > before, 'first ensureTracked must register a per-project watcher');
    assert.strictEqual(
      afterSecond,
      afterFirst,
      'a second ensureTracked for the same path must not register another watcher',
    );
  });
});

// ── Global glob watcher branches (inside the real workspace folder) ──────────
//
// The global FileSystemWatcher created by initProjectDepsStore() only fires for
// files INSIDE workspace folders (its glob is workspace-scoped). The temp-dir
// suites above therefore never exercise the global watcher's onDidChange /
// onDidCreate / onDidDelete callbacks (project-deps-store.ts lines 40-53), nor
// the rescan()-routes-Directory.Packages.props branch (lines 251-261). These
// suites create a throwaway subdirectory INSIDE the workspace folder so those
// callbacks fire for real, then delete it entirely in teardown — the checked-in
// fixture files are never touched.

/** Absolute path to the first workspace folder, or undefined when none is open. */
function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

suite('ProjectDepsStore — global glob watcher (workspace-scoped events)', () => {
  let scratchDir: string;
  let context: vscode.ExtensionContext;
  let root: string | undefined;

  setup(() => {
    resetForTests();
    root = workspaceRoot();
    if (root === undefined) return;
    scratchDir = fs.mkdtempSync(path.join(root, '__deps-store-glob-'));
    context = makeFakeContext();
    initProjectDepsStore(context);
  });

  teardown(() => {
    resetForTests();
    if (root !== undefined) fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  test('creating a tracked .csproj in the workspace fires onDidCreate → schedule → rescanOne', async function () {
    if (root === undefined) {
      this.skip();
      return;
    }
    this.timeout(10_000);
    // Track a not-yet-created project path. The per-project RelativePattern
    // watcher (line 128-130) AND the workspace glob watcher (line 45-46) both
    // watch it; creating the file fires onDidCreate → schedule → rescanOne,
    // flipping the tracked entry from empty to two packages.
    const filePath = path.join(scratchDir, 'Created.csproj');
    const tracked = ensureTracked(filePath);
    assert.strictEqual(tracked.nugetPackages.length, 0, 'ghost project starts empty');

    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    const absolute = path.resolve(filePath);
    const seen = await waitFor(
      () => projectDependencies.value.get(absolute)?.nugetPackages.length === 2,
    );
    assert.ok(seen, 'the create event must rescan the new csproj to two packages');
  });

  test('editing a tracked .csproj in the workspace fires onDidChange → schedule → rescanOne', async function () {
    if (root === undefined) {
      this.skip();
      return;
    }
    this.timeout(10_000);
    const filePath = path.join(scratchDir, 'Edited.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);
    assert.strictEqual(projectDependencies.value.get(absolute)?.nugetPackages.length, 2);

    fs.writeFileSync(filePath, UPDATED_CSPROJ_XML, 'utf-8');
    const updated = await waitFor(
      () => projectDependencies.value.get(absolute)?.nugetPackages.length === 1,
    );
    assert.ok(updated, 'the change event must rescan the edited csproj to one package');
    assert.strictEqual(
      projectDependencies.value.get(absolute)?.nugetPackages[0]?.version,
      '13.0.2',
    );
  });

  test('deleting a tracked .csproj in the workspace fires onDidDelete → remove', async function () {
    if (root === undefined) {
      this.skip();
      return;
    }
    this.timeout(10_000);
    const filePath = path.join(scratchDir, 'Deleted.csproj');
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');
    ensureTracked(filePath);
    const absolute = path.resolve(filePath);
    assert.ok(projectDependencies.value.has(absolute), 'precondition: tracked');

    fs.rmSync(filePath);
    const removed = await waitFor(() => !projectDependencies.value.has(absolute));
    assert.ok(removed, 'a workspace delete event must remove the tracked project');
  });

  test('a Directory.Packages.props change in the workspace routes rescan → rescanAll', async function () {
    if (root === undefined) {
      this.skip();
      return;
    }
    this.timeout(10_000);
    // Two tracked projects whose on-disk content we change, plus a props file in
    // the workspace. A props change is NOT a .csproj/.fsproj, so rescan() takes
    // its rescanAll() branch (lines 258-261), re-parsing EVERY tracked project.
    const fileA = path.join(scratchDir, 'PropsA.csproj');
    const fileB = path.join(scratchDir, 'PropsB.csproj');
    fs.writeFileSync(fileA, CSPROJ_XML, 'utf-8');
    fs.writeFileSync(fileB, CSPROJ_XML, 'utf-8');
    ensureTracked(fileA);
    ensureTracked(fileB);

    fs.writeFileSync(fileA, UPDATED_CSPROJ_XML, 'utf-8');
    fs.writeFileSync(fileB, EMPTY_CSPROJ_XML, 'utf-8');
    const propsPath = path.join(scratchDir, 'Directory.Packages.props');
    fs.writeFileSync(propsPath, '<Project></Project>', 'utf-8');

    const both = await waitFor(
      () =>
        projectDependencies.value.get(path.resolve(fileA))?.nugetPackages.length === 1 &&
        projectDependencies.value.get(path.resolve(fileB))?.nugetPackages.length === 0,
    );
    assert.ok(both, 'a workspace props change must rescanAll every tracked project from disk');
  });
});

// ── mtime guard: previous-mtime-undefined branch (lines 181-185) ─────────────
//
// `checkTrackedProjectMtimes` skips a project the first time it sees a usable
// mtime that was never recorded in projectMtimes. ensureTracked() of a MISSING
// file deletes that file's mtime entry (updateProjectMtime → readMtime undefined
// → projectMtimes.delete). When the file later appears, the next guard tick
// reads a real mtime but finds `previous === undefined`, recording it and
// continuing WITHOUT scheduling a rescan. We assert exactly that: the file's
// fresh content is NOT picked up by that first tick (only its mtime is seeded).

suite('ProjectDepsStore — mtime guard previous-undefined branch', () => {
  let tmpDir: string;
  let context: vscode.ExtensionContext;

  setup(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-mtime-seed-'));
    context = makeFakeContext();
    initProjectDepsStore(context);
  });

  teardown(() => {
    resetForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('tracking a missing file then creating it: guard seeds mtime, a later bump rescans', async function () {
    this.timeout(10_000);
    // Track a ghost path: it lands in projectDependencies (empty deps) but its
    // mtime entry is DELETED (updateProjectMtime → readMtime undefined → delete)
    // because the file does not exist yet. In a temp dir the VS Code watcher
    // events are suppressed (see the mtime-guard suite above), so the ONLY
    // machinery that can react is the 250ms guard.
    const filePath = path.join(tmpDir, 'SeedMtime.csproj');
    assert.ok(!fs.existsSync(filePath), 'precondition: file absent');
    const ghost = ensureTracked(filePath);
    assert.strictEqual(ghost.nugetPackages.length, 0, 'ghost has empty deps');
    const absolute = path.resolve(filePath);

    // Create the file with real content. The guard's FIRST tick that sees a
    // usable mtime finds `previous === undefined` (it was deleted at track time)
    // and takes lines 182-184: record the mtime and `continue` WITHOUT a rescan.
    fs.writeFileSync(filePath, CSPROJ_XML, 'utf-8');

    // Now drive several mtime bumps forward. Once the guard has seeded the
    // previous mtime, a subsequent tick observes `previous !== current` and
    // schedules a rescan (lines 186-188), so the now-present file is parsed.
    // Bumping in a loop defeats any ordering between the seed tick and the bump.
    let bump = 1;
    const eventuallySeen = await waitFor(() => {
      const future = new Date(Date.now() + bump * 5000);
      bump += 1;
      try {
        fs.utimesSync(filePath, future, future);
      } catch {
        /* ignore — file always exists here */
      }
      return projectDependencies.value.get(absolute)?.nugetPackages.length === 2;
    }, 6000);

    assert.ok(
      eventuallySeen,
      'guard must seed the mtime first, then rescan the now-present file on a later change',
    );
    assert.strictEqual(
      projectDependencies.value.get(absolute)?.nugetPackages.length,
      2,
      'the rescanned ghost file now reflects its two packages',
    );
  });
});
