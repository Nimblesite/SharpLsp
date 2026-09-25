// The active-framework surface of a multi-targeted project, observed the way a
// user meets it: the two `sharplsp/*TargetFramework` requests, the status-bar
// view the extension API exposes, the quick pick behind
// `sharplsp.selectTargetFramework`, and hovers that resolve only under the
// framework whose `#if` branch is live.
//
// Every accessor VALIDATES what it reads instead of trusting it: a request that
// answers the wrong shape, or an API member that was never wired, fails here
// under its own name rather than as an `undefined` three assertions later.
//
// Observes [NETFX-CONTEXT], [NETFX-PROJECTS-CSHARP] and [NETFX-PROJECTS-FSHARP].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { isRecord } from '../../utils.js';
import { hoverText } from './fsharp-helpers';
import { positionOf } from './real-repo-helpers';
import type { Anchor } from './real-repo-kit';
import { sendRealLspRequest } from './refactor-test-helpers';
import { pollUntilResult } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';
import type { UiStubs } from './ui-stubs';

/** The command that switches a project's framework, or offers the pick. */
export const SELECT_TARGET_FRAMEWORK = 'sharplsp.selectTargetFramework';

/** What both `sharplsp/*TargetFramework` requests answer ([NETFX-CONTEXT]). */
export interface FrameworkContext {
  /** The framework the project answers from; `null` for a single-target one. */
  readonly active: string | null;
  /** The project's `<TargetFrameworks>`, in declared order; empty when single. */
  readonly available: readonly string[];
}

/** The live status-bar view the extension API exposes ([NETFX-CONTEXT]). */
export interface FrameworkStatus {
  readonly item: vscode.StatusBarItem;
  readonly visible: boolean;
  readonly active: string | undefined;
  readonly available: readonly string[];
}

/** The extension API, plus the [NETFX-CONTEXT] view it must expose. */
type NetfxApi = SharpLspExtensionApi & { readonly targetFrameworkStatus?: FrameworkStatus };

/** Parse a request's reply, failing on any shape [NETFX-CONTEXT] does not allow. */
function contextOf(reply: unknown, method: string): FrameworkContext {
  assert.ok(isRecord(reply), `${method} must answer an object, got ${JSON.stringify(reply)}`);
  const { active, available } = reply;
  assert.ok(active === null || typeof active === 'string', `${method}: active is a tfm or null`);
  assert.ok(Array.isArray(available), `${method}: available must be an array`);
  const values: unknown[] = available;
  const tfms = values.filter((value): value is string => typeof value === 'string');
  assert.strictEqual(tfms.length, values.length, `${method}: available holds only tfms`);
  return { active, available: tfms };
}

/** The `TextDocumentIdentifier` both requests take. */
function documentOf(uri: vscode.Uri): { readonly uri: string } {
  return { uri: uri.toString() };
}

/** `sharplsp/targetFramework` for the project that owns `uri`. */
export async function frameworkContextOf(uri: vscode.Uri): Promise<FrameworkContext> {
  const method = 'sharplsp/targetFramework';
  return contextOf(
    await sendRealLspRequest<unknown>(method, { textDocument: documentOf(uri) }),
    method,
  );
}

/** `sharplsp/setTargetFramework`: switch the WHOLE project owning `uri`. */
export async function switchFramework(uri: vscode.Uri, tfm: string): Promise<FrameworkContext> {
  const method = 'sharplsp/setTargetFramework';
  const params = { textDocument: documentOf(uri), targetFramework: tfm };
  return contextOf(await sendRealLspRequest<unknown>(method, params), method);
}

/** A context is exactly `active` over `available`, in declared order. */
export function assertContext(
  context: FrameworkContext,
  active: string | null,
  available: readonly string[],
  why: string,
): void {
  assert.strictEqual(context.active, active, `${why}: the active framework`);
  assert.deepStrictEqual(
    [...context.available],
    [...available],
    `${why}: every declared framework, in <TargetFrameworks> order`,
  );
  assert.strictEqual(
    context.available.length === 0,
    active === null,
    `${why}: only a single-target project has no active framework and nothing to choose`,
  );
}

