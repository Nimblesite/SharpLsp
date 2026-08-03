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

// The best-effort methods of LogOutputChannel: writes (append*/replace/clear and
// the log-level helpers) AND the visibility toggles (show/hide). All of these
// route through the extension-host RPC and throw "Channel has been closed" once
// the underlying channel is torn down — e.g. `sharplsp.showOutput` calls
// `channel.show()` after a server restart races channel teardown. None of them
// must ever crash the host, so all are wrapped. Only `dispose` and pure
// reads/events (name, logLevel, onDidChangeLogLevel) are passed through
// untouched: disposal must really happen, and reads cannot throw.
const WRITE_METHODS: ReadonlySet<string> = new Set([
  'append',
  'appendLine',
  'replace',
  'clear',
  'show',
  'hide',
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
      const shouldGuard = typeof property === 'string' && WRITE_METHODS.has(property);
      return (...args: readonly unknown[]): unknown => {
        try {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        } catch (caught) {
          if (shouldGuard) {
            // Channel closed during teardown — logging must not crash the host.
            return undefined;
          }
          throw caught;
        }
      };
    },
  });
}
