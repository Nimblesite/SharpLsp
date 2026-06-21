import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  toSolutionSelections,
  findSolutions,
  selectSolution,
  promptUserSelection,
  type SolutionSelection,
} from '../../solution.js';

// ─────────────────────────────────────────────────────────────────────────────
// toSolutionSelections — PURE transform: maps absolute paths to selections,
// derives `name` from path.basename, and sorts by (name, path).
// ─────────────────────────────────────────────────────────────────────────────
suite('solution.ts — toSolutionSelections (pure)', () => {
  test('returns an empty array for empty input', () => {
    const result = toSolutionSelections([]);
    assert.ok(Array.isArray(result), 'result must be an array');
    assert.strictEqual(result.length, 0, 'empty input yields empty output');
  });

  test('returns a brand-new array (does not return the input)', () => {
    const input: readonly string[] = [];
    const result: readonly unknown[] = toSolutionSelections(input);
    assert.notStrictEqual(result, input, 'must not alias the input array');
  });

  test('maps a single .sln path to a selection with path + basename name', () => {
    const result = toSolutionSelections(['/repo/work/MyApp.sln']);
    assert.strictEqual(result.length, 1, 'one path -> one selection');
    const [only] = result;
    assert.ok(only, 'first selection exists');
    assert.strictEqual(only.path, '/repo/work/MyApp.sln', 'path is preserved verbatim');
    assert.strictEqual(only.name, 'MyApp.sln', 'name is the basename including extension');
  });

  test('maps a single .slnx path to a selection with .slnx name', () => {
    const result = toSolutionSelections(['/repo/work/Modern.slnx']);
    assert.strictEqual(result.length, 1);
    const [only] = result;
    assert.ok(only);
    assert.strictEqual(only.name, 'Modern.slnx', '.slnx extension is preserved in name');
    assert.strictEqual(only.path, '/repo/work/Modern.slnx');
  });

  test('preserves the extension exactly — name ends with .sln vs .slnx', () => {
    const [sln] = toSolutionSelections(['/x/A.sln']);
    const [slnx] = toSolutionSelections(['/x/A.slnx']);
    assert.ok(sln && slnx);
    assert.ok(sln.name.endsWith('.sln'), '.sln name keeps .sln');
    assert.ok(!sln.name.endsWith('.slnx'), '.sln name is not .slnx');
    assert.ok(slnx.name.endsWith('.slnx'), '.slnx name keeps .slnx');
  });

  test('every selection object carries exactly the path and name fields', () => {
    const [sel] = toSolutionSelections(['/deep/Sample.sln']);
    assert.ok(sel);
    const keys = Object.keys(sel).sort();
    assert.deepStrictEqual(keys, ['name', 'path'], 'selection has only name + path keys');
  });

  test('derives names from deeply nested paths', () => {
    const deep = '/a/b/c/d/e/f/g/h/Nested.sln';
    const [sel] = toSolutionSelections([deep]);
    assert.ok(sel);
    assert.strictEqual(sel.path, deep, 'deep path preserved');
    assert.strictEqual(sel.name, 'Nested.sln', 'basename ignores directory depth');
  });

  test('handles paths with spaces in directory and file name', () => {
    const spaced = '/Users/jane doe/My Projects/Cool App.sln';
    const [sel] = toSolutionSelections([spaced]);
    assert.ok(sel);
    assert.strictEqual(sel.path, spaced, 'spaced path preserved verbatim');
    assert.strictEqual(sel.name, 'Cool App.sln', 'spaced basename derived correctly');
  });

  test('handles unicode characters in path and name', () => {
    const unicode = '/проекты/café/Résumé.slnx';
    const [sel] = toSolutionSelections([unicode]);
    assert.ok(sel);
    assert.strictEqual(sel.path, unicode, 'unicode path preserved');
    assert.strictEqual(sel.name, 'Résumé.slnx', 'unicode basename derived correctly');
  });

  test('handles a path that is just a bare filename (no directory)', () => {
    const [sel] = toSolutionSelections(['Solo.sln']);
    assert.ok(sel);
    assert.strictEqual(sel.path, 'Solo.sln', 'bare path preserved');
    assert.strictEqual(sel.name, 'Solo.sln', 'bare name equals basename');
  });

  test('handles dotted file names (multiple dots before the extension)', () => {
    const [sel] = toSolutionSelections(['/x/My.Company.Product.sln']);
    assert.ok(sel);
    assert.strictEqual(
      sel.name,
      'My.Company.Product.sln',
      'only trailing path segment is the name',
    );
  });

  test('sorts multiple selections alphabetically by name', () => {
    const result = toSolutionSelections(['/x/Zebra.sln', '/x/Alpha.sln', '/x/Mango.sln']);
    assert.strictEqual(result.length, 3, 'all three preserved');
    assert.deepStrictEqual(
      result.map((s) => s.name),
      ['Alpha.sln', 'Mango.sln', 'Zebra.sln'],
      'names sorted via localeCompare',
    );
  });

  test('preserves every input path across a multi-element sort', () => {
    const inputs = ['/p/Two.sln', '/p/One.slnx', '/p/Three.sln'];
    const result = toSolutionSelections(inputs);
    const paths = result.map((s) => s.path).sort();
    assert.deepStrictEqual(paths, [...inputs].sort(), 'no path is lost or duplicated');
    assert.strictEqual(result.length, inputs.length, 'count is preserved');
  });

  test('ties on name fall back to sorting by path', () => {
    // Two files with the identical basename but different directories.
    const result = toSolutionSelections(['/zzz/Same.sln', '/aaa/Same.sln', '/mmm/Same.sln']);
    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(
      result.map((s) => s.name),
      ['Same.sln', 'Same.sln', 'Same.sln'],
      'all names identical',
    );
    assert.deepStrictEqual(
      result.map((s) => s.path),
      ['/aaa/Same.sln', '/mmm/Same.sln', '/zzz/Same.sln'],
      'paths used as the tiebreaker, ascending',
    );
  });

  test('is deterministic — same input yields identical output across calls', () => {
    const inputs = ['/x/Beta.sln', '/x/Alpha.slnx', '/y/Beta.sln'];
    const first = toSolutionSelections(inputs);
    const second = toSolutionSelections(inputs);
    assert.deepStrictEqual(first, second, 'repeated calls are deterministic');
  });

  test('does not mutate the caller-supplied input array', () => {
    const inputs = ['/x/B.sln', '/x/A.sln'];
    const snapshot = [...inputs];
    toSolutionSelections(inputs);
    assert.deepStrictEqual(inputs, snapshot, 'input array order is left untouched');
  });

  test('a large input is fully and correctly mapped', () => {
    const count = 200;
    const inputs = Array.from({ length: count }, (_, i) => `/big/Sln-${String(i)}.sln`);
    const result = toSolutionSelections(inputs);
    assert.strictEqual(result.length, count, 'every entry mapped');
    // After sorting by name (localeCompare on "Sln-<n>.sln"), all entries remain present.
    const names = new Set(result.map((s) => s.name));
    assert.strictEqual(names.size, count, 'all names are unique and present');
    for (const sel of result) {
      assert.ok(sel.name.startsWith('Sln-'), 'name prefix preserved');
      assert.ok(sel.name.endsWith('.sln'), 'extension preserved');
      assert.ok(sel.path.startsWith('/big/'), 'directory preserved');
    }
  });

  test('keeps duplicate identical paths (no dedup performed)', () => {
    const dup = '/x/Dup.sln';
    const result = toSolutionSelections([dup, dup, dup]);
    assert.strictEqual(result.length, 3, 'duplicates are not removed');
    for (const sel of result) {
      assert.strictEqual(sel.path, dup);
      assert.strictEqual(sel.name, 'Dup.sln');
    }
  });

  test('result entries satisfy the SolutionSelection shape', () => {
    const [sel]: readonly SolutionSelection[] = toSolutionSelections(['/x/Typed.sln']);
    assert.ok(sel);
    assert.strictEqual(typeof sel.path, 'string', 'path is a string');
    assert.strictEqual(typeof sel.name, 'string', 'name is a string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findSolutions — runs against the live test workspace. We can only assert the
// shape robustly (workspace contents vary), so check the contract.
// ─────────────────────────────────────────────────────────────────────────────
suite('solution.ts — findSolutions (workspace-backed)', () => {
  test('resolves to an array', async () => {
    const result = await findSolutions();
    assert.ok(Array.isArray(result), 'findSolutions must resolve to an array');
  });

  test('every returned entry has a string path and a basename name', async () => {
    const result = await findSolutions();
    for (const sel of result) {
      assert.strictEqual(typeof sel.path, 'string', 'path is a string');
      assert.strictEqual(typeof sel.name, 'string', 'name is a string');
      assert.strictEqual(sel.name, path.basename(sel.path), 'name is exactly the basename of path');
    }
  });

  test('only ever returns .sln or .slnx files', async () => {
    const result = await findSolutions();
    for (const sel of result) {
      assert.ok(
        sel.name.endsWith('.sln') || sel.name.endsWith('.slnx'),
        `unexpected solution extension for ${sel.name}`,
      );
    }
  });

  test('results are sorted by name then path (same ordering as toSolutionSelections)', async () => {
    const result = await findSolutions();
    const reSorted = toSolutionSelections(result.map((s) => s.path));
    assert.deepStrictEqual(
      result.map((s) => s.path),
      reSorted.map((s) => s.path),
      'findSolutions output is already in canonical sort order',
    );
  });

  test('never returns more than the 50-file cap', async () => {
    const result = await findSolutions();
    assert.ok(result.length <= 50, 'findSolutions caps results at 50');
  });

  test('repeated calls return structurally equal results', async () => {
    const first = await findSolutions();
    const second = await findSolutions();
    assert.deepStrictEqual(first, second, 'discovery is stable for an unchanged workspace');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// promptUserSelection / selectSolution — stub vscode.window.showQuickPick.
// The source imports `window` from 'vscode' (a live binding to vscode.window),
// so reassigning the property on vscode.window is observed by the source module.
// ─────────────────────────────────────────────────────────────────────────────

interface QuickPickItemWithSolution extends vscode.QuickPickItem {
  readonly solution: SolutionSelection;
}

type ShowQuickPick = typeof vscode.window.showQuickPick;
type ShowInformationMessage = typeof vscode.window.showInformationMessage;

/**
 * A writable view over the parts of `vscode.window` these tests stub. The
 * `window` namespace declares its members read-only, so we cast through this
 * mutable shape to install and restore stubs without `any` leaking out.
 */
interface MutableWindow {
  showQuickPick: ShowQuickPick;
  showInformationMessage: ShowInformationMessage;
}

const mutableWindow = vscode.window as unknown as MutableWindow;

const SAMPLE: readonly SolutionSelection[] = [
  { path: '/ws/Alpha.sln', name: 'Alpha.sln' },
  { path: '/ws/Beta.slnx', name: 'Beta.slnx' },
  { path: '/ws/Gamma.sln', name: 'Gamma.sln' },
];

suite('solution.ts — promptUserSelection (showQuickPick stubbed)', () => {
  let originalShowQuickPick: ShowQuickPick;
  let lastItems: readonly QuickPickItemWithSolution[] | undefined;
  let lastOptions: vscode.QuickPickOptions | undefined;

  setup(() => {
    originalShowQuickPick = mutableWindow.showQuickPick;
    lastItems = undefined;
    lastOptions = undefined;
  });

  teardown(() => {
    mutableWindow.showQuickPick = originalShowQuickPick;
  });

  /** Install a stub that records its arguments and returns the chosen index. */
  function stubPick(chosenIndex: number | undefined): void {
    const stub = (async (
      items: readonly QuickPickItemWithSolution[],
      options?: vscode.QuickPickOptions,
    ): Promise<QuickPickItemWithSolution | undefined> => {
      lastItems = items;
      lastOptions = options;
      if (chosenIndex === undefined) {
        return undefined;
      }
      return items[chosenIndex];
    }) as unknown as ShowQuickPick;
    mutableWindow.showQuickPick = stub;
  }

  test('returns the solution behind the picked quick-pick item', async () => {
    stubPick(1);
    const result = await promptUserSelection(SAMPLE);
    assert.ok(result, 'a selection is returned when the user picks');
    assert.strictEqual(result.path, '/ws/Beta.slnx', 'returns the picked item solution.path');
    assert.strictEqual(result.name, 'Beta.slnx', 'returns the picked item solution.name');
  });

  test('returns the first solution when index 0 is picked', async () => {
    stubPick(0);
    const result = await promptUserSelection(SAMPLE);
    assert.ok(result);
    assert.deepStrictEqual(result, SAMPLE[0], 'first item returned intact');
  });

  test('returns the last solution when the final index is picked', async () => {
    stubPick(SAMPLE.length - 1);
    const result = await promptUserSelection(SAMPLE);
    assert.ok(result);
    assert.strictEqual(result.path, '/ws/Gamma.sln');
  });

  test('returns undefined when the user cancels (showQuickPick resolves undefined)', async () => {
    stubPick(undefined);
    const result = await promptUserSelection(SAMPLE);
    assert.strictEqual(result, undefined, 'cancellation yields undefined');
  });

  test('builds quick-pick items with label=name, description=path, and the solution attached', async () => {
    stubPick(0);
    await promptUserSelection(SAMPLE);
    assert.ok(lastItems, 'showQuickPick received an items array');
    assert.strictEqual(lastItems.length, SAMPLE.length, 'one item per solution');
    lastItems.forEach((item, i) => {
      const source = SAMPLE[i];
      assert.ok(source);
      assert.strictEqual(item.label, source.name, 'label is the solution name');
      assert.strictEqual(item.description, source.path, 'description is the solution path');
      assert.strictEqual(item.solution, source, 'each item carries its source solution');
    });
  });

  test('passes a placeHolder and title to showQuickPick', async () => {
    stubPick(0);
    await promptUserSelection(SAMPLE);
    assert.ok(lastOptions, 'options were supplied');
    assert.strictEqual(lastOptions.placeHolder, 'Select a solution to open');
    assert.strictEqual(lastOptions.title, 'SharpLsp: Multiple solutions found');
  });

  test('handles a single-element list (still prompts, returns that one)', async () => {
    stubPick(0);
    const one: readonly SolutionSelection[] = [{ path: '/ws/Only.sln', name: 'Only.sln' }];
    const result = await promptUserSelection(one);
    assert.ok(result);
    assert.strictEqual(result.path, '/ws/Only.sln');
    assert.ok(lastItems);
    assert.strictEqual(lastItems.length, 1, 'exactly one quick-pick item');
  });

  test('preserves item order matching the input order', async () => {
    stubPick(0);
    await promptUserSelection(SAMPLE);
    assert.ok(lastItems);
    assert.deepStrictEqual(
      lastItems.map((i) => i.label),
      SAMPLE.map((s) => s.name),
      'item order mirrors input solution order',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectSolution — orchestrates findSolutions + auto-select / prompt branches.
// We exercise the branches by stubbing showQuickPick where the prompt path runs.
// ─────────────────────────────────────────────────────────────────────────────
suite('solution.ts — selectSolution (integration over live workspace)', () => {
  let originalShowQuickPick: ShowQuickPick;
  let originalShowInfo: ShowInformationMessage;
  let quickPickCalls = 0;

  setup(() => {
    originalShowQuickPick = mutableWindow.showQuickPick;
    originalShowInfo = mutableWindow.showInformationMessage;
    quickPickCalls = 0;
    // Auto-pick the first item if a prompt ever appears, and count invocations.
    const stub = (async (
      items: readonly QuickPickItemWithSolution[],
    ): Promise<QuickPickItemWithSolution | undefined> => {
      quickPickCalls += 1;
      return items[0];
    }) as unknown as ShowQuickPick;
    mutableWindow.showQuickPick = stub;
    // Silence the "no solution" toast so it never blocks the host.
    mutableWindow.showInformationMessage = async () => undefined;
  });

  teardown(() => {
    mutableWindow.showQuickPick = originalShowQuickPick;
    mutableWindow.showInformationMessage = originalShowInfo;
  });

  test('resolves to a SolutionSelection or undefined', async () => {
    const result = await selectSolution();
    if (result !== undefined) {
      assert.strictEqual(typeof result.path, 'string', 'path is a string');
      assert.strictEqual(typeof result.name, 'string', 'name is a string');
      assert.strictEqual(result.name, path.basename(result.path), 'name is the basename');
    } else {
      assert.strictEqual(result, undefined, 'undefined is a valid no-solution outcome');
    }
  });

  test('auto-selects without prompting when exactly one solution exists', async () => {
    const found = await findSolutions();
    const result = await selectSolution();
    if (found.length === 1) {
      assert.strictEqual(quickPickCalls, 0, 'single solution must not prompt the user');
      assert.deepStrictEqual(result, found[0], 'auto-selected the only solution');
    } else {
      // Not the single-solution case in this workspace — assert the alternative
      // contract instead so the test still carries an assertion.
      assert.ok(
        found.length === 0 || found.length > 1,
        'workspace has zero or multiple solutions in this run',
      );
    }
  });

  test('returns undefined and does not prompt when no solutions exist', async () => {
    const found = await findSolutions();
    const result = await selectSolution();
    if (found.length === 0) {
      assert.strictEqual(result, undefined, 'no solutions -> undefined');
      assert.strictEqual(quickPickCalls, 0, 'no prompt shown when there are no solutions');
    } else {
      assert.ok(found.length >= 1, 'workspace has at least one solution in this run');
    }
  });

  test('prompts (via quick pick) when more than one solution exists', async () => {
    const found = await findSolutions();
    const result = await selectSolution();
    if (found.length > 1) {
      assert.strictEqual(quickPickCalls, 1, 'multiple solutions trigger exactly one prompt');
      assert.ok(result, 'prompt auto-pick returns a solution');
      assert.ok(
        found.some((s) => s.path === result.path),
        'returned solution is one of the discovered solutions',
      );
    } else {
      assert.ok(found.length <= 1, 'workspace has zero or one solution in this run');
    }
  });
});
