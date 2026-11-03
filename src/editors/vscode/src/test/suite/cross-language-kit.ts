import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { activateRealSharpLsp, workspaceFixturePath } from './refactor-test-helpers';
import { DOTNET_CLI_MS } from './test-timeouts';

// The real mixed C# ↔ F# fixture solution, built, with a freshly started server.

const execFileAsync = promisify(execFile);
const FIXTURE_SOLUTION = workspaceFixturePath('TestFixtures.slnx');
const RESTART_COMMAND = 'sharplsp.restartServer';

interface BuildArtifact {
  readonly source: string;
  readonly output: string;
}

const TEST_FIXTURES_DLL = 'bin/Debug/net10.0/TestFixtures.dll';
const FSHARP_FIXTURES_DLL = 'fsharp/bin/Debug/net10.0/FSharpFixtures.dll';
const CSHARP_CONSUMER_DLL = 'crosslanguage/bin/Debug/net10.0/CSharpConsumer.dll';

const BUILD_ARTIFACTS: readonly (readonly [source: string, output: string])[] = [
  ['CrossLanguageCSharp.cs', TEST_FIXTURES_DLL],
  ['CrossLanguageNavigationCSharp.cs', TEST_FIXTURES_DLL],
  ['fsharp/CrossLanguage.fs', FSHARP_FIXTURES_DLL],
  ['fsharp/CrossLanguageNavigation.fs', FSHARP_FIXTURES_DLL],
  ['crosslanguage/FSharpConsumer.cs', CSHARP_CONSUMER_DLL],
  ['crosslanguage/FSharpNavigationConsumer.cs', CSHARP_CONSUMER_DLL],
];

/** Restart the real server: everything it knows it must learn again. */
export async function restartRealLsp(): Promise<void> {
  const client = await activateRealSharpLsp();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes(RESTART_COMMAND), `${RESTART_COMMAND} must be registered`);
  await vscode.commands.executeCommand(RESTART_COMMAND);
  const restarted = await activateRealSharpLsp();
  assert.strictEqual(restarted, client, 'restart must leave the real LanguageClient running');
}

export async function rebuildAndRestartRealLsp(): Promise<void> {
  await buildCrossLanguageFixtures();
  await restartRealLsp();
}

async function buildCrossLanguageFixtures(): Promise<void> {
  const result = await execFileAsync(
    'dotnet',
    ['build', FIXTURE_SOLUTION, '--configuration', 'Debug', '--nologo', '--verbosity', 'minimal'],
    { cwd: path.dirname(FIXTURE_SOLUTION), encoding: 'utf8', timeout: DOTNET_CLI_MS },
  ).catch((error: { stdout?: string; stderr?: string }) => {
    // A failed build names its cause only in its own output; surface it.
    throw new Error(`fixture build failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
  });
  assert.strictEqual(typeof result.stdout, 'string');
  assert.strictEqual(typeof result.stderr, 'string');
  assert.ok(result.stdout.trim().length > 0, 'real fixture build must report output');
  await Promise.all(buildArtifacts().map(assertArtifactFresh));
}

function buildArtifacts(): readonly BuildArtifact[] {
  return BUILD_ARTIFACTS.map(([source, output]) => ({
    source: workspaceFixturePath(source),
    output: workspaceFixturePath(output),
  }));
}

async function assertArtifactFresh(artifact: BuildArtifact): Promise<void> {
  const [sourceStats, outputStats] = await Promise.all([
    stat(artifact.source),
    stat(artifact.output),
  ]);
  assert.ok(sourceStats.isFile(), `${artifact.source} must be a source file`);
  assert.ok(outputStats.isFile(), `${artifact.output} must be a real assembly`);
  assert.ok(outputStats.size > 0, `${artifact.output} must not be empty`);
  assert.ok(
    outputStats.mtimeMs >= sourceStats.mtimeMs,
    `${artifact.output} is stale relative to ${artifact.source}`,
  );
}
