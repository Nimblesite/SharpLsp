// Implements [DIST-FAILURE-UX]: logging is best-effort and must never crash the
// extension host.
//
// vscode-languageclient forwards the language server's stderr straight to the
// configured output channel via `outputChannel.append(line)`. During
// extension-host teardown (e.g. when a test run ends, or the window closes) the
// underlying RPC channel closes while the server is still emitting output; the
// next `append` then throws "Channel has been closed". Because that write
// happens inside the language client's own stderr reader — not behind any of our
// try/catch — the throw is UNCAUGHT and takes down the whole run. A logging sink
// going away must be a no-op, not a crash.
import type { LogOutputChannel } from 'vscode';

// The mutating methods of LogOutputChannel. Reads/lifecycle (name, logLevel,
// show, hide, dispose, onDidChangeLogLevel) are passed through untouched.
const WRITE_METHODS: ReadonlySet<string> = new Set([
  'append',
  'appendLine',
  'replace',
  'trace',
  'debug',
  'info',
  'warn',
  'error',
]);

/**
 * Wrap a {@link LogOutputChannel} so its write methods can never throw. The
 * returned channel forwards every call to `channel` but swallows errors from the
 * write methods, so a write that races extension-host teardown is a no-op
 * instead of an uncaught "Channel has been closed".
 */
export function guardChannel(channel: LogOutputChannel): LogOutputChannel {
  return new Proxy(channel, {
    get(target, property): unknown {
      // Resolve against the real channel so getters bind `this` correctly.
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      const bound = (value as (...args: readonly unknown[]) => unknown).bind(target);
      if (typeof property !== 'string' || !WRITE_METHODS.has(property)) {
        return bound;
      }
      return (...args: readonly unknown[]): unknown => {
        try {
          return bound(...args);
        } catch {
          // Channel closed during teardown — logging must not crash the host.
          return undefined;
        }
      };
    },
  });
}
