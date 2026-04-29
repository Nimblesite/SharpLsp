import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureTracked,
  refreshTracked,
  rescanAll,
  resetForTests,
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
