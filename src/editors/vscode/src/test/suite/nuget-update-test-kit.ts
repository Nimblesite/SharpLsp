// Deterministic fixtures for [NUGET-REQUESTS-UPDATE-TESTS].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { directoryOf, joinPath, samePath } from '../../paths';
import { packDiagnosticPackage } from './diagnostic-package-kit';
import { buildProjectXml, projectBuilder, writeProject } from './dotnet-project-kit';

export const CONTROLLED_PACKAGE = 'SharpLsp.Controlled';
export const CURRENT_VERSION = '1.0.0';
export const BOUNDED_VERSION = '1.2.0';
const CONTROLLED_VERSIONS = [
  CURRENT_VERSION,
  BOUNDED_VERSION,
  '2.0.0',
  '1.3.0-beta.1',
  '0.4.2',
  '0.4.9',
  '0.5.0',
];

export interface UpdateProjectShape {
  readonly name: string;
  readonly extension: 'csproj' | 'fsproj';
  readonly sourceName: string;
  readonly source: string;
}

export const UPDATE_PROJECTS: readonly UpdateProjectShape[] = [
  {
    name: 'FSharpUpdate',
    extension: 'fsproj',
    sourceName: 'Library.fs',
    source: 'namespace FSharpUpdate\n\ntype Marker = { Value: int }\n',
  },
  {
    name: 'CSharpUpdate',
    extension: 'csproj',
    sourceName: 'Marker.cs',
    source: 'namespace CSharpUpdate; public record Marker(int Value);\n',
  },
];

/** A picker that fails its precondition instead of substituting a workspace project. */
export function selectExpectedProject(projectPath: string): (items: readonly unknown[]) => unknown {
  return (items) => {
    const selected = items.find((item) => {
      const uri = (item as { uri?: vscode.Uri }).uri;
      return uri !== undefined && samePath(uri.fsPath, projectPath);
    });
    assert.ok(
      selected !== undefined,
      `expected project was absent from the picker: ${projectPath}`,
    );
    return selected;
  };
}

/** Byte snapshots of every checked-in project present before disposable fixtures are written. */
export async function snapshotCheckedInProjects(): Promise<ReadonlyMap<string, Buffer>> {
  const projects = await vscode.workspace.findFiles('**/*.{csproj,fsproj}', '**/node_modules/**');
  return new Map(projects.map((uri) => [uri.fsPath, fs.readFileSync(uri.fsPath)]));
}

/** Prove that a command, including a failing one, never rewrote a checked-in project. */
export function assertCheckedInProjectsUnchanged(snapshot: ReadonlyMap<string, Buffer>): void {
  for (const [project, expected] of snapshot) {
    assert.deepEqual(fs.readFileSync(project), expected, `checked-in project changed: ${project}`);
  }
}

/** A real C# or F# library with one controlled, direct package declaration. */
export function writeUpdateProject(root: string, shape: UpdateProjectShape): string {
  return writeUpdateProjectAtVersion(root, shape, CURRENT_VERSION);
}

/** A real project at a chosen exact version, still in its own disposable directory. */
export function writeUpdateProjectAtVersion(
  root: string,
  shape: UpdateProjectShape,
  version: string,
): string {
  const directory = joinPath(root, shape.name);
  const projectName = `${shape.name}.${shape.extension}`;
  const xml = buildProjectXml({
    packages: [{ id: CONTROLLED_PACKAGE, version }],
    compileIncludes: [shape.sourceName],
  });
  writeProject(directory, projectName, xml, shape.sourceName, shape.source);
  return joinPath(directory, projectName);
}

/** A CPM project whose reference is versionless and whose props file owns the version. */
export function writeCpmUpdateProject(root: string, shape: UpdateProjectShape): string {
  const directory = joinPath(root, shape.name);
  const projectName = `${shape.name}.${shape.extension}`;
  const projectXml: string = projectBuilder.build({
    Project: {
      '@_Sdk': 'Microsoft.NET.Sdk',
      PropertyGroup: { TargetFramework: 'net10.0' },
      ItemGroup: [
        { Compile: { '@_Include': shape.sourceName } },
        { PackageReference: { '@_Include': CONTROLLED_PACKAGE } },
      ],
    },
  });
  const propsXml: string = projectBuilder.build({
    Project: {
      PropertyGroup: { ManagePackageVersionsCentrally: 'true' },
      ItemGroup: {
        PackageVersion: { '@_Include': CONTROLLED_PACKAGE, '@_Version': CURRENT_VERSION },
      },
    },
  });
  writeProject(directory, projectName, projectXml.trimStart(), shape.sourceName, shape.source);
  // Do not inherit checked-in workspace package injections into this disposable CPM project.
  fs.writeFileSync(joinPath(directory, 'Directory.Build.props'), '<Project />\n', 'utf8');
  fs.writeFileSync(joinPath(directory, 'Directory.Packages.props'), propsXml.trimStart());
  return joinPath(directory, projectName);
}

/** Override the inherited feed for failure tests without mutating any checked-in config. */
export function writeUnavailablePackageSource(projectPath: string): void {
  const directory = directoryOf(projectPath);
  const xml = projectBuilder.build({
    configuration: {
      packageSources: {
        clear: '',
        add: { '@_key': 'unavailable', '@_value': joinPath(directory, 'missing-feed') },
      },
    },
  });
  fs.writeFileSync(joinPath(directory, 'NuGet.Config'), xml, 'utf8');
}

/** SDK-pack a closed version inventory and make it the project's only package source. */
export async function seedControlledPackageSource(root: string): Promise<void> {
  await Promise.all(
    CONTROLLED_VERSIONS.map(async (version) => packControlledVersion(root, version)),
  );
  const xml = projectBuilder.build({
    configuration: {
      packageSources: {
        clear: '',
        add: { '@_key': 'controlled', '@_value': joinPath(root, 'feed') },
      },
    },
  });
  fs.writeFileSync(joinPath(root, 'NuGet.Config'), xml, 'utf8');
}

async function packControlledVersion(root: string, version: string): Promise<void> {
  await packDiagnosticPackage(root, {
    id: CONTROLLED_PACKAGE,
    version,
    assembly: CONTROLLED_PACKAGE,
    source: [
      'namespace SharpLsp.Controlled;',
      '/// <summary>A controlled package API.</summary>',
      'public static class Api',
      '{',
      '    /// <summary>Returns a constant.</summary>',
      '    public static string Value => "controlled";',
      '}',
      '',
    ].join('\n'),
  });
}
