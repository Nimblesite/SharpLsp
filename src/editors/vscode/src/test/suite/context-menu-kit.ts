// The Solution Explorer tree as the context-menu suites see it: the node fields
// the menus key on, searches over the tree, the clipboard the copy commands
// write, and the one-project solution each suite loads and waits for.
//
// The package-maintenance commands those menus offer are driven here too: a
// scratch solution of projects and the consolidate request over the LSP.
//
// Covers [SE-TREE]: every node a menu can target is reached through the real
// exported provider, never a hand-built tree.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { sharpLspExtension } from './extension-manifest-kit';
import {
  activeExplorerProvider,
  type ExplorerProvider,
  writeOneProjectSolution,
} from './explorer-kit';
import { useLspTestSuite } from './lsp-suite-kit';
import { pollUntilResult, requireAt, waitForDocumentSymbols } from './test-helpers';
import { ACTIVATION_MS, FAST_MS } from './test-timeouts';
import { nodeLabel, findNode } from './tree-node-kit';

/** A Solution Explorer node, viewed through the fields the menus key on. */
export interface TreeNode {
  readonly label?: string | { label: string };
  readonly contextValue?: string;
  readonly children?: TreeNode[];
  readonly symbolUri?: string;
  readonly sortName?: string;
  readonly projectFilePath?: string;
}

export type SymbolTree = ExplorerProvider<TreeNode>;

/** The node labelled `label` (with `contextValue`, when given), asserted present. */
export function requireNode(
  nodes: TreeNode[] | undefined,
  label: string,
  contextValue?: string,
): TreeNode {
  const node = findNode(
    nodes,
    (n) =>
      nodeLabel(n).includes(label) &&
      (contextValue === undefined || n.contextValue === contextValue),
  );
  assert.ok(node, `${label} (${contextValue ?? 'any contextValue'}) must be in the tree`);
  return node;
}

/** The tree's root, asserted to be the solution node. */
export function requireSolutionNode(tree: SymbolTree): TreeNode {
  const root = tree.getChildren()?.[0];
  assert.ok(root, 'Solution node must exist');
  assert.strictEqual(root.contextValue, 'solution', 'Root node must be the solution');
  return root;
}

/**
 * Run a copy command on `node` and return what it put on the clipboard.
 *
 * The clipboard is primed with `sentinel` first, then polled until it holds
 * something else: a command that copied nothing leaves the sentinel there and
 * fails as itself, and a wait on the clipboard's STATE replaces the fixed sleep
 * that used to guess how long the write took ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 * The budget sits under the `COMMAND_MS` ceiling of the tests that call this.
 */
export async function copiedText(
  command: string,
  node: TreeNode,
  sentinel: string,
): Promise<string> {
  await vscode.env.clipboard.writeText(sentinel);
  await vscode.commands.executeCommand(command, node);
  return pollUntilResult(
    async () => vscode.env.clipboard.readText(),
    (text) => text !== sentinel,
    FAST_MS,
    50,
    `'${command}' to replace the clipboard sentinel '${sentinel}'`,
  );
}

/** A one-project solution whose only source is `<project>/Source.cs` = `source`. */
function writeSourceSolution(
  root: string,
  project: string,
  source: string,
): { slnPath: string; sourcePath: string } {
  const { slnPath, projDir } = writeOneProjectSolution(root, project);
  const sourcePath = path.join(projDir, 'Source.cs');
  fs.writeFileSync(sourcePath, source);
  return { slnPath, sourcePath };
}

/** Load `slnPath`, open `sourcePath`, and poll until the tree holds a node `ready` accepts. */
export async function loadTreeUntil(
  tree: SymbolTree,
  slnPath: string,
  sourcePath: string,
  ready: (node: TreeNode) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  await tree.loadSolution(slnPath);
  const uri = vscode.Uri.file(sourcePath);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await waitForDocumentSymbols(uri);
  await tree.refresh();
  await pollUntilResult(
    async () => findNode(tree.getChildren(), ready),
    (node) => node !== undefined,
    timeoutMs,
  );
}

