// Real, buildable run/debug fixtures: console projects in C# and F#, file-based
// apps, and scripts.
//
// Spec: [DEBUG-FEATURES-LAUNCH-TARGET], [DEBUG-FEATURES-LAUNCH-BUILD],
// [DEBUG-FEATURES-LAUNCH-SCRIPT], [DEBUG-FEATURES-LAUNCH-PROFILES].
//
// Every project file here goes through `buildProjectXml`'s XML writer — project
// XML is a STRUCTURED file and CLAUDE.md forbids splicing it from strings. The
// `properties` bag added to `ProjectOptions` is what lets a run/debug fixture
// declare `OutputType`, `AssemblyName`, `OutputPath` and a multi-target
// `TargetFrameworks` without a second project writer existing anywhere.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildProjectXml, dotnet, writeProject } from './dotnet-project-kit';

/** The framework every fixture targets unless a case overrides it. */
export const TFM = 'net10.0';

/** What a materialised console project exposes to a test. */
export interface ConsoleProject {
  /** Absolute path to the .csproj/.fsproj. */
  readonly projectFile: string;
  /** Absolute path to the single source file. */
  readonly sourceFile: string;
  /** The project directory — the `cwd` a launch configuration must use. */
  readonly dir: string;
  /** The assembly name, which is NOT always the project file's base name. */
  readonly assemblyName: string;
}

/** Overridable pieces of a console-project fixture. */
export interface ConsoleProjectOptions {
  /** Extra `<PropertyGroup>` entries — `AssemblyName`, `OutputPath`, TFMs. */
  readonly properties?: Readonly<Record<string, string>>;
  /** Text the program prints, so a run can be told apart from another run. */
  readonly marker?: string;
}

/** `OutputType=Exe` — the property that makes a project a launch target. */
const EXE_PROPERTIES: Readonly<Record<string, string>> = { OutputType: 'Exe' };

/** C# top-level-statement program body. */
function csharpProgram(marker: string): string {
  return `System.Console.WriteLine("${marker}");\n`;
}

/** F# program body. `EntryPoint` is required for an F# console assembly. */
function fsharpProgram(marker: string): string {
  return ['[<EntryPoint>]', 'let main _argv =', `    printfn "${marker}"`, '    0', ''].join('\n');
}

/** Merge the Exe defaults under a case's own property overrides. */
function exeProperties(properties?: Readonly<Record<string, string>>): Record<string, string> {
  return { ...EXE_PROPERTIES, ...(properties ?? {}) };
}

/**
 * The assembly name MSBuild will produce: `<AssemblyName>` when the fixture set
 * one, otherwise the project file's base name. A launch target resolver that
 * ignores `<AssemblyName>` points at a file that never existed.
 */
function assemblyNameOf(name: string, properties?: Readonly<Record<string, string>>): string {
  return properties?.AssemblyName ?? name;
}

/** Write a runnable C# console project. Returns everything a launch needs. */
export function writeCSharpConsole(
  dir: string,
  name: string,
  options: ConsoleProjectOptions = {},
): ConsoleProject {
  const properties = exeProperties(options.properties);
  writeProject(
    dir,
    `${name}.csproj`,
    buildProjectXml({ properties }),
    'Program.cs',
    csharpProgram(options.marker ?? `hello from ${name}`),
  );
  return {
    projectFile: path.join(dir, `${name}.csproj`),
    sourceFile: path.join(dir, 'Program.cs'),
    dir,
    assemblyName: assemblyNameOf(name, properties),
  };
}

/**
 * Write a runnable F# console project.
 *
 * F# compiles in declared order, so the `<Compile Include>` entry is mandatory
 * — an .fsproj that globs builds nothing. F# is a first-class citizen here: the
 * F# fixture is the same shape as the C# one, not a reduced one.
 */
