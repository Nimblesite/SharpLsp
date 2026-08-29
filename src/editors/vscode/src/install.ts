/**
 * Binary version probe utilities.
 *
 * Installation is handled by @nimblesite/shipwright-vscode.
 * These helpers are retained for test compatibility and diagnostic reporting.
 */

import * as child_process from 'node:child_process';
import { extensions } from 'vscode';
import { SERVER_BINARY } from './constants.js';

/** Type guard for the subset of package.json we care about. */
function hasVersionString(value: unknown): value is { version: string } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('version' in value)) return false;
  const record: Record<string, unknown> = value;
  return typeof record.version === 'string';
}

/** Expected version — read from the extension's package.json via VS Code API. */
function expectedVersion(): string {
  const ext = extensions.getExtension('nimblesite.sharplsp');
  if (ext === undefined) {
    throw new Error('SharpLsp extension not found — cannot determine expected version');
  }
  if (!hasVersionString(ext.packageJSON)) {
    throw new Error('SharpLsp extension package.json has no version string');
  }
  return ext.packageJSON.version;
}

function sharplspCommand(): string {
  const envPath = process.env.SHARPLSP_EXECUTABLE_PATH;
  return envPath === undefined || envPath === '' ? SERVER_BINARY : envPath;
}

/**
 * Get the installed version by running a binary with --version.
 * Returns the semver string or undefined on any failure.
 */
export function getInstalledVersion(command: string, expectedPrefix: string): string | undefined {
  try {
    const result = child_process.execFileSync(command, ['--version'], {
      timeout: 5000,
      encoding: 'utf-8',
      killSignal: 'SIGKILL',
    });
    const line = result.trim().split('\n')[0] ?? '';
    const parts = line.split(' ');
    if (parts.length >= 2 && parts[0] === expectedPrefix) {
      return parts[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Summarise binary resolution status for user-facing error messages.
 */
export function describeBinaryStatus(configuredPath: string): {
  expected: string;
  found: string | undefined;
  location: string;
} {
  const expected = expectedVersion();

  if (configuredPath.length > 0) {
    const installed = getInstalledVersion(configuredPath, 'sharplsp');
    return { expected, found: installed, location: configuredPath };
  }

  const command = sharplspCommand();
  const installed = getInstalledVersion(command, 'sharplsp');
  return { expected, found: installed, location: command };
}