/**
 * One activated server and a Solution Explorer loaded with a single project
 * whose `Source.cs` is `source`, settled until a node `ready` accepts appears.
 * The tree is cleared when the suite ends. Returns the provider.
 */
export function useSymbolTree(
  prefix: string,
  project: string,
  source: string,
  ready: (node: TreeNode) => boolean,
): () => SymbolTree {
  let tree: SymbolTree | undefined;
  // Registered BEFORE the LSP suite hooks, so the tree lets go of the solution
  // before its scratch directory is deleted: Mocha runs these in order.
  suiteTeardown(() => {
    tree?.clear();
  });
  const tmpDir = useLspTestSuite(prefix);
  suiteSetup(async function () {
    this.timeout(ACTIVATION_MS);
    tree = activeExplorerProvider<TreeNode>();
    const { slnPath, sourcePath } = writeSourceSolution(tmpDir(), project, source);
    await loadTreeUntil(tree, slnPath, sourcePath, ready);
  });
  return () => {
    assert.ok(tree, 'the Solution Explorer must be loaded in suiteSetup');
    return tree;
  };
}

/** A node labelled `label`, for `useSymbolTree`'s `ready`. */
export function labelled(label: string): (node: TreeNode) => boolean {
  return (node) => nodeLabel(node).includes(label);
}

/** Run `command` with `args` and assert it does not reject. */
export async function assertRuns(command: string, ...args: unknown[]): Promise<void> {
  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand(command, ...args);
  }, `${command} must not throw`);
}

/** Run `command` with `args` over the wire, asserting it completes cleanly, `why` saying what that proves. */
export async function assertCommandSucceeds(
  command: string,
  args: unknown[],
  why: string,
): Promise<void> {
  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand(command, ...args);
  }, why);
}

// ── Package maintenance the menu commands drive ([SE-CONTEXT-MENUS]) ──

/** A `[id, version]` PackageReference pair. */
export type PackageRef = readonly string[];

/** One project of a scratch solution: its name, its package references, and its extension. */
export interface ProjectSpec {
  readonly name: string;
  readonly refs: readonly PackageRef[];
  readonly ext?: string;
}

/** One package a consolidate move reported. */
export interface MovedPackage {
  readonly id: string;
  readonly version: string;
  readonly fromProjects: string[];
}

/** The reply to `sharplsp/nuget/consolidate`. */
export interface ConsolidateResp {
  readonly moved: MovedPackage[];
  readonly propsFile?: string;
  readonly modifiedFiles: string[];
  readonly message: string;
}

/** A scratch solution made by `makeSolution`: its `.sln`, its directory, its project files. */
export interface ScratchSolution {
  readonly sln: string;
  readonly dir: string;
  readonly projects: string[];
}

/** Write `<dir>/<name>/<name>.<ext>` carrying `refs` as PackageReferences; returns its path. */
export function writeProject(
  dir: string,
  name: string,
  refs: readonly PackageRef[],
  ext = 'csproj',
): string {
  const projDir = path.join(dir, name);
  fs.mkdirSync(projDir, { recursive: true });
  const items = refs
    .map((ref) => `    <PackageReference Include="${ref[0]}" Version="${ref[1]}" />`)
    .join('\n');
  const file = path.join(projDir, `${name}.${ext}`);
  fs.writeFileSync(
    file,
    `<Project Sdk="Microsoft.NET.Sdk">\n` +
      `  <PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>\n` +
      `  <ItemGroup>\n${items}\n  </ItemGroup>\n</Project>\n`,
  );
  return file;
}

/** Create `<tmpDir>/<name>/` holding `projects` and a `<name>.sln` naming them. */
export function makeSolution(
  tmpDir: string,
  name: string,
  projects: readonly ProjectSpec[],
): ScratchSolution {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const created = projects.map((project) =>
    writeProject(dir, project.name, project.refs, project.ext ?? 'csproj'),
  );
  const sln = path.join(dir, `${name}.sln`);
  fs.writeFileSync(sln, 'Microsoft Visual Studio Solution File, Format Version 12.00\n');
  return { sln, dir, projects: created };
}

