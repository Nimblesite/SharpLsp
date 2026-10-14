/**
 * How the Solution Explorer lays namespaces out: nested on `.` like folders
 * (the default), or one flat row per namespace, switched from the view's title
 * bar and kept in the `sharplsp.solutionExplorer.nestNamespaces` setting.
 * Implements [SE-TREE-NAMESPACE-NEST].
 */
import { commands, ConfigurationTarget, type ExtensionContext, workspace } from 'vscode';
import { CMD_FLATTEN_NAMESPACES, CMD_NEST_NAMESPACES, CONFIG_SECTION } from './constants.js';
import * as log from './log.js';
import * as state from './state.js';

const NEST_KEY = 'solutionExplorer.nestNamespaces';

/** Builds the row for one namespace from its label and its child rows. */
export type MakeNamespace<N> = (label: string, children: N[]) => N;

/** One segment of a namespace name: the rows declared in it and its child segments. */
interface Branch<N> {
  readonly segment: string;
  readonly own: N[];
  readonly children: Map<string, Branch<N>>;
}

/** The child of `level` named `segment`, created when it is not there yet. */
function childOf<N>(level: Map<string, Branch<N>>, segment: string): Branch<N> {
  const existing = level.get(segment);
  if (existing !== undefined) return existing;
  const created: Branch<N> = { segment, own: [], children: new Map() };
  level.set(segment, created);
  return created;
}

/** The branch for `fullName`, creating every missing segment on the way down. */
function branchFor<N>(roots: Map<string, Branch<N>>, fullName: string): Branch<N> {
  const [head, ...tail] = fullName.split('.');
  return tail.reduce(
    (parent, segment) => childOf(parent.children, segment),
    childOf(roots, head ?? fullName),
  );
}

/**
 * The row for `branch`. A segment that declares nothing itself and has exactly
 * one child folds into that child (`SharpLsp.TestFixtures`), so a project's
 * root namespace is one row, not a chain of clicks.
 */
function fold<N>(branch: Branch<N>, make: MakeNamespace<N>, prefix: string): N {
  const label = `${prefix}${branch.segment}`;
  const [only, ...others] = branch.children.values();
  if (branch.own.length === 0 && only !== undefined && others.length === 0) {
    return fold(only, make, `${label}.`);
  }
  const nested = [...branch.children.values()].map((child) => fold(child, make, ''));
  return make(label, [...nested, ...branch.own]);
}

/**
 * Rows for merged namespaces (full name → member rows, in first-seen order):
 * child namespaces before a namespace's own members when nested, one row per
 * full name when flat.
 */
export function arrangeNamespaces<N>(
  namespaces: ReadonlyMap<string, N[]>,
  nest: boolean,
  make: MakeNamespace<N>,
): N[] {
  if (!nest) return [...namespaces].map(([name, members]) => make(name, members));
  const roots = new Map<string, Branch<N>>();
  for (const [name, members] of namespaces) {
    branchFor(roots, name).own.push(...members);
  }
  return [...roots.values()].map((root) => fold(root, make, ''));
}

/** The layout the setting asks for. */
function nestingSetting(): boolean {
  return workspace.getConfiguration(CONFIG_SECTION).get<boolean>(NEST_KEY, true);
}

/** Store `nest` where it takes effect: the workspace when it pins a value, else the user. */
async function storeNesting(nest: boolean): Promise<void> {
  const section = workspace.getConfiguration(CONFIG_SECTION);
  const pinned = section.inspect<boolean>(NEST_KEY)?.workspaceValue !== undefined;
  log.traceInfo(`Namespace layout: ${nest ? 'nested' : 'flat'} (${pinned ? 'workspace' : 'user'})`);
  await section.update(
    NEST_KEY,
    nest,
    pinned ? ConfigurationTarget.Workspace : ConfigurationTarget.Global,
  );
}

/** Register the title-bar toggles and keep `state.nestNamespaces` in step with the setting. */
export function registerNamespaceLayout(context: ExtensionContext): void {
  state.nestNamespaces.value = nestingSetting();
  context.subscriptions.push(
    commands.registerCommand(CMD_NEST_NAMESPACES, async () => {
      await storeNesting(true);
    }),
    commands.registerCommand(CMD_FLATTEN_NAMESPACES, async () => {
      await storeNesting(false);
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${NEST_KEY}`)) {
        state.nestNamespaces.value = nestingSetting();
      }
    }),
  );
}
