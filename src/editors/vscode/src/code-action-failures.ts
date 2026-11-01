// Implements [REFACTOR-NEVER-SILENT]: the language client hides failed requests
// (`revealOutputChannelOn: Never`), so a failed `codeAction/resolve` would reach
// no one. This middleware reports each failure ONCE, in the exact words the
// spec gives, with a `Show Log` button that reveals the SharpLsp output channel
// — and swallows nothing silently. The client's own command feature is off
// ([PROFILER-SHARED-LIBRARY-VSCODE]), so commands report through
// `reportCodeActionFailure` from where the extension registers them.
import * as vscode from 'vscode';
import type { Middleware } from 'vscode-languageclient/node';
import * as log from './log.js';

/** The reason shown when a resolved action carries neither changes nor a command. */
export const NO_CHANGES_REASON = 'the language server returned no changes';

/** The reason shown when the client gave the action back unresolved: the connection closed. */
export const SERVER_GONE_REASON =
  'the language server stopped before it answered; invoke the quick fix again';

const SHOW_LOG = 'Show Log';

/**
 * The exact message a failed code action shows, per [REFACTOR-NEVER-SILENT]:
 * `SharpLsp could not apply "<title>": <reason>. The details are in Output › SharpLsp.`
 */
export function failureMessage(title: string, reason: string): string {
  return `SharpLsp could not apply "${title}": ${reason}. The details are in Output › SharpLsp.`;
}

/**
 * Whether a resolved action carries something that changes the user's code. A
 * rename-only edit has no text edits (`size` is 0) yet still changes the file,
 * so any edit counts; an empty edit is refused by the server tiers before it gets
 * here ([REFACTOR-NEVER-SILENT]).
 */
function carriesChange(action: vscode.CodeAction): boolean {
  return action.edit !== undefined || action.command !== undefined;
}

/** Cancellation is not a failure: the user or the editor withdrew the request. */
function isCancelled(token: vscode.CancellationToken, error: unknown): boolean {
  return token.isCancellationRequested || error instanceof vscode.CancellationError;
}

/** The failure's reason as text, whatever shape the rejection carried. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/** Show the message once with its `Show Log` button, and log the failure.
 * Shared by the middleware and the reference-import command. [REFACTOR-NEVER-SILENT] */
export async function reportCodeActionFailure(title: string, reason: string): Promise<void> {
  log.error(`Code action failed: ${title} — ${reason}`);
  const choice = await vscode.window.showErrorMessage(failureMessage(title, reason), SHOW_LOG);
  if (choice === SHOW_LOG) log.output().show();
}

/** Why a resolve that did not throw still failed; `undefined` when it succeeded. */
function failureOf(
  item: vscode.CodeAction,
  resolved: vscode.CodeAction | null | undefined,
): string | undefined {
  if (resolved === item) return SERVER_GONE_REASON;
  if (resolved === null || resolved === undefined || !carriesChange(resolved)) {
    return NO_CHANGES_REASON;
  }
  return undefined;
}

/**
 * Middleware for the client: every `resolveCodeAction` failure reaches the user
 * exactly once. After reporting, the unresolved item is returned instead of
 * rethrowing, so VS Code does not ALSO surface its own error for the same
 * failure. The client hands back the unresolved item itself, uncancelled, when
 * the connection closed under the request; that is a failure too.
 */
export function createCodeActionFailureMiddleware(): Pick<Middleware, 'resolveCodeAction'> {
  return {
    async resolveCodeAction(item, token, next) {
      try {
        const resolved = await next(item, token);
        if (token.isCancellationRequested) return resolved ?? item;
        const reason = failureOf(item, resolved);
        if (reason === undefined) return resolved;
        void reportCodeActionFailure(item.title, reason);
        return item;
      } catch (error) {
        if (isCancelled(token, error)) return item;
        void reportCodeActionFailure(item.title, reasonOf(error));
        return item;
      }
    },
  };
}
