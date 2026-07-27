// Shared REAL-.NET fixture helpers for the Test Explorer e2e suites.
//
// Every Test Explorer suite needs the same three things: an on-disk test project
// (project file + one source file), a real solution built by the `dotnet` CLI,
// and a way to read the ids the extension's TestController ended up with. These
// live here so no suite re-implements them (DRY).
//
// The project files are AUTHORED here, never edited — a fixture is written once
// from a template and thrown away with its temp dir, so no structured-file
// mutation is involved.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { sleep } from './test-helpers';

/** Target framework every fixture project builds against. */
export const FIXTURE_TFM = 'net10.0';

/** VSTest host package — required by every framework's adapter. */
const TEST_SDK = '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />';

/** xUnit framework + VSTest adapter package references. */
export const XUNIT_PACKAGES = [
  '<PackageReference Include="xunit" Version="2.9.2" />',
  '<PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />',
] as const;

/** NUnit framework + VSTest adapter package references. */
export const NUNIT_PACKAGES = [
  '<PackageReference Include="NUnit" Version="4.2.2" />',
  '<PackageReference Include="NUnit3TestAdapter" Version="4.6.0" />',
] as const;

/** MSTest framework + VSTest adapter package references. */
export const MSTEST_PACKAGES = [
  '<PackageReference Include="MSTest.TestFramework" Version="3.6.1" />',
  '<PackageReference Include="MSTest.TestAdapter" Version="3.6.1" />',
] as const;

/**
 * Build an SDK-style test project file. `compileFile`, when given, emits the
 * explicit `<Compile>` item F# projects require (F# compilation is ordered).
 */
export function projectXml(packages: readonly string[], compileFile?: string): string {
  const compileGroup =
    compileFile === undefined
      ? []
      : ['  <ItemGroup>', `    <Compile Include="${compileFile}" />`, '  </ItemGroup>'];
  return [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    `    <TargetFramework>${FIXTURE_TFM}</TargetFramework>`,
    '    <Nullable>enable</Nullable>',
    '    <IsPackable>false</IsPackable>',
    '  </PropertyGroup>',
    ...compileGroup,
    '  <ItemGroup>',
    ...packages.map((reference) => `    ${reference}`),
    `    ${TEST_SDK}`,
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\n');
}

/** Write a fixture project (project file + single source file) to disk. */
export function writeProject(
  dir: string,
  projName: string,
  projXml: string,
  srcName: string,
  src: string,
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, projName), projXml, 'utf8');
  fs.writeFileSync(path.join(dir, srcName), src, 'utf8');
}

/** Run a `dotnet` command, resolving stdout or rejecting with stderr. */
export function dotnet(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'dotnet',
      args,
      { cwd, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`dotnet ${args.join(' ')} failed: ${stderr || error.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * Create a REAL solution the way a user's project is laid out and add every
 * project directory to it. Structured files (.sln/.slnx) are produced by the
 * dotnet CLI, never hand-authored. .NET 10's `dotnet new sln` emits the XML
 * `.slnx` format by default, so the actual file is detected, not assumed.
 */
export async function createSolution(
  root: string,
  name: string,
  projectDirs: string[],
): Promise<string> {
  await dotnet(['new', 'sln', '--name', name], root);
  const slnFile = fs
    .readdirSync(root)
    .find((entry) => entry === `${name}.sln` || entry === `${name}.slnx`);
  assert.ok(slnFile, `dotnet new sln must produce a ${name}.sln or ${name}.slnx`);
  const slnPath = path.join(root, slnFile);
  await dotnet(['sln', slnPath, 'add', ...projectDirs], root);
  return slnPath;
}

/**
 * The Test Explorer's reactive re-discovery debounce (`DISCOVERY_DEBOUNCE_MS` in
 * `src/testing.ts`) plus slack, so a scheduled sweep has certainly been queued.
 */
export const REDISCOVERY_SETTLE_MS = 1_500;

/** The controller surface {@link drainDiscovery} needs. */
interface DiscoveryController {
  discover: () => Promise<void>;
}

/**
 * Point reactive discovery away from a fixture and let any in-flight sweep
 * finish, BEFORE the fixture's temp dir is deleted.
 *
 * This is not tidiness. A `dotnet test` whose working directory has been removed
 * out from under it never exits — VSTest dies in `Interop.Sys.GetCwd()` but the
 * MSBuild node hangs — and it is orphaned when the test host exits. The orphans
 * accumulate across runs and their MSBuild/NuGet locks stall every later run.
 *
 * Clearing the solution re-points discovery at the workspace folder; the
 * controller serializes its `dotnet` invocations, so awaiting one more sweep
 * cannot resolve until the fixture-aimed one has already finished.
 */
export async function drainDiscovery(
  clearSolution: () => void,
  controller: DiscoveryController,
): Promise<void> {
  clearSolution();
  await sleep(REDISCOVERY_SETTLE_MS);
  await controller.discover();
}

/** Recursively collect every TestItem id in a controller collection. */
export function collectItemIds(items: vscode.TestItemCollection): string[] {
  const ids: string[] = [];
  items.forEach((item) => {
    ids.push(item.id);
    ids.push(...collectItemIds(item.children));
  });
  return ids;
}
