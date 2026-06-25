// Pure-logic unit tests for the NuGet module helpers.
//
// `isNuGetSearchResult` is the runtime contract that guards every NuGet.org
// response before it reaches `searchNuGet`; its exact shape acceptance/rejection
// matters because a wrong type-guard would let malformed JSON through. We pin the
// guard to the literal predicate it implements:
//   value !== null && typeof value === 'object' && 'data' in value && Array.isArray(value.data)
// Note it validates ONLY that `data` is an array — it deliberately does NOT
// inspect the inner package shape.
//
// `includePrerelease` reads `sharplsp.nuget.includePrerelease` (default false).
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  addNuGetPackage,
  addNuGetPackageToProject,
  includePrerelease,
  isNuGetSearchResult,
  restorePackages,
  updateNuGetPackage,
} from '../../nuget.js';

const CONFIG_SECTION = 'sharplsp';
const PRERELEASE_KEY = 'nuget.includePrerelease';

suite('NuGet Module — isNuGetSearchResult()', () => {
  // ── Valid shapes (the type guard must return true) ─────────────
  test('object with empty data array is accepted', () => {
    assert.strictEqual(isNuGetSearchResult({ data: [] }), true);
  });

  test('object with a single well-formed package is accepted', () => {
    const value = {
      data: [{ id: 'Newtonsoft.Json', version: '13.0.3', description: 'JSON', totalDownloads: 99 }],
    };
    assert.strictEqual(isNuGetSearchResult(value), true);
  });

  test('object with multiple packages is accepted', () => {
    const value = {
      data: [
        { id: 'Serilog', version: '3.0.0', description: 'log', totalDownloads: 1 },
        { id: 'AutoMapper', version: '12.0.0', description: 'map', totalDownloads: 2 },
      ],
    };
    assert.strictEqual(isNuGetSearchResult(value), true);
  });

  test('data array contents are NOT validated — non-package elements still pass', () => {
    // The guard only checks Array.isArray(value.data), never the element shape.
    assert.strictEqual(isNuGetSearchResult({ data: [1, 2, 3] }), true);
    assert.strictEqual(isNuGetSearchResult({ data: ['a', 'b'] }), true);
    assert.strictEqual(isNuGetSearchResult({ data: [null, undefined] }), true);
    assert.strictEqual(isNuGetSearchResult({ data: [{ wrong: 'shape' }] }), true);
    assert.strictEqual(isNuGetSearchResult({ data: [[], {}] }), true);
  });

  test('extra sibling fields alongside data are ignored (still accepted)', () => {
    const value = { data: [], totalHits: 42, '@context': {}, extra: 'ignored' };
    assert.strictEqual(isNuGetSearchResult(value), true);
  });

  test('a value whose narrowed type is usable after the guard', () => {
    const value: unknown = {
      data: [{ id: 'X', version: '1.0.0', description: '', totalDownloads: 0 }],
    };
    if (isNuGetSearchResult(value)) {
      // Inside the guard, TS narrows `value.data` to NuGetPackage[].
      assert.strictEqual(value.data.length, 1);
      assert.strictEqual(value.data[0]?.id, 'X');
    } else {
      assert.fail('guard should have accepted a well-formed result');
    }
  });

  // ── Null / undefined ───────────────────────────────────────────
  test('null is rejected', () => {
    assert.strictEqual(isNuGetSearchResult(null), false);
  });

  test('undefined is rejected', () => {
    assert.strictEqual(isNuGetSearchResult(undefined), false);
  });

  // ── Non-object primitives are rejected ─────────────────────────
  test('string primitive is rejected', () => {
    assert.strictEqual(isNuGetSearchResult('data'), false);
    assert.strictEqual(isNuGetSearchResult(''), false);
    assert.strictEqual(isNuGetSearchResult('{"data":[]}'), false);
  });

  test('number primitives are rejected', () => {
    assert.strictEqual(isNuGetSearchResult(0), false);
    assert.strictEqual(isNuGetSearchResult(42), false);
    assert.strictEqual(isNuGetSearchResult(-1), false);
    assert.strictEqual(isNuGetSearchResult(Number.NaN), false);
    assert.strictEqual(isNuGetSearchResult(Number.POSITIVE_INFINITY), false);
  });

  test('boolean primitives are rejected', () => {
    assert.strictEqual(isNuGetSearchResult(true), false);
    assert.strictEqual(isNuGetSearchResult(false), false);
  });

  test('bigint and symbol primitives are rejected', () => {
    assert.strictEqual(isNuGetSearchResult(10n), false);
    assert.strictEqual(isNuGetSearchResult(Symbol('data')), false);
  });

  test('function is rejected (typeof is "function", not "object")', () => {
    assert.strictEqual(
      isNuGetSearchResult(() => ({ data: [] })),
      false,
    );
    function namedFn(): void {
      /* no-op */
    }
    assert.strictEqual(isNuGetSearchResult(namedFn), false);
  });

  // ── Objects missing the `data` field ───────────────────────────
  test('empty object is rejected (no data key)', () => {
    assert.strictEqual(isNuGetSearchResult({}), false);
  });

  test('object with unrelated keys but no data is rejected', () => {
    assert.strictEqual(isNuGetSearchResult({ results: [], totalHits: 3 }), false);
  });

  test('object with a similarly-named but wrong key is rejected', () => {
    assert.strictEqual(isNuGetSearchResult({ Data: [] }), false);
    assert.strictEqual(isNuGetSearchResult({ datas: [] }), false);
    assert.strictEqual(isNuGetSearchResult({ ' data': [] }), false);
  });

  // ── Objects where `data` is not an array ───────────────────────
  test('data field that is an object (not array) is rejected', () => {
    assert.strictEqual(isNuGetSearchResult({ data: {} }), false);
    assert.strictEqual(isNuGetSearchResult({ data: { 0: 'x', length: 1 } }), false);
  });

  test('data field that is a primitive is rejected', () => {
    assert.strictEqual(isNuGetSearchResult({ data: 'not-an-array' }), false);
    assert.strictEqual(isNuGetSearchResult({ data: 123 }), false);
    assert.strictEqual(isNuGetSearchResult({ data: true }), false);
  });

  test('data field that is null is rejected', () => {
    assert.strictEqual(isNuGetSearchResult({ data: null }), false);
  });

  test('data field that is undefined (explicitly present) is rejected', () => {
    // `'data' in value` is true here, but Array.isArray(undefined) is false.
    assert.strictEqual(isNuGetSearchResult({ data: undefined }), false);
  });

  // ── Arrays as the top-level value ──────────────────────────────
  test('a plain array (no data property) is rejected', () => {
    assert.strictEqual(isNuGetSearchResult([]), false);
    assert.strictEqual(isNuGetSearchResult([1, 2, 3]), false);
    assert.strictEqual(isNuGetSearchResult([{ data: [] }]), false);
  });

  test('an array decorated with an array `data` property IS accepted', () => {
    // typeof [] === 'object', '"data" in arr' true, Array.isArray(arr.data) true.
    const decorated = Object.assign([] as unknown[], { data: [] as unknown[] });
    assert.strictEqual(isNuGetSearchResult(decorated), true);
  });

  test('an array decorated with a non-array `data` property is rejected', () => {
    const decorated = Object.assign([] as unknown[], { data: 'nope' });
    assert.strictEqual(isNuGetSearchResult(decorated), false);
  });

  // ── Prototype / inherited data is honoured by `in` ─────────────
  test('inherited (prototype-chain) data array is accepted because `in` walks the chain', () => {
    const proto = { data: [] as unknown[] };
    const child = Object.create(proto) as object;
    // `'data' in child` is true via the prototype, and proto.data is an array.
    assert.strictEqual(isNuGetSearchResult(child), true);
  });

  test('object with null prototype and own data array is accepted', () => {
    const bare = Object.assign(Object.create(null) as object, { data: [] as unknown[] });
    assert.strictEqual(isNuGetSearchResult(bare), true);
  });

  test('object with null prototype and no data is rejected', () => {
    const bare = Object.create(null) as object;
    assert.strictEqual(isNuGetSearchResult(bare), false);
  });

  // ── Real-world-ish NuGet.org payload ───────────────────────────
  test('realistic NuGet.org response payload is accepted', () => {
    const payload = {
      '@context': { '@vocab': 'http://schema.nuget.org/schema#' },
      totalHits: 1,
      data: [
        {
          '@id': 'https://api.nuget.org/v3/registration5-semver1/newtonsoft.json/index.json',
          id: 'Newtonsoft.Json',
          version: '13.0.3',
          description: 'Json.NET is a popular JSON framework for .NET',
          totalDownloads: 4_000_000_000,
          verified: true,
        },
      ],
    };
    assert.strictEqual(isNuGetSearchResult(payload), true);
  });

  // ── Idempotency / purity ───────────────────────────────────────
  test('guard is pure — repeated calls on the same value agree', () => {
    const value = { data: [] };
    assert.strictEqual(isNuGetSearchResult(value), isNuGetSearchResult(value));
    assert.strictEqual(isNuGetSearchResult(value), true);
    assert.strictEqual(isNuGetSearchResult(value), true);
  });

  test('guard does not mutate the inspected value', () => {
    const value = { data: [{ id: 'A', version: '1.0.0', description: 'd', totalDownloads: 5 }] };
    const snapshot = JSON.stringify(value);
    isNuGetSearchResult(value);
    assert.strictEqual(JSON.stringify(value), snapshot);
  });
});