export function writeFSharpConsole(
  dir: string,
  name: string,
  options: ConsoleProjectOptions = {},
): ConsoleProject {
  const properties = exeProperties(options.properties);
  writeProject(
    dir,
    `${name}.fsproj`,
    buildProjectXml({ properties, compileIncludes: ['Program.fs'] }),
    'Program.fs',
    fsharpProgram(options.marker ?? `hello from ${name}`),
  );
  return {
    projectFile: path.join(dir, `${name}.fsproj`),
    sourceFile: path.join(dir, 'Program.fs'),
    dir,
    assemblyName: assemblyNameOf(name, properties),
  };
}

/** Write a class library — a project that MUST NOT be offered as a target. */
export function writeCSharpLibrary(dir: string, name: string): ConsoleProject {
  writeProject(
    dir,
    `${name}.csproj`,
    buildProjectXml({}),
    'Library.cs',
    `namespace ${name};\npublic static class Calc { public static int Add(int a, int b) => a + b; }\n`,
  );
  return {
    projectFile: path.join(dir, `${name}.csproj`),
    sourceFile: path.join(dir, 'Library.cs'),
    dir,
    assemblyName: name,
  };
}

/** Build a fixture project with the real CLI so its output exists on disk. */
export async function buildProject(project: ConsoleProject): Promise<string> {
  return dotnet(['build', project.projectFile, '-c', 'Debug'], project.dir);
}

/**
 * A C# file-based app: a single `.cs` with top-level statements and NO owning
 * project anywhere up the tree ([SCRIPT-DETECT] `CSharpFileBasedApp`).
 *
 * `dotnet run --file <path>` runs it; `dotnet build <path> --artifacts-path
 * <dir>` produces `<dir>/bin/debug/<name>.dll` — note there is no TFM segment,
 * unlike a project's `bin/Debug/<tfm>/`.
 */
export function writeFileBasedApp(dir: string, name: string, marker?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.cs`);
  fs.writeFileSync(file, csharpProgram(marker ?? `hello from file-based ${name}`), 'utf-8');
  return file;
}

/** The assembly `dotnet build <file>.cs --artifacts-path <dir>` produces. */
export function fileBasedOutput(artifactsDir: string, name: string): string {
  return path.join(artifactsDir, 'bin', 'debug', `${name}.dll`);
}

/** An F# script ([SCRIPT-DETECT] `FSharpScript`). Runs under `dotnet fsi`. */
export function writeFsxScript(dir: string, name: string, marker?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.fsx`);
  fs.writeFileSync(file, `printfn "${marker ?? `hello from ${name}.fsx`}"\n`, 'utf-8');
  return file;
}

/** A C# script ([SCRIPT-DETECT] `CSharpScript`). Needs a third-party runner. */
export function writeCsxScript(dir: string, name: string, marker?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.csx`);
  fs.writeFileSync(file, csharpProgram(marker ?? `hello from ${name}.csx`), 'utf-8');
  return file;
}

/** Write a `Properties/launchSettings.json` under `root`; returns its path. */
export function writeLaunchSettings(root: string, settings: unknown): string {
  const propsDir = path.join(root, 'Properties');
  fs.mkdirSync(propsDir, { recursive: true });
  const file = path.join(propsDir, 'launchSettings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
  return file;
}

/** Write a raw (possibly malformed) launchSettings.json body verbatim. */
export function writeRawLaunchSettings(root: string, body: string): string {
  const propsDir = path.join(root, 'Properties');
  fs.mkdirSync(propsDir, { recursive: true });
  const file = path.join(propsDir, 'launchSettings.json');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

/**
 * Write the file-based app's launch-profile file, `<name>.run.json`.
 *
 * A file-based app has no `Properties/` directory; the SDK reads its profiles
 * from a sibling `<entry>.run.json` instead ([DEBUG-FEATURES-LAUNCH-PROFILES]).
 */
export function writeRunJson(dir: string, name: string, settings: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.run.json`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
  return file;
}

