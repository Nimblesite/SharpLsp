// Fixtures for the scaffolding e2e suite: the committed-workspace folder the
// commands write into, collision-proof artifact names, the .sln/.slnx candidate
// pair `dotnet new sln` may produce, and the QuickPick selectors the
// add-project flow drives.
//
// The scaffolding commands run the REAL `dotnet` CLI against the committed
// workspace fixture, so every artifact a test creates must be tracked and
// removed in teardown; the helpers here keep the tracking boilerplate out of
// each flow and keep the `.sln`/`.slnx` duality in exactly one place.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSolution, createProject, findProjectFile } from '../../scaffolding.js';
import { type UiStubs } from './ui-stubs';

/** Resolves the committed workspace folder the scaffolding commands write into. */
export function workspaceFolder(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(folder !== undefined && folder !== '', 'a workspace folder must be open');
  return folder;
}

/** A short, collision-proof token for temp scaffolding names. */
export function uniqueToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** `ScaffTmp_<case>_<token>` — a unique scaffolding artifact name. */
export function scaffoldName(caseName: string): string {
  return `ScaffTmp_${caseName}_${uniqueToken()}`;
}

/** Tracks the project directory `dotnet new` will create for `name` under the workspace. */
export function trackedProjectDir(track: (artifact: string) => string, name: string): string {
  return track(path.join(workspaceFolder(), name));
}

/** Tracks `<workspace>/ScaffTmp_<case>_<token>.cs` for cleanup; returns the generated name and its path. */
export function trackedNewFile(
  track: (artifact: string) => string,
  caseName: string,
): { readonly name: string; readonly filePath: string } {
  const name = scaffoldName(caseName);
  return { name, filePath: track(path.join(workspaceFolder(), `${name}.cs`)) };
}

/** Both solution-file candidates `dotnet new sln` may produce for `name`. */
export function slnCandidates(
  folder: string,
  name: string,
): {
  slnPath: string;
  slnxPath: string;
} {
  return {
    slnPath: path.join(folder, `${name}.sln`),
    slnxPath: path.join(folder, `${name}.slnx`),
  };
}

/** The first of `candidates` that exists on disk, if any. */
export function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** Tracks both `.sln`/`.slnx` candidates `dotnet new sln` may produce under `folder`, returning their paths. */
export function trackSlnCandidates(
  track: (artifact: string) => string,
  folder: string,
  name: string,
): { slnPath: string; slnxPath: string } {
  const candidates = slnCandidates(folder, name);
  track(candidates.slnPath);
  track(candidates.slnxPath);
  return candidates;
}

/**
 * Drives `command` (`sharplsp.newProject`) with `template` picked and `name`
 * typed, tracking the project dir; asserts the dir was created and returns it
 * with the located project file (undefined when none was scaffolded).
 */
export async function scaffoldProjectViaCommand(
  stubs: UiStubs,
  track: (artifact: string) => string,
  command: string,
  template: string,
  name: string,
  dirMessage: string,
): Promise<{ readonly projDir: string; readonly projFile: string | undefined }> {
  const projDir = trackedProjectDir(track, name);
  stubs.queuePick(template).queueInput(name).queueInfo(undefined);
  await vscode.commands.executeCommand(command);
  assert.ok(fs.existsSync(projDir), dirMessage);
  return { projDir, projFile: findProjectFile(projDir, name) };
}

/**
 * Drives `command` against a cancelled prompt — `template` picked with an empty
 * name when given, else just `input` queued (the picker cancels) — asserting
 * `artifact` was never created.
 */
export async function runCancelledCommand(
  stubs: UiStubs,
  command: string,
  template: string | undefined,
  input: string,
  artifact: string,
  message: string,
): Promise<void> {
  if (template === undefined) {
    stubs.queueInput(input);
  } else {
    stubs.queuePick(template).queueInput(input);
  }
  await vscode.commands.executeCommand(command);
  assert.ok(!fs.existsSync(artifact), message);
}

/** Creates a real solution + classlib project pair via the pure helpers. */
export async function createSolutionProjectPair(
  folder: string,
  slnName: string,
  projName: string,
  language?: string,
): Promise<{ slnPath: string; projDir: string; projFile: string | undefined }> {
  const slnPath = await createSolution(folder, slnName);
  const projDir = await createProject(folder, projName, 'classlib', language);
  const projFile = findProjectFile(projDir, projName);
  return { slnPath, projDir, projFile };
}

/** Asserts the solution file on disk references `projectFile`. */
export function assertSolutionReferences(
  slnPath: string,
  projectFile: string,
  message: string,
): void {
  const slnText = fs.readFileSync(slnPath, 'utf-8');
  assert.ok(slnText.includes(projectFile), message);
}

/** QuickPick selector picking the workspace project file named `projectName`. */
export function pickProjectNamed(
  projectName: string,
  extension = 'csproj',
): (items: readonly unknown[]) => unknown {
  return (items) =>
    (items as { label: string; uri: vscode.Uri }[]).find((i) =>
      i.uri.fsPath.endsWith(`${projectName}.${extension}`),
    );
}

/** The labels of the first QuickPick the stub harness recorded. */
export function firstPickLabels(stubs: UiStubs): string[] {
  return (stubs.log.quickPickItems[0] as { label: string }[]).map((i) => i.label);
}

/** Asserts the flow stopped at the first picker: one picker shown, no name prompt. */
export function assertCancelledAtPicker(stubs: UiStubs): void {
  assert.strictEqual(stubs.log.quickPickItems.length, 1, 'the template picker was shown');
  assert.strictEqual(stubs.log.inputBoxOptions.length, 0, 'the name prompt was NOT reached');
}

/**
 * Wait until `vscode.workspace.findFiles` indexes a project file written to disk
 * outside the workspace edit API (e.g. by `dotnet new`). The file watcher may lag
 * a beat behind the disk write, so we poll briefly before driving a command that
 * relies on workspace discovery.
 */
export async function waitForWorkspaceProject(basename: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const uris = await vscode.workspace.findFiles('**/*.{csproj,fsproj}', '**/node_modules/**');
    if (uris.some((uri) => uri.fsPath.endsWith(basename))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(
    `the workspace never indexed ${basename}; the command under test would see no project`,
  );
}