suite('NuGet Module — includePrerelease()', () => {
  let original: boolean | undefined;

  setup(() => {
    original = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(PRERELEASE_KEY);
  });

  teardown(async () => {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(PRERELEASE_KEY, original, vscode.ConfigurationTarget.Workspace);
  });

  test('returns a boolean', () => {
    assert.strictEqual(typeof includePrerelease(), 'boolean');
  });

  test('defaults to false when configuration is unset (package.json default)', async () => {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(PRERELEASE_KEY, undefined, vscode.ConfigurationTarget.Workspace);
    assert.strictEqual(includePrerelease(), false);
  });

  test('returns true when configured true', async () => {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(PRERELEASE_KEY, true, vscode.ConfigurationTarget.Workspace);
    assert.strictEqual(includePrerelease(), true);
  });

  test('returns false when configured false', async () => {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(PRERELEASE_KEY, false, vscode.ConfigurationTarget.Workspace);
    assert.strictEqual(includePrerelease(), false);
  });

  test('reflects a toggle from true back to false within one suite', async () => {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await wsConfig.update(PRERELEASE_KEY, true, vscode.ConfigurationTarget.Workspace);
    assert.strictEqual(includePrerelease(), true, 'must observe the true update');
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(PRERELEASE_KEY, false, vscode.ConfigurationTarget.Workspace);
    assert.strictEqual(includePrerelease(), false, 'must observe the subsequent false update');
  });

  test('is callable repeatedly and remains consistent for a fixed config', async () => {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(PRERELEASE_KEY, true, vscode.ConfigurationTarget.Workspace);
    const a = includePrerelease();
    const b = includePrerelease();
    assert.strictEqual(a, b);
    assert.strictEqual(a, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Async UI commands — addNuGetPackage / updateNuGetPackage / restorePackages /
// addNuGetPackageToProject. These drive the vscode.window.* prompts and (on the
// happy path) `fetch` + `dotnet`. We monkeypatch every window method they use and
// `globalThis.fetch`, recording the prompts shown and asserting that cancel /
// validation / "no results" / error branches short-circuit BEFORE any dotnet
// spawn. Every stub is saved in `setup` and restored in `teardown` so unrelated
// suites are never affected.
// ─────────────────────────────────────────────────────────────────────────────

type ShowInputBox = typeof vscode.window.showInputBox;
type ShowQuickPick = typeof vscode.window.showQuickPick;
type ShowInfo = typeof vscode.window.showInformationMessage;
type ShowError = typeof vscode.window.showErrorMessage;
type ShowWarning = typeof vscode.window.showWarningMessage;
type FindFiles = typeof vscode.workspace.findFiles;
type Fetch = typeof globalThis.fetch;

/** Writable view over the read-only window/workspace members these tests stub. */
interface MutableWindow {
  showInputBox: ShowInputBox;
  showQuickPick: ShowQuickPick;
  showInformationMessage: ShowInfo;
  showErrorMessage: ShowError;
  showWarningMessage: ShowWarning;
}
interface MutableWorkspace {
  findFiles: FindFiles;
}

const mutWindow = vscode.window as unknown as MutableWindow;
const mutWorkspace = vscode.workspace as unknown as MutableWorkspace;
const mutGlobal = globalThis as unknown as { fetch: Fetch };

/** Records every prompt the command-under-test triggered, in order. */
interface PromptLog {
  inputBoxOptions: (vscode.InputBoxOptions | undefined)[];
  quickPickOptions: (vscode.QuickPickOptions | undefined)[];
  quickPickItems: unknown[][];
  infoMessages: string[];
  errorMessages: string[];
  warningMessages: string[];
  fetchUrls: string[];
}

/** A minimal NuGet.org-shaped package row. */
function pkg(id: string, version: string): Record<string, unknown> {
  return { id, version, description: `${id} desc`, totalDownloads: 1 };
}

/** Build a stub `fetch` that returns a JSON body / status of our choosing. */
function fetchReturning(body: unknown, ok = true, status = 200): Fetch {
  return (async (input: unknown): Promise<unknown> => {
    log.fetchUrls.push(String(input));
    return {
      ok,
      status,
      json: async (): Promise<unknown> => body,
    };
  }) as unknown as Fetch;
}

let log: PromptLog;
let origInputBox: ShowInputBox;
let origQuickPick: ShowQuickPick;
let origInfo: ShowInfo;
let origError: ShowError;
let origWarning: ShowWarning;
let origFindFiles: FindFiles;
let origFetch: Fetch;

/** Install the shared prompt/fetch harness. Individual tests override returns. */
function installHarness(): void {
  log = {
    inputBoxOptions: [],
    quickPickOptions: [],
    quickPickItems: [],
    infoMessages: [],
    errorMessages: [],
    warningMessages: [],
    fetchUrls: [],
  };
  // Defaults: every prompt is "cancelled" / silent unless a test overrides it.
  mutWindow.showInputBox = async (options?: vscode.InputBoxOptions) => {
    log.inputBoxOptions.push(options);
    return undefined;
  };
  mutWindow.showQuickPick = async (items: unknown, options?: vscode.QuickPickOptions) => {
    log.quickPickItems.push((await items) as unknown[]);
    log.quickPickOptions.push(options);
    return undefined;
  };
  mutWindow.showInformationMessage = async (message: string) => {
    log.infoMessages.push(message);
    return undefined;
  };
  mutWindow.showErrorMessage = async (message: string) => {
    log.errorMessages.push(message);
    return undefined;
  };
  mutWindow.showWarningMessage = async (message: string) => {
    log.warningMessages.push(message);
    return undefined;
  };
  mutWorkspace.findFiles = async () => [] as vscode.Uri[];
  mutGlobal.fetch = fetchReturning({ data: [] });
}

function saveOriginals(): void {
  origInputBox = mutWindow.showInputBox;
  origQuickPick = mutWindow.showQuickPick;
  origInfo = mutWindow.showInformationMessage;
  origError = mutWindow.showErrorMessage;
  origWarning = mutWindow.showWarningMessage;
  origFindFiles = mutWorkspace.findFiles;
  origFetch = mutGlobal.fetch;
}

function restoreOriginals(): void {
  mutWindow.showInputBox = origInputBox;
  mutWindow.showQuickPick = origQuickPick;
  mutWindow.showInformationMessage = origInfo;
  mutWindow.showErrorMessage = origError;
  mutWindow.showWarningMessage = origWarning;
  mutWorkspace.findFiles = origFindFiles;
  mutGlobal.fetch = origFetch;
}

/** Stub showInputBox to return a fixed value (and keep recording options). */
function stubInputReturns(value: string | undefined): void {
  mutWindow.showInputBox = async (options?: vscode.InputBoxOptions) => {
    log.inputBoxOptions.push(options);
    return value;
  };
}

/** Stub showQuickPick to return the item at `index` (or undefined to cancel). */
function stubPickReturnsIndex(index: number | undefined): void {
  mutWindow.showQuickPick = (async (items: unknown, options?: vscode.QuickPickOptions) => {
    const resolved = (await items) as unknown[];
    log.quickPickItems.push(resolved);
    log.quickPickOptions.push(options);
    return index === undefined ? undefined : resolved[index];
  }) as unknown as ShowQuickPick;
}

suite('NuGet Module — addNuGetPackage()', () => {
  setup(() => {
    saveOriginals();
    installHarness();
  });
  teardown(() => {
    restoreOriginals();
  });

  test('cancelling the search prompt (undefined) short-circuits with no further prompts', async () => {
    stubInputReturns(undefined);
    await addNuGetPackage();
    assert.strictEqual(log.inputBoxOptions.length, 1, 'the search input box was shown once');
    assert.strictEqual(log.fetchUrls.length, 0, 'no NuGet API call after cancel');
    assert.strictEqual(log.quickPickItems.length, 0, 'no quick pick after cancel');
    assert.deepStrictEqual(log.infoMessages, []);
    assert.deepStrictEqual(log.errorMessages, []);
  });

  test('the search prompt carries the documented prompt + placeHolder', async () => {
    stubInputReturns(undefined);
    await addNuGetPackage();
    const opts = log.inputBoxOptions[0];
    assert.ok(opts, 'options were supplied to showInputBox');
    assert.strictEqual(opts.prompt, 'Search NuGet packages');
    assert.strictEqual(opts.placeHolder, 'e.g. Newtonsoft.Json');
  });

  test('an empty query string also short-circuits (treated like cancel)', async () => {
    stubInputReturns('');
    await addNuGetPackage();
    assert.strictEqual(log.fetchUrls.length, 0, 'empty query never reaches the API');
    assert.strictEqual(log.quickPickItems.length, 0);
  });

  test('a query with zero results shows the "No packages found." info toast', async () => {
    stubInputReturns('zzz-nonexistent');
    mutGlobal.fetch = fetchReturning({ data: [] });
    await addNuGetPackage();
    assert.strictEqual(log.fetchUrls.length, 1, 'the API was queried once');
    assert.deepStrictEqual(log.infoMessages, ['No packages found.']);
    assert.strictEqual(log.quickPickItems.length, 0, 'no quick pick when there are no results');
  });

  test('the search URL encodes the query and the prerelease flag', async () => {
    stubInputReturns('My Package');
    mutGlobal.fetch = fetchReturning({ data: [] });
    await addNuGetPackage();
    const url = log.fetchUrls[0];
    assert.ok(url, 'a fetch URL was recorded');
    assert.ok(url.includes('azuresearch'), 'targets the NuGet search host');
    assert.ok(url.includes('q=My%20Package'), 'URL-encodes the query');
    assert.ok(url.includes('take=20'), 'requests up to 20 results');
    assert.ok(/prerelease=(true|false)/.test(url), 'carries a boolean prerelease flag');
  });

  test('results populate the quick pick with label/description/detail per package', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = fetchReturning({
      data: [pkg('Serilog', '3.1.1'), pkg('Serilog.Sinks', '5.0.0')],
    });
    stubPickReturnsIndex(undefined); // user cancels the pick → before any dotnet spawn
    await addNuGetPackage();
    assert.strictEqual(log.quickPickItems.length, 1, 'exactly one quick pick was shown');
    const items = log.quickPickItems[0] as { label: string; description: string; detail: string }[];
    assert.strictEqual(items.length, 2, 'one item per package');
    assert.strictEqual(items[0]?.label, 'Serilog');
    assert.strictEqual(items[0]?.description, '3.1.1');
    assert.strictEqual(items[0]?.detail, 'Serilog desc');
    assert.strictEqual(items[1]?.label, 'Serilog.Sinks');
    const opts = log.quickPickOptions[0];
    assert.strictEqual(opts?.placeHolder, 'Select a package to add');
  });

  test('cancelling the package quick pick short-circuits before project selection', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = fetchReturning({ data: [pkg('Serilog', '3.1.1')] });
    stubPickReturnsIndex(undefined);
    let findFilesCalls = 0;
    mutWorkspace.findFiles = async () => {
      findFilesCalls += 1;
      return [] as vscode.Uri[];
    };
    await addNuGetPackage();
    assert.strictEqual(findFilesCalls, 0, 'no project search after the pick is cancelled');
    assert.deepStrictEqual(log.infoMessages, [], 'no "Added" toast on cancel');
  });

  test('picking a package then finding NO project shows a warning and stops', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = fetchReturning({ data: [pkg('Serilog', '3.1.1')] });
    stubPickReturnsIndex(0);
    mutWorkspace.findFiles = async () => [] as vscode.Uri[];
    await addNuGetPackage();
    assert.deepStrictEqual(log.warningMessages, ['No .csproj/.fsproj files found.']);
    assert.deepStrictEqual(log.infoMessages, [], 'never reaches the success toast / dotnet add');
  });

  test('with multiple projects, the project quick pick is shown and cancelling stops', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = fetchReturning({ data: [pkg('Serilog', '3.1.1')] });
    mutWorkspace.findFiles = async () =>
      [vscode.Uri.file('/ws/A.csproj'), vscode.Uri.file('/ws/B.fsproj')] as vscode.Uri[];
    // First quick pick = package; second = project. Cancel the project pick.
    let call = 0;
    mutWindow.showQuickPick = (async (items: unknown, options?: vscode.QuickPickOptions) => {
      const resolved = (await items) as unknown[];
      log.quickPickItems.push(resolved);
      log.quickPickOptions.push(options);
      call += 1;
      return call === 1 ? resolved[0] : undefined; // pick package, cancel project
    }) as unknown as ShowQuickPick;
    await addNuGetPackage();
    assert.strictEqual(log.quickPickItems.length, 2, 'package pick then project pick');
    const projectItems = log.quickPickItems[1] as { label: string }[];
    assert.strictEqual(projectItems.length, 2, 'one entry per discovered project');
    assert.strictEqual(log.quickPickOptions[1]?.placeHolder, 'Select project');
    assert.deepStrictEqual(log.infoMessages, [], 'cancel short-circuits before dotnet add');
  });

  test('a non-ok HTTP response surfaces an error toast (status in message)', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = fetchReturning(undefined, false, 503);
    await addNuGetPackage();
    assert.strictEqual(log.errorMessages.length, 1, 'one error toast on HTTP failure');
    assert.ok(log.errorMessages[0]?.startsWith('NuGet search failed:'), 'prefixed error');
    assert.ok(log.errorMessages[0]?.includes('503'), 'includes the HTTP status code');
  });

  test('a malformed JSON shape surfaces the "Unexpected ... shape" error toast', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = fetchReturning({ notData: [] });
    await addNuGetPackage();
    assert.strictEqual(log.errorMessages.length, 1);
    assert.ok(log.errorMessages[0]?.includes('Unexpected NuGet API response shape'));
  });

  test('a thrown fetch (network error) is caught and reported, never rejecting', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = async () => {
      throw new Error('socket hang up');
    };
    await addNuGetPackage(); // must resolve, not reject
    assert.strictEqual(log.errorMessages.length, 1);
    assert.ok(log.errorMessages[0]?.includes('socket hang up'));
  });
});

