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

/**
 * Append the host's executable extension to a bare binary name (`.exe` on
 * Windows, nothing elsewhere). Mirrors shipwright's `${exe}` bundlePath token so
 * bundled-binary paths resolve identically across platforms.
 */
export function exeName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}
