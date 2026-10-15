// Implements [VSIX]. See docs/specs/LSP-PROFILER-SPEC.md
/**
 * Narrowing for values caught in test `catch` blocks.
 *
 * `catch` binds `unknown`, and `(err as Error).message` *asserts* a shape the
 * compiler then trusts: when a command rejects with a string, a bare DAP error
 * object, or an `undefined`, the assertion reads `.message` off something that
 * has none and the test compares against `undefined` instead of failing loudly.
 * Narrowing at the read site keeps the message honest for every throw shape.
 */

import { stringField } from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';

/**
 * The human-readable message carried by `error`, whatever shape it arrived in.
 *
 * Prefers a real `Error.message`, then a string `message` field (LSP/DAP
 * rejections are plain objects), and finally the value's own string form.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return stringField(error, 'message') ?? String(error);
}
