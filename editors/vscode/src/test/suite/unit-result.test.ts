// Implements [DIST-FAILURE-UX]: every fallible function returns Result<T, E>.
// These tests pin the Result helper contract so callers can rely on the
// discriminated union narrowing.
import * as assert from 'node:assert/strict';
import { type Result, err, ok } from '../../result.js';

suite('Result<T, E>', () => {
  test('ok() produces a discriminated success', () => {
    const r = ok<number>(42);
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.value, 42);
    }
  });

  test('err() produces a discriminated failure', () => {
    const r = err<number>('boom');
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.strictEqual(r.error, 'boom');
    }
  });

  test('Result<T> defaults E to string', () => {
    const r: Result<string> = err('msg');
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      // Compile-time: r.error is `string`. Runtime check confirms.
      assert.strictEqual(typeof r.error, 'string');
    }
  });

  test('discriminant narrows value vs. error', () => {
    const happy: Result<number> = ok(1);
    const sad: Result<number> = err('nope');

    function unwrap(r: Result<number>): number {
      // If a function throws here, the discriminated union failed.
      return r.ok ? r.value : -1;
    }

    assert.strictEqual(unwrap(happy), 1);
    assert.strictEqual(unwrap(sad), -1);
  });

  test('ok carries arbitrary payload types', () => {
    interface Payload {
      readonly id: string;
      readonly count: number;
    }
    const r = ok<Payload>({ id: 'x', count: 7 });
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.value.id, 'x');
      assert.strictEqual(r.value.count, 7);
    }
  });

  test('err carries custom error types', () => {
    interface FailDetail {
      readonly code: string;
      readonly cause: string;
    }
    const r = err<number, FailDetail>({ code: 'E_NET', cause: 'timeout' });
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.strictEqual(r.error.code, 'E_NET');
      assert.strictEqual(r.error.cause, 'timeout');
    }
  });
});