/** Two projects sharing one Serilog version: the canonical consolidation input. */
export const SERILOG_PAIR: readonly ProjectSpec[] = [
  { name: 'A', refs: [['Serilog', '3.1.0']] },
  { name: 'B', refs: [['Serilog', '3.1.0']] },
];

/** Two projects pinning DIFFERENT Serilog versions, so the highest must be the one hoisted. */
export const SPLIT_SERILOG_PAIR: readonly ProjectSpec[] = [
  { name: 'A', refs: [['Serilog', '3.1.0']] },
  { name: 'B', refs: [['Serilog', '3.0.0']] },
];

/** Two projects whose only packages are DIFFERENT, so nothing is shared at all. */
export function unsharedPair(onlyBVersion = '1.0.0'): readonly ProjectSpec[] {
  return [
    { name: 'A', refs: [['OnlyA', '1.0.0']] },
    { name: 'B', refs: [['OnlyB', onlyBVersion]] },
  ];
}

/** Send a consolidate request (scan or apply) over the LSP. */
export async function consolidate(
  lsp: LanguageClient,
  solutionPath: string,
  dryRun: boolean,
): Promise<ConsolidateResp> {
  return lsp.sendRequest<ConsolidateResp>('sharplsp/nuget/consolidate', { solutionPath, dryRun });
}

/** A fresh solution of `projects` named `name`, with the running client that will drive it. */
export function solutionFor(
  tmpDir: string,
  name: string,
  projects: readonly ProjectSpec[],
): ScratchSolution & { readonly lsp: LanguageClient } {
  return { ...makeSolution(tmpDir, name, projects), lsp: activeLspClient() };
}

/**
 * Consolidate a fresh solution of `projects` once — a scan unless `dryRun` is
 * false — returning the reply beside the solution's `.sln` and directory.
 */
export async function consolidateNew(
  tmpDir: string,
  name: string,
  projects: readonly ProjectSpec[],
  dryRun = true,
): Promise<{ readonly resp: ConsolidateResp; readonly sln: string; readonly dir: string }> {
  const { lsp, sln, dir } = solutionFor(tmpDir, name, projects);
  return { resp: await consolidate(lsp, sln, dryRun), sln, dir };
}

/** The single package a consolidate moved, asserted to be exactly one. */
export function requireSoleMoved(resp: ConsolidateResp): MovedPackage {
  assert.strictEqual(resp.moved.length, 1, 'exactly one package must be moved or reported');
  return requireAt(resp.moved, 0, 'the moved package');
}

/** The running language client the extension publishes, asserted present. */
export function activeLspClient(): LanguageClient {
  const api = sharpLspExtension().exports as { getLspClient?: () => LanguageClient | undefined };
  assert.ok(api?.getLspClient, 'Extension must export getLspClient');
  const client = api.getLspClient();
  assert.ok(client, 'LSP client must be running');
  return client;
}

/**
 * Assert a menu clause names one of what it should: a substring in `needles`, or
 * a PREFIX in `prefixes` (a group numbered `1_…` is a first-tier group).
 */
export function assertMentions(
  text: string,
  needles: readonly string[],
  what: string,
  prefixes: readonly string[] = [],
): void {
  const mentioned = [...needles, ...prefixes.map((prefix) => `${prefix}…`)].join(', ');
  assert.ok(
    needles.some((needle) => text.includes(needle)) ||
      prefixes.some((prefix) => text.startsWith(prefix)),
    `${what} must name one of ${mentioned}, got '${text}'`,
  );
}

/**
 * Assert `text` is a dotted qualified name: it holds a dot separator and neither
 * starts nor ends with one, so no empty segment leaks in from a missing ancestor.
 */
export function assertDottedName(text: string): void {
  assert.ok(text.includes('.'), `qualified name '${text}' must contain a dot separator`);
  assert.ok(!text.startsWith('.'), `qualified name '${text}' must not start with a dot`);
  assert.ok(!text.endsWith('.'), `qualified name '${text}' must not end with a dot`);
}