suite('NuGet Module — updateNuGetPackage()', () => {
  setup(() => {
    saveOriginals();
    installHarness();
  });
  teardown(() => {
    restoreOriginals();
  });

  test('no project files → warning and early return, no package prompt', async () => {
    mutWorkspace.findFiles = async () => [] as vscode.Uri[];
    await updateNuGetPackage();
    assert.deepStrictEqual(log.warningMessages, ['No .csproj/.fsproj files found.']);
    assert.strictEqual(log.inputBoxOptions.length, 0, 'never prompts for a package name');
  });

  test('with one project, prompts for a package name; cancelling stops before dotnet', async () => {
    mutWorkspace.findFiles = async () => [vscode.Uri.file('/ws/Only.csproj')] as vscode.Uri[];
    stubInputReturns(undefined); // cancel the package-name prompt
    await updateNuGetPackage();
    assert.strictEqual(log.inputBoxOptions.length, 1, 'the package-name box was shown once');
    assert.strictEqual(log.inputBoxOptions[0]?.prompt, 'Package name to update');
    assert.deepStrictEqual(log.infoMessages, [], 'no "Updated" toast when cancelled');
  });

  test('an empty package name also short-circuits before dotnet', async () => {
    mutWorkspace.findFiles = async () => [vscode.Uri.file('/ws/Only.csproj')] as vscode.Uri[];
    stubInputReturns('');
    await updateNuGetPackage();
    assert.deepStrictEqual(log.infoMessages, []);
    assert.deepStrictEqual(log.errorMessages, []);
  });

  test('with multiple projects, the project quick pick is shown; cancelling stops', async () => {
    mutWorkspace.findFiles = async () =>
      [vscode.Uri.file('/ws/A.csproj'), vscode.Uri.file('/ws/B.csproj')] as vscode.Uri[];
    stubPickReturnsIndex(undefined); // cancel project selection
    await updateNuGetPackage();
    assert.strictEqual(log.quickPickItems.length, 1, 'the project quick pick was shown');
    assert.strictEqual(log.quickPickOptions[0]?.placeHolder, 'Select project');
    assert.strictEqual(log.inputBoxOptions.length, 0, 'no package prompt after project cancel');
  });
});

