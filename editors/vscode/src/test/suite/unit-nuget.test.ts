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
import * as vscode from 'vscode';
import { includePrerelease, isNuGetSearchResult } from '../../nuget.js';

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
