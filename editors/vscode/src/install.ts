/**
 * Binary version checking and package-manager-driven installation.
 *
 * Forge binaries are installed via platform package managers:
 * - forge-lsp: Homebrew (macOS/Linux), Scoop (Windows)
 * - forge-sidecar-csharp / forge-sidecar-fsharp: dotnet global tools
 *
 * The extension NEVER downloads binaries directly over HTTPS.
 * All installation goes through brew, scoop, or dotnet tool.
 */

import * as child_process from 'node:child_process';
import * as os from 'node:os';
import { extensions, window } from 'vscode';
import { SERVER_BINARY } from './constants.js';
import * as log from './log.js';

/** Result of a version check or install attempt. */
interface InstallResult {
  readonly serverPath: string;
}

/** Binary component that must be version-checked. */
interface BinaryComponent {
  readonly name: string;
  readonly command: string;
  readonly versionPrefix: string;
  readonly getInstallArgs: (version: string) => readonly string[];
  readonly getPackageManager: () => string;
  readonly installUrl: string;
}

/** Type guard for the subset of package.json we care about. */
function hasVersionString(value: unknown): value is { version: string } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('version' in value)) return false;
  const record: Record<string, unknown> = value;
  return typeof record.version === 'string';
}

/** Expected version — read from the extension's package.json via VS Code API. */
function expectedVersion(): string {
  const ext = extensions.getExtension('forge-lsp.forge');
  if (ext === undefined) {
    throw new Error('Forge extension not found — cannot determine expected version');
  }
  if (!hasVersionString(ext.packageJSON)) {
    throw new Error('Forge extension package.json has no version string');
  }
  return ext.packageJSON.version;
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

/** Check whether a package manager is available on PATH. */
function isCommandAvailable(command: string): boolean {
  try {
    child_process.execFileSync(command, ['--version'], {
      timeout: 5000,
      encoding: 'utf-8',
      killSignal: 'SIGKILL',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/** Get the package manager for forge-lsp based on platform. */
function forgeLspPackageManager(): string {
  return os.platform() === 'win32' ? 'scoop' : 'brew';
}

/** Get the install command for forge-lsp based on platform. */
function forgeLspInstallArgs(): readonly string[] {
  if (os.platform() === 'win32') {
    return ['scoop', 'install', 'Nimblesite/forge-lsp'];
  }
  return ['brew', 'install', 'Nimblesite/tap/forge-lsp'];
}

/** Get the update command for forge-lsp based on platform. */
function forgeLspUpdateArgs(): readonly string[] {
  if (os.platform() === 'win32') {
    return ['scoop', 'update', 'forge-lsp'];
  }
  return ['brew', 'upgrade', 'Nimblesite/tap/forge-lsp'];
}

function forgeLspCommand(): string {
  const envPath = process.env.FORGE_EXECUTABLE_PATH;
  return envPath === undefined || envPath === '' ? SERVER_BINARY : envPath;
}

/** All binary components that the extension requires. */
function binaryComponents(_version: string): readonly BinaryComponent[] {
  return [
    {
      name: 'forge-lsp',
      command: forgeLspCommand(),
      versionPrefix: 'forge-lsp',
      getInstallArgs: () => {
        const installed = getInstalledVersion(forgeLspCommand(), 'forge-lsp');
        if (installed === undefined) return [...forgeLspInstallArgs()];
        return [...forgeLspUpdateArgs()];
      },
      getPackageManager: forgeLspPackageManager,
      installUrl: os.platform() === 'win32' ? 'https://scoop.sh' : 'https://brew.sh',
    },
    {
      name: 'forge-sidecar-csharp',
      command: 'forge-sidecar-csharp',
      versionPrefix: 'forge-sidecar-csharp',
      getInstallArgs: (v: string) => [
        'dotnet',
        'tool',
        'update',
        '-g',
        'Forge.Sidecar.CSharp',
        '--version',
        v,
      ],
      getPackageManager: () => 'dotnet',
      installUrl: 'https://dotnet.microsoft.com/download',
    },
    {
      name: 'forge-sidecar-fsharp',
      command: 'forge-sidecar-fsharp',
      versionPrefix: 'forge-sidecar-fsharp',
      getInstallArgs: (v: string) => [
        'dotnet',
        'tool',
        'update',
        '-g',
        'Forge.Sidecar.FSharp',
        '--version',
        v,
      ],
      getPackageManager: () => 'dotnet',
      installUrl: 'https://dotnet.microsoft.com/download',
    },
  ] as const satisfies readonly BinaryComponent[];
}

/**
 * Run a package manager command, streaming output to the Forge output channel.
 * Returns true on success, false on failure.
 */
async function runInstallCommand(args: readonly string[]): Promise<boolean> {
  const [cmd, ...rest] = args;
  if (cmd === undefined) return false;

  log.info(`Running: ${args.join(' ')}`);

  return new Promise((resolve) => {
    const proc = child_process.spawn(cmd, rest, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    proc.stdout.on('data', (data: Buffer) => {
      log.info(data.toString().trimEnd());
    });
    proc.stderr.on('data', (data: Buffer) => {
      log.info(data.toString().trimEnd());
    });

    proc.on('error', (err) => {
      log.info(`Command failed: ${err.message}`);
      resolve(false);
    });
    proc.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * Verify and install a single binary component.
 * Returns true if the component is at the expected version after this call.
 */
async function ensureComponent(component: BinaryComponent, version: string): Promise<boolean> {
  // Check current version.
  const installed = getInstalledVersion(component.command, component.versionPrefix);
  if (installed === version) {
    log.info(`${component.name} v${version} — OK`);
    return true;
  }

  log.info(
    `${component.name}: expected v${version}, found ${installed === undefined ? 'not installed' : `v${installed}`}`,
  );

  // Verify the package manager is available.
  const pm = component.getPackageManager();
  if (!isCommandAvailable(pm)) {
    const action = await window.showErrorMessage(
      `Forge requires '${pm}' to install ${component.name}, but it was not found on PATH. Install it from ${component.installUrl} and restart VS Code.`,
      { modal: true },
      'OK',
    );
    void action;
    return false;
  }

  // Prompt the user.
  const installArgs = component.getInstallArgs(version);
  const commandStr = installArgs.join(' ');
  const choice = await window.showInformationMessage(
    `Forge needs to install ${component.name} v${version}. Run \`${commandStr}\`?`,
    { modal: true },
    'Install',
    'Cancel',
  );

  if (choice !== 'Install') {
    log.info(`User declined installation of ${component.name}`);
    return false;
  }

  // Run the install command.
  const success = await runInstallCommand(installArgs);
  if (!success) {
    void window.showErrorMessage(
      `Failed to install ${component.name}. Check the Forge output channel for details.`,
    );
    return false;
  }

  // Re-check version after install.
  const afterInstall = getInstalledVersion(component.command, component.versionPrefix);
  if (afterInstall !== version) {
    void window.showErrorMessage(
      `${component.name} installed but version mismatch: expected v${version}, got ${afterInstall === undefined ? 'unknown' : `v${afterInstall}`}.`,
    );
    return false;
  }

  log.info(`${component.name} v${version} installed successfully`);
  return true;
}

/**
 * Ensure all Forge binaries are installed at the expected version.
 *
 * Each binary is checked by spawning it with --version and comparing
 * the output to the version in package.json. If any binary is missing
 * or at the wrong version, the user is prompted to install/update via
 * the appropriate package manager (brew, scoop, or dotnet tool).
 *
 * The extension NEVER downloads binaries directly. All installation
 * goes through Homebrew, Scoop, or dotnet tool install/update.
 */
export async function ensureBinaries(configuredPath: string): Promise<InstallResult> {
  const version = expectedVersion();
  const components = binaryComponents(version);

  // If the user configured a custom path, check it first (forge-lsp only).
  if (configuredPath.length > 0) {
    const installed = getInstalledVersion(configuredPath, 'forge-lsp');
    if (installed === version) {
      log.info(`Using configured binary: ${configuredPath} (v${version})`);
      // Still need to check sidecars.
      for (const component of components) {
        if (component.name === 'forge-lsp') continue;
        const ok = await ensureComponent(component, version);
        if (!ok) {
          throw new Error(`Forge activation aborted: ${component.name} v${version} is required.`);
        }
      }
      return { serverPath: configuredPath };
    }
    log.info(`Configured binary version mismatch: expected ${version}, got ${String(installed)}`);
  }

  // Check all components sequentially: forge-lsp, then C# sidecar, then F# sidecar.
  for (const component of components) {
    const ok = await ensureComponent(component, version);
    if (!ok) {
      const msg = `Forge activation aborted: ${component.name} v${version} is required.`;
      void window.showErrorMessage(msg);
      throw new Error(msg);
    }
  }

  return { serverPath: forgeLspCommand() };
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
    const installed = getInstalledVersion(configuredPath, 'forge-lsp');
    return { expected, found: installed, location: configuredPath };
  }

  const command = forgeLspCommand();
  const installed = getInstalledVersion(command, 'forge-lsp');
  return { expected, found: installed, location: command };
}
