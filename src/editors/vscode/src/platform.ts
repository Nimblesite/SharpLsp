/** Resolve the bundle subdirectory name (`<os>-<arch>`) for the current host. */
export function detectRuntimePlatform(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin') return 'darwin-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'linux') return 'linux-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win32-arm64';
  if (process.platform === 'win32') return 'win32-x64';
  return 'linux-x64';
}

/** The extension a platform puts on an executable file. */
const EXE_SUFFIX = '.exe';

/** Both path separators, so a path from EITHER host splits on this one host. */
const SEPARATORS = /[\\/]/;

/**
 * The executable suffix `platform` uses — `.exe` on Windows, nothing elsewhere.
 *
 * Takes the platform as a PARAMETER rather than reading `process.platform`, so
 * the Windows answer can be asserted from a macOS or Linux test run. A branch
 * that only one CI host can reach is a branch only that host can catch
 * regressing, and that is precisely how a Windows-only defect survives review.
 */
export function exeSuffixFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? EXE_SUFFIX : '';
}

/**
 * Append the host's executable extension to a bare binary name (`.exe` on
 * Windows, nothing elsewhere). Mirrors shipwright's `${exe}` bundlePath token so
 * bundled-binary paths resolve identically across platforms.
 */
export function exeName(base: string): string {
  return `${base}${exeSuffixFor(process.platform)}`;
}

/**
 * The bare binary name a command path invokes, lowercased for comparison — the
 * inverse of {@link exeName}.
 *
 * HOST-INDEPENDENT by design, and that is the whole point. A command read back
 * off a `vscode.Task` is whatever absolute path [DIST-RUNTIME-ACQUIRE] resolved:
 * `C:\Program Files\dotnet\dotnet.exe` on Windows, `/usr/share/dotnet/dotnet`
 * elsewhere. Neither `path.basename` nor `endsWith('dotnet')` names both — the
 * former does not treat `\` as a separator off Windows, and the latter misses
 * every Windows path while also matching an unrelated `mydotnet` — so anything
 * built on them classifies the SAME dotnet invocation differently per platform.
 *
 * Lowercased because the hosts that spell an executable `DOTNET.EXE` are exactly
 * the hosts whose filesystems consider that the same file as `dotnet.exe`.
 */
export function binaryNameOf(command: string): string {
  const leaf = (command.split(SEPARATORS).pop() ?? '').toLowerCase();
  return leaf.endsWith(EXE_SUFFIX) ? leaf.slice(0, leaf.length - EXE_SUFFIX.length) : leaf;
}
