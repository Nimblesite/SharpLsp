import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { joinPath } from './paths';
import { err, ok, type Result } from './result';

/**
 * A plain, non-null object — the only shape a parsed JSON node, an MSBuild
 * property bag or a DAP message body can take.
 *
 * `typeof null` is `'object'` and so is an array, so both are excluded
 * explicitly. Five modules had written this out identically before it was
 * given one home.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `candidate` is a directory, following links the way the OS and hostfxr do.
 * A directory entry reports a link as a link, never as the directory it opens, so
 * one that stands in for an SDK or a project folder must be asked through `stat`.
 */
export function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Extract a human-readable message from an unknown error value. */
export function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Resolve after `ms` milliseconds — the one delay every poller waits on. */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `text` collapsed onto ONE line, for somewhere that can only render one.
 *
 * A CodeLens title is the case that forces it: a TRX `ErrorInfo` carries the
 * assertion, its expected/actual block and often a stack trace, newline
 * separated, and a lens shows the first line and drops the rest. Trimming each
 * part before joining also disposes of the `\r` half of a CRLF, so the result
 * is the same on either platform.
 */
export function singleLine(text: string): string {
  return splitTrimmed(text, '\n').join(' ');
}

/**
 * The non-blank parts of `text` split on `separator`, each trimmed: a `;`
 * MSBuild list or `PATHEXT`, a `,` glob list, the lines of a listing. Trimming
 * also disposes of the `\r` half of a CRLF line.
 */
export function splitTrimmed(text: string, separator: string): string[] {
  return text
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Escape `text` for the profiler panels, which place it only in element text
 * and double-quoted attributes. A single quote is deliberately left alone —
 * the profiler suite pins that — so do not use this for a single-quoted
 * attribute or a JS string; the NuGet browser's `esc`/`escAttr` cover those.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * `rmSync` options for a recursive delete that survives Windows file-handle races.
 *
 * `force: true` only swallows ENOENT — it does NOT retry. On Windows a directory
 * whose file a just-exited child (dotnet, VBCSCompiler, a sidecar) still holds
 * open fails with EPERM/EBUSY; Node retries exactly those codes when given
 * `maxRetries`/`retryDelay`. One home, so the retry policy cannot drift between
 * call sites. Implements [DIST-CI-WIN-VSIX].
 */
export const RETRYING_RM: fs.RmOptions = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
};

/**
 * Best-effort recursive delete that never holds the extension host's event loop.
 *
 * The tree is RENAMED aside first — one operation, and the path is free the
 * moment this returns — and then deleted in the background, on libuv's thread
 * pool. Deleting a copied .NET SDK (tens of thousands of files) synchronously
 * held the event loop for 41 s on a Windows runner, long enough for VS Code to
 * report the extension host unresponsive (GitHub #311). The background delete
 * only ever touches the renamed tree, so a caller may recreate the path at once.
 *
 * When the rename fails — the path is already gone, or a child still holds a
 * file in it — the delete runs in place, with the Windows retry policy. Once the
 * retries are exhausted, a handle a child process leaked must not fail the
 * caller: thrown from a `finally`, it would discard a result already complete.
 *
 * Neither path reaches through a link. The extension host's `fs.rmSync` (Node 24)
 * walks INTO a Windows junction and empties the directory it names, so the
 * in-place delete unlinks every link first; `fs.promises.rm` unlinks a link
 * without entering it. Implements [DIST-CI-WIN-VSIX].
 *
 * `ok` means the path is free the moment this returns; `err` names a tree that
 * could neither move nor go, for a caller whose contract needs the path empty.
 */
export function removeDirRecursive(target: string): Result<void> {
  const aside = moveAside(target);
  if (aside !== undefined) {
    void fs.promises.rm(aside, RETRYING_RM).catch(() => undefined);
    return ok(undefined);
  }
  try {
    removeInPlace(target);
    return ok(undefined);
  } catch (cause: unknown) {
    return err(`could not remove ${target}: ${getErrorMessage(cause)}`);
  }
}

/** Delete `target` where it stands: a link is unlinked itself, a tree loses its links first. */
function removeInPlace(target: string): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (stat.isDirectory()) unlinkLinks(target);
  fs.rmSync(target, RETRYING_RM);
}

/**
 * Unlink every link under `tree` without descending through one, so what is left
 * is plain files and directories. A junction counts: a directory entry reports
 * every Windows reparse point as a link.
 */
function unlinkLinks(tree: string): void {
  for (const entry of fs.readdirSync(tree, { withFileTypes: true })) {
    const child = joinPath(tree, entry.name);
    if (entry.isSymbolicLink()) fs.unlinkSync(child);
    else if (entry.isDirectory()) unlinkLinks(child);
  }
}

/** Rename `target` to a unique sibling on the same volume; `undefined` when it cannot move. */
function moveAside(target: string): string | undefined {
  const aside = `${target}.${randomUUID()}.deleting`;
  try {
    fs.renameSync(target, aside);
    return aside;
  } catch {
    return undefined;
  }
}
