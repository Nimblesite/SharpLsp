// The extension's one path module: every join, split, resolution, normalisation
// and comparison of a path string lives here, and only this file imports
// `node:path`. Implements [SHARPLSP-ARCHITECTURE-PATHS].
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

/** The platform's directory separator. [SHARPLSP-ARCHITECTURE-PATHS] */
export const pathSeparator = nodePath.sep;

/** The platform's separator between entries of a search path such as `PATH`. [SHARPLSP-ARCHITECTURE-PATHS] */
export const searchPathDelimiter = nodePath.delimiter;

/** Segments joined with the platform separator. [SHARPLSP-ARCHITECTURE-PATHS] */
export function joinPath(...segments: string[]): string {
  return nodePath.join(...segments);
}

/** Segments resolved to an absolute path against the working directory. [SHARPLSP-ARCHITECTURE-PATHS] */
export function resolvePath(...segments: string[]): string {
  return nodePath.resolve(...segments);
}

/** The directory holding `value`. [SHARPLSP-ARCHITECTURE-PATHS] */
export function directoryOf(value: string): string {
  return nodePath.dirname(value);
}

/** The last segment of `value`, without `suffix` when it ends with it. [SHARPLSP-ARCHITECTURE-PATHS] */
export function fileNameOf(value: string, suffix?: string): string {
  return nodePath.basename(value, suffix);
}

/** The last segment of a Windows path, whatever the host platform. [SHARPLSP-ARCHITECTURE-PATHS] */
export function windowsFileNameOf(value: string): string {
  return nodePath.win32.basename(value);
}

/**
 * The file name of `token`, whichever platform's separators the token uses.
 *
 * `path.basename` only knows the HOST's separator, so a Windows-shaped path in
 * a command line — `"C:\a b\StepTarget.dll"` — came back whole when the
 * listing was read on Linux, and a process the user named by assembly matched
 * nothing. A command line is text from another process, not a host path: it can
 * carry either separator wherever it is read. [SHARPLSP-ARCHITECTURE-PATHS]
 */
export function portableFileNameOf(token: string): string {
  const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return cut === -1 ? token : token.slice(cut + 1);
}

/** True when two file names are the same name in any case. [SHARPLSP-ARCHITECTURE-PATHS] */
export function sameFileName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The file name of the `stem` executable on this platform. [SHARPLSP-ARCHITECTURE-PATHS] */
export function executableName(stem: string): string {
  return process.platform === 'win32' ? `${stem}.exe` : stem;
}

/** The extension of `value` including its dot, or `''`. [SHARPLSP-ARCHITECTURE-PATHS] */
export function extensionOf(value: string): string {
  return nodePath.extname(value);
}

/** The last segment of `value` without its extension. [SHARPLSP-ARCHITECTURE-PATHS] */
export function fileStemOf(value: string): string {
  return nodePath.parse(value).name;
}

/** The path from `from` to `to`. [SHARPLSP-ARCHITECTURE-PATHS] */
export function relativePath(from: string, to: string): string {
  return nodePath.relative(from, to);
}

/** True when `value` is absolute. [SHARPLSP-ARCHITECTURE-PATHS] */
export function isAbsolutePath(value: string): boolean {
  return nodePath.isAbsolute(value);
}

/**
 * Case-insensitive on Windows and macOS; symlinks resolved where possible.
 * [SHARPLSP-ARCHITECTURE-PATHS]
 */
export function normalizePath(value: string): string {
  let resolved = nodePath.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A path that does not exist yet still normalizes by resolve() alone.
  }
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/**
 * True when `child` is `parent` or lives beneath it.
 *
 * String equality alone is not a containment test: a start directory OUTSIDE
 * the workspace never equals the workspace root, so a walk guarded only by
 * equality runs to the filesystem root and can select an unrelated project from
 * an ancestor directory. [SHARPLSP-ARCHITECTURE-PATHS]
 */
export function isWithin(child: string, parent: string): boolean {
  const from = normalizePath(parent);
  const to = normalizePath(child);
  if (from === to) return true;
  return to.startsWith(from.endsWith(nodePath.sep) ? from : from + nodePath.sep);
}

/**
 * True when `candidate` is `root` or lies beneath it, judged on the spelling
 * alone, without touching the disk. On Windows `path.relative` answers across
 * drives with an ABSOLUTE path, which does not begin with `..`: an absolute
 * answer means a different volume, never within. [SHARPLSP-ARCHITECTURE-PATHS]
 */
export function isLexicallyWithin(root: string, candidate: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(root), nodePath.resolve(candidate));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relative))
  );
}

/** The extension of `value`, lower-cased with its dot: the key every extension test compares. [SHARPLSP-ARCHITECTURE-PATHS] */
export function extensionKeyOf(value: string): string {
  return nodePath.extname(value).toLowerCase();
}

/** True when `value` ends in one of `extensions` (lower-case, with their dot), in any case. [SHARPLSP-ARCHITECTURE-PATHS] */
export function hasExtension(value: string, ...extensions: readonly string[]): boolean {
  return extensions.includes(extensionKeyOf(value));
}

/** True when `value` is a C# or F# project file. [SHARPLSP-ARCHITECTURE-PATHS] */
export function isProjectFile(value: string): boolean {
  return hasExtension(value, '.csproj', '.fsproj');
}

/** True when one directory segment of `value` is `segment`, in any case. [SHARPLSP-ARCHITECTURE-PATHS] */
export function hasSegment(value: string, segment: string): boolean {
  return value.split(nodePath.sep).some((part) => part.toLowerCase() === segment.toLowerCase());
}

/** True when `left` and `right` name the same file under {@link normalizePath}. [SHARPLSP-ARCHITECTURE-PATHS] */
export function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

/** Stable comparison key for a path that tools spell differently. [SHARPLSP-ARCHITECTURE-PATHS] */
export function pathKey(value: string): string {
  return nodePath.normalize(value).toLowerCase();
}