/** Switch `uri`'s project to `tfm` and assert the reply names exactly that. */
export async function assertSwitched(
  uri: vscode.Uri,
  tfm: string,
  available: readonly string[],
): Promise<void> {
  assertContext(await switchFramework(uri, tfm), tfm, available, `switching to ${tfm}`);
  assertContext(await frameworkContextOf(uri), tfm, available, `re-reading after ${tfm}`);
}

/** A project's declared frameworks, and the one it answers from by default. */
export interface ProjectFrameworks {
  /** The FIRST entry of `<TargetFrameworks>` ([NETFX-CONTEXT]). */
  readonly first: string;
  /** Every entry of `<TargetFrameworks>`, in declared order. */
  readonly available: readonly string[];
}

/** The frameworks a project declares, its default being the first of them. */
export function declared(...available: readonly string[]): ProjectFrameworks {
  const [first] = available;
  assert.ok(first !== undefined, 'a multi-targeted project declares at least one framework');
  return { first, available };
}

/**
 * Switch `uri`'s project to `tfm` for the duration of `body`, then put it back
 * on its default, so no test leaks its framework into the next.
 */
export async function underFramework(
  uri: vscode.Uri,
  tfm: string,
  project: ProjectFrameworks,
  body: () => Promise<void>,
): Promise<void> {
  await assertSwitched(uri, tfm, project.available);
  try {
    await body();
  } finally {
    assertContext(
      await switchFramework(uri, project.first),
      project.first,
      project.available,
      'restoring',
    );
  }
}

/**
 * Under the active framework, every `live` anchor's hover resolves and names
 * its identifier, and every `inert` anchor — code in an `#if` branch that
 * framework does not compile — resolves to nothing at all.
 */
export async function assertBranches(
  doc: vscode.TextDocument,
  framework: string,
  branches: { readonly live: readonly Anchor[]; readonly inert: readonly Anchor[] },
): Promise<void> {
  for (const [snippet, focus] of branches.live) {
    await assertHoverResolves(
      doc.uri,
      positionOf(doc, snippet, focus),
      focus,
      `${focus} under ${framework}`,
    );
  }
  for (const [snippet, focus] of branches.inert) {
    await assertHoverInert(doc.uri, positionOf(doc, snippet, focus), `${focus} under ${framework}`);
  }
}

/** The API's live status view, asserted wired. */
export function frameworkStatusOf(api: SharpLspExtensionApi): FrameworkStatus {
  const netfx: NetfxApi = api;
  const status = netfx.targetFrameworkStatus;
  assert.ok(status, 'the extension API must expose targetFrameworkStatus ([NETFX-CONTEXT])');
  return status;
}

/** The command id a status item runs, whichever form it was given in. */
function commandIdOf(command: string | vscode.Command | undefined): string | undefined {
  return typeof command === 'string' ? command : command?.command;
}

/** The status item's command is really registered: a click must reach a handler. */
async function assertCommandRegistered(command: string | undefined): Promise<void> {
  assert.strictEqual(
    command,
    SELECT_TARGET_FRAMEWORK,
    'clicking the item opens the framework pick',
  );
  const registered = await vscode.commands.getCommands(true);
  assert.ok(
    registered.includes(SELECT_TARGET_FRAMEWORK),
    `${SELECT_TARGET_FRAMEWORK} is registered`,
  );
}

/** Poll the live status view until it shows `active`, then assert all of it. */
export async function assertStatusShows(
  api: SharpLspExtensionApi,
  active: string,
  available: readonly string[],
): Promise<void> {
  const status = frameworkStatusOf(api);
  const why = `the status bar showing ${active}`;
  await pollUntilResult(
    async () => status.active,
    (shown) => shown === active,
    LSP_RESPONSE_MS,
    250,
    why,
  );
  assert.ok(status.visible, `${why}: a multi-targeted document shows the framework item`);
  assert.strictEqual(status.active, active, `${why}: the view names the active framework`);
  assert.deepStrictEqual([...status.available], [...available], `${why}: offering every one`);
  assert.strictEqual(status.item.text, `$(versions) ${active}`, `${why}: icon, then the tfm`);
  await assertCommandRegistered(commandIdOf(status.item.command));
}

