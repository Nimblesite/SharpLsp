// Finding the netcoredbg binary the debug adapter factory spawns.
//
// Implements [DEBUG-ADAPTER-NETCOREDBG], [DIST-DEBUGGER-BUNDLE]. Kept apart from
// debug.ts because this is pure filesystem discovery: no VS Code debug session,
// no launch target, and three suites plus the VSIX staging check import it
// directly.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { exeName } from './platform';

/**
 * The netcoredbg the adapter factory will spawn, or undefined when there is none.
 *
 * PATH is searched properly rather than returning a bare `netcoredbg` and hoping:
 * a name that does not resolve fails later as a spawn ENOENT inside the adapter
 * process, which surfaces to the user as an unexplained failed debug session.
 * Refusing here lets the factory say what is actually wrong.
 */
export function findNetcoredbg(extensionPath?: string): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('sharplsp')
    .get<string>('debug.netcoredbgPath');
  if (configured !== undefined && configured.length > 0 && fs.existsSync(configured)) {
    return configured;
  }
  for (const candidate of getNetcoredbgCandidates(extensionPath)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // The only route on platforms with no upstream prebuilt (win32-arm64,
  // darwin-x64), where the VSIX cannot bundle a debugger.
  return findOnPath(exeName('netcoredbg'));
}

/** Resolve `name` against PATH, honouring PATHEXT on Windows. */
function findOnPath(name: string): string | undefined {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions = process.platform === 'win32' ? ['', ...windowsPathExt()] : [''];
  for (const dir of entries) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The executable suffixes Windows treats as runnable. */
function windowsPathExt(): string[] {
  return (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Platform-aware netcoredbg search paths, most-preferred first. When
 * `extensionPath` is supplied, the VSIX-bundled binary
 * (`bin/<platform>/netcoredbg/netcoredbg[.exe]`, staged by
 * `tools/vsix/fetch-netcoredbg.sh`) is preferred over any user-installed copy.
 */
export function getNetcoredbgCandidates(extensionPath?: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'netcoredbg.exe' : 'netcoredbg';

  const candidates: string[] = [];
  if (extensionPath !== undefined && extensionPath.length > 0) {
    candidates.push(
      path.join(extensionPath, 'bin', `${process.platform}-${process.arch}`, 'netcoredbg', exe),
    );
  }
  candidates.push(
    path.join(home, '.dotnet', 'tools', exe),
    path.join(home, '.local', 'share', 'netcoredbg', exe),
    `/usr/local/bin/${exe}`,
    `/usr/bin/${exe}`,
    path.join(home, 'AppData', 'Local', 'netcoredbg', exe),
  );
  return candidates;
}