/** Mark `dir` as a repository root so a cone walk must stop there. */
export function markGitRoot(dir: string): string {
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
  return gitDir;
}

/**
 * The assembly `dotnet build -c Debug` produces for a fixture console project.
 *
 * One builder, one layout. Four call sites had grown their own copy of the
 * `bin/Debug/<tfm>/<assembly>.dll` join, which is exactly how a fixture path
 * and the resolver's idea of it drift apart.
 */
export function builtDll(project: ConsoleProject, tfm: string = TFM): string {
  return path.join(project.dir, 'bin', 'Debug', tfm, `${project.assemblyName}.dll`);
}

/**
 * An MSBuild "stopper": a complete, constant, zero-element project document.
 *
 * The committed fixture workspace lives inside the SharpLsp repository, so a
 * project written there inherits the repo `Directory.Build.props` — analyzers,
 * `TreatWarningsAsErrors`, two package references — and a fixture console app
 * would fail to build for reasons unrelated to debugging. MSBuild stops walking
 * up at the first `Directory.Build.props`, so this isolates the scratch tree. It
 * is an authored constant document, never a spliced or edited one.
 */
export const MSBUILD_ISOLATION_PROPS = '<Project />\n';

/**
 * The Roslyn analyzer-config stopper for the same scratch trees.
 *
 * `Directory.Build.props` stops only MSBuild's OWN upward walk. Roslyn reads
 * `.editorconfig` up a SEPARATE walk that nothing in MSBuild stops, and the
 * repo root's `dotnet_analyzer_diagnostic.severity = error` then escalates SDK
 * analyzers inside the fixture — `CA1707` fails the build of any test method
 * named `Does_Something`, which is every idiomatic test name, so discovery and
 * runs over a workspace-rooted fixture die for reasons unrelated to what the
 * suite asserts. `root = true` ends that walk at the scratch root. A constant
 * authored document, like the MSBuild stopper above.
 */
export const EDITORCONFIG_ISOLATION = 'root = true\n';

/**
 * Drop the config stoppers into `dir`, so a fixture build is self-contained.
 *
 * All three upward walks end at the scratch root: `Directory.Build.props` and
 * `Directory.Build.targets` for MSBuild, `.editorconfig` for Roslyn.
 */
export function isolateFromRepoMsbuild(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const props = path.join(dir, 'Directory.Build.props');
  fs.writeFileSync(props, MSBUILD_ISOLATION_PROPS, 'utf-8');
  fs.writeFileSync(path.join(dir, 'Directory.Build.targets'), MSBUILD_ISOLATION_PROPS, 'utf-8');
  fs.writeFileSync(path.join(dir, '.editorconfig'), EDITORCONFIG_ISOLATION, 'utf-8');
  return props;
}

/**
 * Materialise a REALLY SPAWNABLE stand-in for netcoredbg.
 *
 * A `#!/bin/sh` script named `netcoredbg.exe` satisfies `existsSync` but is not
 * a valid PE image, so Windows fails `CreateProcess` — and since the factory now
 * refuses a descriptor it cannot spawn ([DEBUG-ADAPTER-NETCOREDBG]), a stub that
 * cannot execute makes every "a resolvable adapter produces a router" case fail
 * on Windows for a reason that has nothing to do with resolution. Copying a real
 * system binary keeps the stub spawnable on every platform.
 */
export function writeSpawnableAdapter(target: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (process.platform === 'win32') {
    // `process.execPath` — the running Electron/Node binary — is the only image
    // guaranteed to exist AND to be spawnable by this very process. A copy of
    // `cmd.exe` was tried first and does NOT spawn under another name, which
    // turned every "a resolvable adapter produces a router" case red on Windows
    // while passing on POSIX.
    fs.copyFileSync(process.execPath, target);
    return target;
  }
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', 'utf-8');
  fs.chmodSync(target, 0o755);
  return target;
}
