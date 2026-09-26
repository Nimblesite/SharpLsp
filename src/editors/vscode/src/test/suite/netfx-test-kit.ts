// What the Testing view must show for a project built for .NET Framework AND
// .NET: the `tfm:` tag each test carries per framework whose assembly lists it,
// the frameworks a project root describes (unrunnable ones named, never
// dropped), the `Run on <tfm>` profiles, the per-framework failure message, and
// the SharpLsp log lines a run leaves behind.
//
// Expected frameworks are COMPUTED — the project's declared frameworks crossed
// with the runtimes this agent really has — never pinned to one machine: a
// framework with no runtime lists nothing, and a suite that assumed otherwise
// would pass on one box and fail on the next.
//
// Observes [NETFX-TEST-DISCOVERY], [NETFX-TEST-RESULTS], [NETFX-TEST-PROFILES]
// and [NETFX-SCOPE].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OUTPUT_CHANNEL_NAME } from '../../constants.js';
import type { SharpLspExtensionApi } from '../../extension.js';
import { statusLensTitle } from '../../test-lens.js';
import type { CachedTestResult, SharpLspTestController } from '../../testing.js';
import {
  collectLeafIds,
  discoverSolution,
  findItem,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import { assertPassed, assertReported } from './test-explorer-outcome-assertions';
import { pollUntilResult } from './test-helpers';
import { LSP_RESPONSE_MS, REAL_REPO_WARMUP_MS } from './test-timeouts';

/** Every framework tag id is this prefix plus the framework's short name. */
export const TFM_TAG = 'tfm:';

/** How a framework that listed nothing is named in its project's description. */
export const NOTHING_LISTED = '(nothing listed)';

/** .NET Framework monikers: `net` + version digits, no dot (`net462`, `net481`). */
export function isNetFramework(tfm: string): boolean {
  const digits = tfm.slice('net'.length);
  return (
    tfm.startsWith('net') &&
    digits.length > 1 &&
    !digits.includes('.') &&
    Number.isInteger(Number(digits))
  );
}

/** 0 for .NET Framework, 1 for .NET Standard, 2 for .NET: the description's order. */
function familyOf(tfm: string): number {
  if (isNetFramework(tfm)) return 0;
  return tfm.startsWith('netstandard') ? 1 : 2;
}

/**
 * A moniker's version as numbers: `net472` → 4.7.2, `net10.0` → 10.0. A
 * platform suffix (`net8.0-windows`) names an OS, not a version, so it is cut.
 */
function versionOf(tfm: string): number[] {
  if (isNetFramework(tfm)) return Array.from(tfm.slice('net'.length), Number);
  const prefix = ['netstandard', 'netcoreapp', 'net'].find((family) => tfm.startsWith(family));
  const [version = ''] = tfm.slice((prefix ?? '').length).split('-');
  return version.split('.').map(Number);
}

/** The .NET Standard monikers among `tfms`, in their given order. */
export function standardsOf(tfms: readonly string[]): string[] {
  return tfms.filter((tfm) => familyOf(tfm) === 1);
}

/**
 * `tfms` — as the SERVER reports them — hold exactly these .NET Framework and
 * .NET Standard versions: the multi-family spread [NETFX-SCOPE] covers.
 */
export function assertDeclaresFamilies(
  tfms: readonly string[],
  families: { readonly netfx: readonly string[]; readonly standards: readonly string[] },
  why: string,
): void {
  assert.deepStrictEqual(
    tfms.filter(isNetFramework),
    [...families.netfx],
    `${why}: .NET Framework`,
  );
  assert.deepStrictEqual(standardsOf(tfms), [...families.standards], `${why}: .NET Standard`);
  assert.ok(families.netfx.length > 1 && families.standards.length > 1, `${why}: several of each`);
}

/** .NET Framework ascending, then .NET Standard, then .NET — numerically, never as text. */
export function compareFrameworks(left: string, right: string): number {
  const family = familyOf(left) - familyOf(right);
  if (family !== 0) return family;
  const [mine, theirs] = [versionOf(left), versionOf(right)];
  const index = mine.findIndex((part, at) => part !== (theirs[at] ?? 0));
  if (index >= 0) return (mine[index] ?? 0) - (theirs[index] ?? 0);
  return mine.length - theirs.length;
}

/** `tfms` in the order a project root describes them. */
export function inFrameworkOrder(tfms: readonly string[]): string[] {
  return [...tfms].sort(compareFrameworks);
}

/** Whether this agent can RUN `tfm`: the in-place CLR on Windows, else a runtime. */
export function runnableHere(tfm: string, installed: readonly string[]): boolean {
  return isNetFramework(tfm) ? process.platform === 'win32' : installed.includes(tfm);
}

/** The frameworks of `declared` a test run here really executes. */
export function runnableOf(declared: readonly string[], installed: readonly string[]): string[] {
  return inFrameworkOrder(declared.filter((tfm) => runnableHere(tfm, installed)));
}

/** The description a multi-targeted project's root must carry ([NETFX-TEST-DISCOVERY]). */
export function describedFrameworks(
  declared: readonly string[],
  installed: readonly string[],
): string {
  return inFrameworkOrder(declared)
    .map((tfm) => (runnableHere(tfm, installed) ? tfm : `${tfm} ${NOTHING_LISTED}`))
    .join(' · ');
}

/** A project root lists EVERY declared framework, unrunnable ones named as such. */
export function assertFrameworkRoot(
  root: vscode.TestItem,
  declared: readonly string[],
  installed: readonly string[],
): void {
  const why = `the ${root.label} root`;
  const description = root.description ?? '';
  assert.strictEqual(
    description,
    describedFrameworks(declared, installed),
    `${why} lists its frameworks`,
  );
  for (const tfm of declared) assert.ok(description.includes(tfm), `${why} names ${tfm}`);
  const unrunnable = declared.filter((tfm) => !runnableHere(tfm, installed));
  const marked = description.split(NOTHING_LISTED).length - 1;
  assert.strictEqual(
    marked,
    unrunnable.length,
    `${why} marks exactly ${unrunnable.join(', ') || 'none'}`,
  );
  assert.ok(root.canResolveChildren, `${why} is a group row, and it expands`);
}

/** The root row labelled `label` — one per test project — asserted present. */
export function rootLabelled(api: SharpLspExtensionApi, label: string): vscode.TestItem {
  const roots = rootsOf(api.testController.items);
  const root = roots.find((item) => item.label === label);
  assert.ok(
    root,
    `${label} must be a root of the Testing view; roots: ${roots.map((r) => r.label).join(' | ')}`,
  );
  assert.ok(root.id.startsWith('assembly:'), `${label} is an ASSEMBLY group row, got ${root.id}`);
  return root;
}

/** The class row holding `id`: the parent of its leaf, asserted present. */
export function classRowOf(api: SharpLspExtensionApi, id: string): vscode.TestItem {
  const leaf = findItem(api.testController.items, id);
  assert.ok(leaf, `${id} must be a leaf in the Testing view`);
  assert.ok(leaf.parent, `${id} hangs off the class row that declares it`);
  assert.ok(
    collectLeafIds(leaf.parent.children).includes(id),
    `${id} is one of its class row's tests`,
  );
  return leaf.parent;
}

/** The frameworks `item`'s `tfm:` tags name, in description order. */
export function frameworkTagsOf(item: vscode.TestItem): string[] {
  const ids = item.tags.map((tag) => tag.id).filter((id) => id.startsWith(TFM_TAG));
  return inFrameworkOrder(ids.map((id) => id.slice(TFM_TAG.length)));
}

/** `item` is tagged for EXACTLY `tfms`: one `tfm:` tag each, nothing else. */
export function assertTaggedFor(item: vscode.TestItem, tfms: readonly string[]): void {
  const ids = item.tags.map((tag) => tag.id);
  assert.deepStrictEqual(
    frameworkTagsOf(item),
    inFrameworkOrder(tfms),
    `${item.id}: its frameworks`,
  );
  assert.strictEqual(new Set(ids).size, ids.length, `${item.id}: no framework is tagged twice`);
  assert.deepStrictEqual(
    ids.filter((id) => !id.startsWith(TFM_TAG)),
    [],
    `${item.id}: tfm tags only`,
  );
  assert.strictEqual(item.children.size, 0, `${item.id}: a tagged row is a TEST, never a group`);
}

/**
 * A result that spans several frameworks and failed in `failing`: its cached
 * message names them, in order, before the first failure's one-line text
 * ([NETFX-TEST-RESULTS]).
 */
export function assertFailedOn(
  result: CachedTestResult,
  failing: readonly string[],
  text: string,
  id: string,
): void {
  const message = result.message ?? '';
  const prefix = `[${inFrameworkOrder(failing).join(', ')}] `;
  assert.strictEqual(result.outcome, 'failed', `${id} fails under ${failing.join(', ')}`);
  assert.ok(!result.passed, `${id}: a failure is never a pass`);
  assert.ok(message.startsWith(prefix), `${id}: the message opens with ${prefix}, got: ${message}`);
  assert.ok(message.includes(text), `${id}: and carries the framework's own text: ${message}`);
  assert.ok(!message.includes('\n'), `${id}: the cached message is ONE line`);
  assert.strictEqual(
    statusLensTitle(result),
    `$(error) Failed: ${message}`,
    `${id}: the status lens renders that same framework-prefixed line`,
  );
}

/** The controller, plus the [NETFX-TEST-PROFILES] it must expose. */
type NetfxController = SharpLspTestController & {
  readonly frameworkProfiles?: readonly vscode.TestRunProfile[];
};

/** The controller's `Run on <tfm>` profiles, asserted wired. */
export function frameworkProfilesOf(api: SharpLspExtensionApi): readonly vscode.TestRunProfile[] {
  const controller: NetfxController = api.testController;
  const profiles = controller.frameworkProfiles;
  assert.ok(profiles, 'the controller must expose frameworkProfiles ([NETFX-TEST-PROFILES])');
  return profiles;
}

/** One `Run on <tfm>` Run profile per framework, each scoped by its own tag. */
export function assertFrameworkProfiles(
  profiles: readonly vscode.TestRunProfile[],
  tfms: readonly string[],
): void {
  const labels = profiles.map((profile) => profile.label.slice('Run on '.length));
  assert.deepStrictEqual(
    labels,
    inFrameworkOrder(tfms),
    'one Run on <tfm> profile per framework, sorted .NET Framework < .NET Standard < .NET',
  );
  for (const profile of profiles) {
    const tfm = profile.label.slice('Run on '.length);
    assert.strictEqual(
      profile.label,
      `Run on ${tfm}`,
      `${profile.label} is named for its framework`,
    );
    assert.strictEqual(profile.kind, vscode.TestRunProfileKind.Run, `${profile.label} RUNS`);
    assert.strictEqual(
      profile.tag?.id,
      `${TFM_TAG}${tfm}`,
      `${profile.label} is scoped by its tag`,
    );
    assert.ok(!profile.isDefault, `${profile.label} never replaces the default ▶ Run`);
  }
}

/** The one profile that runs `tfm`, asserted present. */
export function profileFor(
  profiles: readonly vscode.TestRunProfile[],
  tfm: string,
): vscode.TestRunProfile {
  const profile = profiles.find((candidate) => candidate.label === `Run on ${tfm}`);
  assert.ok(
    profile,
    `a Run on ${tfm} profile must exist; got ${profiles.map((p) => p.label).join(' | ')}`,
  );
  return profile;
}

/** Press a SPECIFIC profile's button for `items`, exactly as the workbench does. */
export async function runWithProfile(
  profile: vscode.TestRunProfile,
  items: readonly vscode.TestItem[],
): Promise<void> {
  const source = new vscode.CancellationTokenSource();
  try {
    await profile.runHandler(
      new vscode.TestRunRequest([...items], undefined, profile),
      source.token,
    );
  } finally {
    source.dispose();
  }
}

/** The SharpLsp channel's log file, which the workbench writes as lines arrive. */
function channelLogOf(api: SharpLspExtensionApi): string {
  return path.join(api.logUri.fsPath, `${OUTPUT_CHANNEL_NAME}.log`);
}

/** Every line the SharpLsp channel has logged so far. */
function logLines(api: SharpLspExtensionApi): string[] {
  const file = channelLogOf(api);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
}

/** A mark in the log: only lines written AFTER it belong to what comes next. */
export function logMark(api: SharpLspExtensionApi): number {
  return logLines(api).length;
}

/** The lines logged since `mark` that contain `text`. */
export function loggedSince(api: SharpLspExtensionApi, mark: number, text: string): string[] {
  return logLines(api)
    .slice(Math.max(mark - 1, 0))
    .filter((line) => line.includes(text));
}

/**
 * Discovery of `solution`, run ONCE however many tests need the tree, and
 * failing — never passing vacuously — when any `expected` id is missing.
 */
export function discoverOnce(
  api: () => SharpLspExtensionApi,
  solution: () => string,
  expected: readonly string[],
): () => Promise<void> {
  let sweep: Promise<string[]> | undefined;
  return async () => {
    sweep ??= discoverSolution(api(), solution(), expected, REAL_REPO_WARMUP_MS);
    await sweep;
    const tree = collectLeafIds(api().testController.items);
    const missing = expected.filter((id) => !tree.includes(id));
    assert.deepStrictEqual(missing, [], 'every id the suite names is a row in the tree');
  };
}

/** What a class run must report: how many tests, and the frameworks behind them. */
export interface ClassRun {
  /** Any test of the class; its parent row is what gets run. */
  readonly anyTest: string;
  /** How many tests the class lists at the pinned commit. */
  readonly count: number;
  /** The frameworks the test project declares. */
  readonly declared: readonly string[];
  /** The `netN.0` runtimes this agent has. */
  readonly installed: readonly string[];
}

/**
 * ▶ on a class row: every test in it passes with a real outcome, and every
 * declared framework this agent cannot run is LOGGED as reporting no result —
 * never turned into a failure or a missing test ([NETFX-SCOPE]).
 */
export async function assertClassRunPasses(
  api: SharpLspExtensionApi,
  run: ClassRun,
): Promise<void> {
  const row = classRowOf(api, run.anyTest);
  const ids = collectLeafIds(row.children);
  assert.strictEqual(ids.length, run.count, `${row.label} lists ${String(run.count)} tests`);
  const mark = logMark(api);
  await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [row]);
  for (const id of ids) assertPassed(assertReported(api, id), id);
  const unrunnable = run.declared.filter((tfm) => !runnableHere(tfm, run.installed));
  for (const tfm of unrunnable) await awaitLogged(api, mark, `Test run: ${tfm} reported no result`);
}

/** Poll until a line containing `text` is logged after `mark`; return them all. */
export async function awaitLogged(
  api: SharpLspExtensionApi,
  mark: number,
  text: string,
): Promise<string[]> {
  const found = await pollUntilResult(
    async () => loggedSince(api, mark, text),
    (lines) => lines.length > 0,
    LSP_RESPONSE_MS,
    250,
    `the SharpLsp log to record '${text}'`,
  );
  assert.ok(found.length > 0, `the SharpLsp log must record '${text}' after the mark`);
  return found;
}
