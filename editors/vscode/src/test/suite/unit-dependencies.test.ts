import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseProjectXml,
  parseProjectDependencies,
  removeNuGetPackage,
} from '../../dependencies.js';

const SINGLE_PACKAGE_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
  </ItemGroup>
</Project>
`;

const MULTI_PACKAGE_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.0.0" />
    <PackageReference Include="AutoMapper" Version="12.0.0" />
    <PackageReference Include="FluentValidation" Version="11.0.0" />
  </ItemGroup>
</Project>
`;

const PROJECT_REF_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../Shared/Shared.csproj" />
    <ProjectReference Include="../Core/Core.csproj" />
  </ItemGroup>
</Project>
`;

const MIXED_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Zlib.Net" Version="1.0.0" />
    <PackageReference Include="Azure.Core" Version="1.35.0" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Logging" Version="8.0.0" />
    <ProjectReference Include="../OtherProject/OtherProject.fsproj" />
  </ItemGroup>
</Project>
`;

const NO_VERSION_XML = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="SomePackage" />
  </ItemGroup>
</Project>
`;

const EMPTY_XML = `<Project Sdk="Microsoft.NET.Sdk"></Project>`;

const INVALID_XML = `this is not xml at all <<<`;

suite('Dependencies Module — parseProjectXml()', () => {
  test('single PackageReference returns one NuGet package', () => {
    const result = parseProjectXml(SINGLE_PACKAGE_XML);
    assert.strictEqual(result.nugetPackages.length, 1);
    assert.strictEqual(result.nugetPackages[0]?.name, 'Newtonsoft.Json');
    assert.strictEqual(result.nugetPackages[0]?.version, '13.0.1');
    assert.strictEqual(result.projectReferences.length, 0);
  });

  test('multiple PackageReferences returns all packages', () => {
    const result = parseProjectXml(MULTI_PACKAGE_XML);
    assert.strictEqual(result.nugetPackages.length, 3);
    const names = result.nugetPackages.map((p) => p.name);
    assert.ok(names.includes('Serilog'));
    assert.ok(names.includes('AutoMapper'));
    assert.ok(names.includes('FluentValidation'));
  });

  test('packages are sorted alphabetically by name', () => {
    const result = parseProjectXml(MULTI_PACKAGE_XML);
    const names = result.nugetPackages.map((p) => p.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(names, sorted);
  });

  test('ProjectReferences are parsed correctly', () => {
    const result = parseProjectXml(PROJECT_REF_XML);
    assert.strictEqual(result.projectReferences.length, 2);
    const names = result.projectReferences.map((r) => r.name);
    assert.ok(names.includes('Shared'));
    assert.ok(names.includes('Core'));
  });

  test('project references are sorted alphabetically by name', () => {
    const result = parseProjectXml(PROJECT_REF_XML);
    const names = result.projectReferences.map((r) => r.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(names, sorted);
  });

  test('includePath on project reference is preserved', () => {
    const result = parseProjectXml(PROJECT_REF_XML);
    const shared = result.projectReferences.find((r) => r.name === 'Shared');
    assert.ok(shared !== undefined);
    assert.strictEqual(shared.includePath, '../Shared/Shared.csproj');
  });

  test('multiple ItemGroups are merged — packages and project refs combined', () => {
    const result = parseProjectXml(MIXED_XML);
    assert.strictEqual(result.nugetPackages.length, 3);
    assert.strictEqual(result.projectReferences.length, 1);
    const pkgNames = result.nugetPackages.map((p) => p.name);
    assert.ok(pkgNames.includes('Azure.Core'));
    assert.ok(pkgNames.includes('Zlib.Net'));
    assert.ok(pkgNames.includes('Microsoft.Extensions.Logging'));
  });

  test('missing @_Version attribute returns empty string for version', () => {
    const result = parseProjectXml(NO_VERSION_XML);
    assert.strictEqual(result.nugetPackages.length, 1);
    assert.strictEqual(result.nugetPackages[0]?.version, '');
  });

  test('empty project XML returns empty arrays', () => {
    const result = parseProjectXml(EMPTY_XML);
    assert.strictEqual(result.nugetPackages.length, 0);
    assert.strictEqual(result.projectReferences.length, 0);
  });

  test('invalid XML returns empty arrays without throwing', () => {
    assert.doesNotThrow(() => {
      const result = parseProjectXml(INVALID_XML);
      assert.strictEqual(result.nugetPackages.length, 0);
      assert.strictEqual(result.projectReferences.length, 0);
    });
  });

  test('empty string XML returns empty arrays without throwing', () => {
    const result = parseProjectXml('');
    assert.strictEqual(result.nugetPackages.length, 0);
    assert.strictEqual(result.projectReferences.length, 0);
  });

  test('project name is derived from filename without extension', () => {
    const result = parseProjectXml(PROJECT_REF_XML);
    for (const ref of result.projectReferences) {
      assert.ok(!ref.name.endsWith('.csproj'), 'Name must not include extension');
      assert.ok(!ref.name.endsWith('.fsproj'), 'Name must not include extension');
    }
  });
});

suite('Dependencies Module — parseProjectDependencies()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-deps-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('non-existent path returns empty arrays', () => {
    const result = parseProjectDependencies('/nonexistent/path/project.csproj');
    assert.strictEqual(result.nugetPackages.length, 0);
    assert.strictEqual(result.projectReferences.length, 0);
  });

  test('valid csproj file on disk is parsed correctly', () => {
    const filePath = path.join(tmpDir, 'Test.csproj');
    fs.writeFileSync(filePath, SINGLE_PACKAGE_XML, 'utf-8');
    const result = parseProjectDependencies(filePath);
    assert.strictEqual(result.nugetPackages.length, 1);
    assert.strictEqual(result.nugetPackages[0]?.name, 'Newtonsoft.Json');
  });

  test('valid fsproj file on disk is parsed correctly', () => {
    const filePath = path.join(tmpDir, 'MyLib.fsproj');
    fs.writeFileSync(filePath, MULTI_PACKAGE_XML, 'utf-8');
    const result = parseProjectDependencies(filePath);
    assert.strictEqual(result.nugetPackages.length, 3);
  });

  test('file with no packages returns empty nugetPackages array', () => {
    const filePath = path.join(tmpDir, 'Empty.csproj');
    fs.writeFileSync(filePath, EMPTY_XML, 'utf-8');
    const result = parseProjectDependencies(filePath);
    assert.strictEqual(result.nugetPackages.length, 0);
    assert.strictEqual(result.projectReferences.length, 0);
  });
});

// Coarse e2e over the real `dotnet` CLI: the removal path behind
// "Remove Unused Packages" must actually delete the <PackageReference> from a
// project that lives OUTSIDE the current working directory — exactly how the
// extension host invokes it (cwd = workspace root, project in a subfolder).
suite('Dependencies Module — removeNuGetPackage() (real dotnet)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-remove-pkg-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('removes a PackageReference from a project outside the cwd', async function () {
    this.timeout(60_000);
    const projectPath = path.join(tmpDir, 'RemoveMe.csproj');
    fs.writeFileSync(projectPath, SINGLE_PACKAGE_XML, 'utf-8');
    assert.ok(
      fs.readFileSync(projectPath, 'utf8').includes('Newtonsoft.Json'),
      'precondition: the package is present before removal',
    );

    // The function shells out to `dotnet`; it must resolve the project from the
    // absolute path we hand it, NOT from process.cwd() (which is not tmpDir).
    const error = await removeNuGetPackage(projectPath, 'Newtonsoft.Json');

    assert.strictEqual(error, undefined, `removal must succeed, got error: ${error ?? ''}`);
    assert.ok(
      !fs.readFileSync(projectPath, 'utf8').includes('Newtonsoft.Json'),
      'the <PackageReference> must be gone from the project file after removal',
    );
  });
});