suite('NuGet Module — restorePackages()', () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  setup(() => {
    saveOriginals();
    installHarness();
    originalDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  });
  teardown(() => {
    restoreOriginals();
    if (originalDescriptor !== undefined) {
      Object.defineProperty(vscode.workspace, 'workspaceFolders', originalDescriptor);
    }
  });

  test('no workspace folder open → error toast, no dotnet restore', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      get: () => undefined,
    });
    await restorePackages();
    assert.deepStrictEqual(log.errorMessages, ['No workspace folder open.']);
    assert.deepStrictEqual(log.infoMessages, [], 'never reports a successful restore');
  });

  test('an empty workspace-folders array is also treated as "no folder"', async () => {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      get: () => [] as vscode.WorkspaceFolder[],
    });
    await restorePackages();
    assert.deepStrictEqual(log.errorMessages, ['No workspace folder open.']);
  });
});

suite('NuGet Module — addNuGetPackageToProject(projectPath)', () => {
  let tmpDir: string;
  let projectPath: string;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-nuget-'));
    projectPath = path.join(tmpDir, 'Demo.csproj');
    fs.writeFileSync(
      projectPath,
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    );
  });
  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  setup(() => {
    saveOriginals();
    installHarness();
  });
  teardown(() => {
    restoreOriginals();
  });

  test('cancelling the search prompt short-circuits with no API call', async () => {
    stubInputReturns(undefined);
    await addNuGetPackageToProject(projectPath);
    assert.strictEqual(log.inputBoxOptions.length, 1);
    assert.strictEqual(log.inputBoxOptions[0]?.prompt, 'Search NuGet packages');
    assert.strictEqual(log.fetchUrls.length, 0, 'no NuGet API call after cancel');
  });

  test('an empty query short-circuits before any API call', async () => {
    stubInputReturns('');
    await addNuGetPackageToProject(projectPath);
    assert.strictEqual(log.fetchUrls.length, 0);
  });

  test('zero results shows the "No packages found." info toast and stops', async () => {
    stubInputReturns('zzz');
    mutGlobal.fetch = fetchReturning({ data: [] });
    await addNuGetPackageToProject(projectPath);
    assert.strictEqual(log.fetchUrls.length, 1);
    assert.deepStrictEqual(log.infoMessages, ['No packages found.']);
    assert.strictEqual(log.quickPickItems.length, 0);
  });

  test('results populate the quick pick; cancelling stops before dotnet add', async () => {
    stubInputReturns('newtonsoft');
    mutGlobal.fetch = fetchReturning({ data: [pkg('Newtonsoft.Json', '13.0.3')] });
    stubPickReturnsIndex(undefined);
    await addNuGetPackageToProject(projectPath);
    assert.strictEqual(log.quickPickItems.length, 1);
    const items = log.quickPickItems[0] as { label: string; description: string }[];
    assert.strictEqual(items[0]?.label, 'Newtonsoft.Json');
    assert.strictEqual(items[0]?.description, '13.0.3');
    assert.strictEqual(log.quickPickOptions[0]?.placeHolder, 'Select a package to add');
    assert.deepStrictEqual(log.infoMessages, [], 'cancel means no success toast / no dotnet add');
  });

  test('a non-ok HTTP response is caught and surfaced as an error toast', async () => {
    stubInputReturns('newtonsoft');
    mutGlobal.fetch = fetchReturning(undefined, false, 500);
    await addNuGetPackageToProject(projectPath);
    assert.strictEqual(log.errorMessages.length, 1);
    assert.ok(log.errorMessages[0]?.startsWith('NuGet search failed:'));
    assert.ok(log.errorMessages[0]?.includes('500'));
  });

  test('a malformed response shape is caught and surfaced as an error toast', async () => {
    stubInputReturns('newtonsoft');
    mutGlobal.fetch = fetchReturning({ items: [] });
    await addNuGetPackageToProject(projectPath);
    assert.strictEqual(log.errorMessages.length, 1);
    assert.ok(log.errorMessages[0]?.includes('Unexpected NuGet API response shape'));
  });

  test('a thrown fetch is caught (resolves, never rejects)', async () => {
    stubInputReturns('newtonsoft');
    mutGlobal.fetch = async () => {
      throw new Error('ENOTFOUND');
    };
    await addNuGetPackageToProject(projectPath);
    assert.strictEqual(log.errorMessages.length, 1);
    assert.ok(log.errorMessages[0]?.includes('ENOTFOUND'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUCCESS-path coverage for the four commands. After the search succeeds and the
// user SELECTS a package + project, each command proceeds past the cancel guards
// into `addPackageToProject` / `runDotnet` (`dotnet add … package`) or, for
// restorePackages, `runDotnet(['restore'])`. We drive `dotnet` to fail
// instantly-and-deterministically by pointing PATH at an empty directory so
// `execFile('dotnet', …)` resolves with a fast ENOENT (≈2ms) — no real build,
// no network. That still EXECUTES the pre-spawn selection lines plus the spawn
// tail's reject branch, and the catch in each command surfaces an error toast.
// PATH is saved in `setup` and restored in `teardown`, so the host environment
// is never mutated beyond the test body.
// ─────────────────────────────────────────────────────────────────────────────

/** A directory guaranteed to contain no `dotnet`, so spawning it ENOENTs fast. */
const EMPTY_PATH_DIR = path.join(os.tmpdir(), 'sharplsp-no-dotnet-on-path');

suite('NuGet Module — dotnet-spawn success paths (fast ENOENT)', () => {
  let tmpDir: string;
  let csprojPath: string;
  let fsprojPath: string;
  let origPath: string | undefined;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-nuget-spawn-'));
    csprojPath = path.join(tmpDir, 'Spawn.csproj');
    fsprojPath = path.join(tmpDir, 'Spawn.fsproj');
    const xml =
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>';
    fs.writeFileSync(csprojPath, xml);
    fs.writeFileSync(fsprojPath, xml);
    fs.mkdirSync(EMPTY_PATH_DIR, { recursive: true });
  });
  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  setup(() => {
    saveOriginals();
    installHarness();
    // Force `dotnet` to be unresolvable so execFile fails immediately.
    origPath = process.env.PATH;
    process.env.PATH = EMPTY_PATH_DIR;
  });
  teardown(() => {
    restoreOriginals();
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
  });

  // ── addNuGetPackage(): single project (lines 61-67 + 193-212 reject) ──
  test('addNuGetPackage with one project reaches dotnet add, fails fast, error toast', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = fetchReturning({ data: [pkg('Serilog', '3.1.1')] });
    stubPickReturnsIndex(0); // select the only package
    mutWorkspace.findFiles = async () => [vscode.Uri.file(csprojPath)] as vscode.Uri[];
    await addNuGetPackage();
    // No "Added" success toast — the spawn ENOENTed, so the catch fires.
    assert.deepStrictEqual(log.infoMessages, [], 'no success toast when dotnet add fails');
    assert.strictEqual(log.errorMessages.length, 1, 'one error toast from the dotnet failure');
    assert.ok(
      log.errorMessages[0]?.startsWith('NuGet search failed:'),
      'the dotnet failure is surfaced via the command error handler',
    );
    // The single discovered project is used directly (no project quick pick).
    assert.strictEqual(log.quickPickItems.length, 1, 'only the package quick pick was shown');
  });

  // ── addNuGetPackage(): multi-project picks then dotnet add (line 65-67) ──
  test('addNuGetPackage with two projects shows project pick then reaches dotnet add', async () => {
    stubInputReturns('serilog');
    mutGlobal.fetch = fetchReturning({ data: [pkg('Serilog', '3.1.1')] });
    mutWorkspace.findFiles = async () =>
      [vscode.Uri.file(csprojPath), vscode.Uri.file(fsprojPath)] as vscode.Uri[];
    // First quick pick = package (index 0); second = project (index 0).
    mutWindow.showQuickPick = (async (items: unknown, options?: vscode.QuickPickOptions) => {
      const resolved = (await items) as unknown[];
      log.quickPickItems.push(resolved);
      log.quickPickOptions.push(options);
      return resolved[0];
    }) as unknown as ShowQuickPick;
    await addNuGetPackage();
    assert.strictEqual(log.quickPickItems.length, 2, 'package pick then project pick shown');
    assert.strictEqual(log.quickPickOptions[1]?.placeHolder, 'Select project');
    assert.deepStrictEqual(log.infoMessages, [], 'dotnet add failed → no success toast');
    assert.strictEqual(log.errorMessages.length, 1, 'dotnet failure surfaced as an error toast');
  });

  // ── addNuGetPackageToProject(): success branch (lines 146-148 + 193-212) ──
  test('addNuGetPackageToProject reaches dotnet add for the given project path', async () => {
    stubInputReturns('newtonsoft');
    mutGlobal.fetch = fetchReturning({ data: [pkg('Newtonsoft.Json', '13.0.3')] });
    stubPickReturnsIndex(0);
    await addNuGetPackageToProject(csprojPath);
    assert.strictEqual(log.quickPickItems.length, 1, 'the package quick pick was shown');
    const items = log.quickPickItems[0] as { label: string; description: string }[];
    assert.strictEqual(items[0]?.label, 'Newtonsoft.Json');
    assert.strictEqual(items[0]?.description, '13.0.3');
    assert.deepStrictEqual(log.infoMessages, [], 'dotnet add failed → no "Added" toast');
    assert.strictEqual(log.errorMessages.length, 1, 'spawn failure surfaced as error toast');
    assert.ok(log.errorMessages[0]?.startsWith('NuGet search failed:'));
  });

  test('addNuGetPackageToProject with a multi-result body selects index 1 then spawns', async () => {
    stubInputReturns('logging');
    mutGlobal.fetch = fetchReturning({
      data: [pkg('Serilog', '3.1.1'), pkg('NLog', '5.2.0'), pkg('log4net', '2.0.15')],
    });
    stubPickReturnsIndex(1); // pick NLog
    await addNuGetPackageToProject(csprojPath);
    const items = log.quickPickItems[0] as { label: string; description: string }[];
    assert.strictEqual(items.length, 3, 'all three results offered');
    assert.strictEqual(items[1]?.label, 'NLog');
    // Reached the spawn (which ENOENTs) → caught → exactly one error toast.
    assert.strictEqual(log.errorMessages.length, 1);
    assert.deepStrictEqual(log.infoMessages, []);
  });

  // ── updateNuGetPackage(): success branch (lines 89-96 + 193-212) ──
  test('updateNuGetPackage with one project + a package name reaches dotnet add', async () => {
    mutWorkspace.findFiles = async () => [vscode.Uri.file(csprojPath)] as vscode.Uri[];
    stubInputReturns('Newtonsoft.Json'); // package name to update
    await updateNuGetPackage();
    assert.strictEqual(log.inputBoxOptions.length, 1, 'the package-name box was shown once');
    assert.strictEqual(log.inputBoxOptions[0]?.prompt, 'Package name to update');
    // dotnet add failed → no "Updated" toast, one error toast instead.
    assert.deepStrictEqual(log.infoMessages, [], 'no "Updated" toast when dotnet fails');
    assert.strictEqual(log.errorMessages.length, 1, 'update failure surfaced');
    assert.ok(log.errorMessages[0]?.startsWith('Update failed:'), 'uses the update error prefix');
  });

  test('updateNuGetPackage with multiple projects picks one then reaches dotnet add', async () => {
    mutWorkspace.findFiles = async () =>
      [vscode.Uri.file(csprojPath), vscode.Uri.file(fsprojPath)] as vscode.Uri[];
    // First (and only) quick pick is the project selector; then the name box.
    stubPickReturnsIndex(0);
    stubInputReturns('Serilog');
    await updateNuGetPackage();
    assert.strictEqual(log.quickPickItems.length, 1, 'project quick pick shown');
    assert.strictEqual(log.quickPickOptions[0]?.placeHolder, 'Select project');
    assert.strictEqual(log.inputBoxOptions.length, 1, 'then prompted for the package name');
    assert.strictEqual(log.errorMessages.length, 1, 'dotnet failure surfaced');
    assert.ok(log.errorMessages[0]?.startsWith('Update failed:'));
  });

  // ── restorePackages(): success branch (lines 106-114 + 193-212) ──
  test('restorePackages with a workspace folder reaches dotnet restore, fails fast', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      vscode.workspace,
      'workspaceFolders',
    );
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      configurable: true,
      get: () => [{ uri: vscode.Uri.file(tmpDir), name: 'ws', index: 0 }],
    });
    try {
      await restorePackages();
      // dotnet restore ENOENTed → "Restore failed:" error toast, no success toast.
      assert.deepStrictEqual(
        log.infoMessages,
        [],
        'no "NuGet packages restored." toast when dotnet fails',
      );
      assert.strictEqual(log.errorMessages.length, 1, 'restore failure surfaced');
      assert.ok(
        log.errorMessages[0]?.startsWith('Restore failed:'),
        'uses the restore error prefix',
      );
    } finally {
      if (originalDescriptor !== undefined) {
        Object.defineProperty(vscode.workspace, 'workspaceFolders', originalDescriptor);
      }
    }
  });
});
