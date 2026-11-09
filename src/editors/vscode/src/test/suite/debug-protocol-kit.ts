// Shared assertions for [DEBUG-PROTOCOL] and [DEBUG-PROTOCOL-CAPABILITIES].
import * as assert from 'node:assert/strict';
import { type DapRecorder } from './debug-dap-kit';
import { deepEq, eq } from './test-helpers';

/**
 * Assert the capability body is populated, the initialize response was singular
 * and (optionally) successful, and the session carried no transport error.
 */
export function assertCapabilitySession(
  recorder: DapRecorder,
  populated: string,
  initialize: string,
  initialized: string,
  clean: string,
  succeeded?: string,
): void {
  assert.ok(Object.keys(recorder.capabilities()).length >= 10, populated);
  eq(recorder.responses('initialize').length, 1, initialize);
  if (succeeded !== undefined) {
    assert.ok(
      recorder.responses('initialize').every((response) => response.success),
      succeeded,
    );
  }
  eq(recorder.events('initialized').length, 1, initialized);
  deepEq(recorder.errors, [], clean);
}

/** Assert exactly one initialize response, one initialized event and one termination. */
export function assertSingleHandshake(
  recorder: DapRecorder,
  initialize: string,
  initialized: string,
  terminated: string,
): void {
  eq(recorder.responses('initialize').length, 1, initialize);
  eq(recorder.events('initialized').length, 1, initialized);
  eq(recorder.events('terminated').length, 1, terminated);
}