/** Poll the live status view until it hides, then assert nothing is offered. */
export async function assertStatusHidden(api: SharpLspExtensionApi, why: string): Promise<void> {
  const status = frameworkStatusOf(api);
  await pollUntilResult(
    async () => status.visible,
    (visible) => !visible,
    LSP_RESPONSE_MS,
    250,
    why,
  );
  assert.ok(!status.visible, `${why}: the framework item is hidden`);
  assert.deepStrictEqual([...status.available], [], `${why}: there is nothing to choose between`);
}

/** One quick-pick item, as the framework pick must shape it. */
interface FrameworkPickItem {
  readonly label: string;
  readonly description: unknown;
  readonly picked: unknown;
}

/** Parse what the pick offered, failing on anything that is not an item. */
function pickItemsOf(offered: readonly unknown[]): FrameworkPickItem[] {
  return offered.map((item, index) => {
    assert.ok(isRecord(item), `pick item ${String(index)} must be a QuickPickItem`);
    assert.strictEqual(typeof item.label, 'string', `pick item ${String(index)} has a label`);
    return { label: String(item.label), description: item.description, picked: item.picked };
  });
}

/**
 * Open the framework pick with NO argument, choose `tfm` in it, and assert the
 * pick offered every framework of `project` in declared order, with exactly the
 * `active` one marked and pre-picked ([NETFX-CONTEXT]).
 */
export async function pickFramework(
  stubs: UiStubs,
  project: string,
  choice: { readonly tfm: string; readonly active: string; readonly available: readonly string[] },
): Promise<void> {
  const before = stubs.log.quickPickItems.length;
  stubs.queuePick((items) => items.find((item) => isRecord(item) && item.label === choice.tfm));
  await vscode.commands.executeCommand(SELECT_TARGET_FRAMEWORK);
  assert.strictEqual(stubs.log.quickPickItems.length, before + 1, 'no argument opens ONE pick');
  const items = pickItemsOf(stubs.log.quickPickItems.at(-1) ?? []);
  assert.deepStrictEqual(
    items.map((item) => item.label),
    [...choice.available],
    'declared order',
  );
  const marked = items.filter((item) => item.description === 'active').map((item) => item.label);
  assert.deepStrictEqual(marked, [choice.active], 'exactly the active framework is marked');
  const picked = items.filter((item) => item.picked === true).map((item) => item.label);
  assert.deepStrictEqual(picked, [choice.active], 'and it alone is pre-picked');
  const placeHolder = stubs.log.quickPickOptions.at(-1)?.placeHolder;
  assert.strictEqual(placeHolder, `Target framework for ${project}`, 'the pick names its project');
}

/** The hover text at `position` once it satisfies `accept`, or the last one read. */
async function hoverTextWhen(
  uri: vscode.Uri,
  position: vscode.Position,
  accept: (text: string) => boolean,
  waitingFor: string,
): Promise<string> {
  const read = async (): Promise<string> =>
    hoverText(
      (await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
        'vscode.executeHoverProvider',
        uri,
        position,
      )) ?? [],
    );
  return await pollUntilResult(read, accept, LSP_RESPONSE_MS, 500, waitingFor);
}

/** Hover at `position` RESOLVES: non-empty, and naming `identifier`. */
export async function assertHoverResolves(
  uri: vscode.Uri,
  position: vscode.Position,
  identifier: string,
  why: string,
): Promise<string> {
  const text = await hoverTextWhen(uri, position, (read) => read.includes(identifier), why);
  assert.ok(text.trim().length > 0, `${why}: the hover must not be empty`);
  assert.ok(text.includes(identifier), `${why}: the hover names ${identifier}, got: ${text}`);
  return text;
}

/**
 * Hover at `position` is EMPTY: the code there sits in an `#if` branch the
 * ACTIVE framework does not compile, so nothing in it may resolve.
 */
export async function assertHoverInert(
  uri: vscode.Uri,
  position: vscode.Position,
  why: string,
): Promise<void> {
  const text = await hoverTextWhen(uri, position, (read) => read.trim() === '', why);
  assert.strictEqual(text.trim(), '', `${why}: inactive code must not resolve, got: ${text}`);
}
