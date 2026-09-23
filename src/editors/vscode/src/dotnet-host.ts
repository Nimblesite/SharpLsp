import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findDotnetSatisfying } from './dotnet-roots.js';
import {
  installedSdkVersions,
  parseSdkVersion,
  runtimeFloorMet,
  type SdkPin,
} from './global-json.js';
import * as log from './log.js';
import { getErrorMessage } from './utils.js';

const execute = promisify(execFile);
const SIDECAR_MAJOR = 10;

/** [DIST-RUNTIME-ACQUIRE]: a build SDK pin cannot replace the sidecars' host requirements. */
export async function supportsSidecars(dotnetPath: string): Promise<boolean> {
  const sdks = installedSdkVersions(dotnetPath);
  if (!sdks.some((sdk) => (parseSdkVersion(sdk)?.major ?? 0) >= SIDECAR_MAJOR)) return false;
  try {
    const { stdout } = await execute(dotnetPath, ['--list-runtimes'], {
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.split('\n').some(isSidecarRuntime);
  } catch (error: unknown) {
    log.info(`sidecar runtime probe failed for ${dotnetPath}: ${getErrorMessage(error)}`);
    return false;
  }
}

/** LatestMajor permits prereleases above the floor, but not a prerelease of the floor. */
function isSidecarRuntime(line: string): boolean {
  const [framework, version] = line.trim().split(' ');
  return (
    framework === 'Microsoft.NETCore.App' &&
    version !== undefined &&
    runtimeFloorMet([version], `${String(SIDECAR_MAJOR)}.0.0`)
  );
}

/** Prefer the first root satisfying BOTH global.json and managed sidecar startup. */
export async function findSidecarSdk(
  pin: SdkPin,
  roots: readonly string[],
): Promise<string | undefined> {
  for (const root of roots) {
    const candidate = findDotnetSatisfying(pin, [root]);
    if (candidate !== undefined && (await supportsSidecars(candidate))) return candidate;
  }
  return undefined;
}
