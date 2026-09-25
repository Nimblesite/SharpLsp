import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type SdkPin, installedSdkVersions, pinSatisfiedBy } from './global-json.js';

/**
 * Finding the SDK a workspace pin needs, wherever on the machine it is.
 *
 * Implements [DIST-RUNTIME-ACQUIRE]. `dotnet.findPath` reports ONE dotnet host,
 * and a developer machine routinely carries several: a user-local `~/.dotnet`
 * beside a system-wide `/usr/local/share/dotnet`, each with its own `sdk/`
 * directory. When the host it reports cannot satisfy the workspace
 * `global.json` and another root can, the pinned SDK is already installed — and
 * the extension was wrong twice over: it told the user to install an SDK they
 * had, and it ran every build, test discovery and sidecar launch against the
 * host that answers exit code 155 to all of them.
 *
 * The pin is the question ("which host can build this workspace?"), so every
 * root is asked it, and the first that answers yes is the host the extension
 * uses for everything downstream.
 */

/** The `dotnet` executable inside a root directory. */
export function dotnetExecutable(root: string): string {
  return path.join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
}

/** A non-empty environment value, or nothing. */
function fromEnv(env: NodeJS.ProcessEnv, name: string, ...segments: string[]): string | undefined {
  const base = env[name];
  return base === undefined || base === '' ? undefined : path.join(base, ...segments);
}

/** Where this platform's installers put a dotnet host, most specific first. */
function platformRoots(env: NodeJS.ProcessEnv): readonly (string | undefined)[] {
  if (process.platform === 'win32') {
    return [
      fromEnv(env, 'LOCALAPPDATA', 'Microsoft', 'dotnet'),
      fromEnv(env, 'ProgramFiles', 'dotnet'),
      fromEnv(env, 'ProgramW6432', 'dotnet'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/usr/local/share/dotnet', '/opt/homebrew/share/dotnet', '/usr/share/dotnet'];
  }
  return ['/usr/share/dotnet', '/usr/lib/dotnet', '/usr/local/share/dotnet'];
}

/**
 * Every directory that may hold a dotnet host, in probe order. `DOTNET_ROOT`
 * comes first because a developer who set it has already stated their choice.
 */
export function candidateDotnetRoots(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const candidates = [
    fromEnv(env, 'DOTNET_ROOT'),
    path.join(os.homedir(), '.dotnet'),
    ...platformRoots(env),
  ];
  return [...new Set(candidates.filter((root): root is string => root !== undefined))];
}

/**
 * The first `dotnet` in `roots` whose installed SDKs satisfy `pin`, or nothing
 * when none does — which is the only case that is genuinely a missing SDK.
 *
 * Order is preference: pass the already-chosen host first so a machine that
 * works keeps the host it was working with.
 */
export function findDotnetSatisfying(pin: SdkPin, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const executable = dotnetExecutable(root);
    if (!fs.existsSync(executable)) continue;
    if (pinSatisfiedBy(installedSdkVersions(executable), pin)) return executable;
  }
  return undefined;
}
