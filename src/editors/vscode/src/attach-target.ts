// Resolving an `attach` configuration to a live process id.
//
// Implements the [DEBUG-FEATURES-LAUNCH] rows "Attach to running process by PID
// | attach | P1" and "Attach to running process by name | attach (processName)
// | P2 | SharpLsp resolves name -> PID", plus the refusal contract
// [DEBUG-FEATURES-LAUNCH-SCRIPT] rule 6 states and the attach path inherits:
// "Every unsupported combination produces exactly one user-visible message. A
// silent no-op is non-conforming."
//
// netcoredbg only ever reads `processId`. Handing it a configuration that names
// a `processName` makes it answer
// `can't parse: key 'processId' not found`, which VS Code surfaces as a modal
// error nobody can act on; handing it a pid that no longer exists starts a
// session against nothing. Both are resolved HERE, before a session is created,
// so the workbench's `startDebugging` result is the honest answer.
import { execFile } from 'node:child_process';
import * as path from 'node:path';

/** How long a process listing may take before the attach is refused. */
const LIST_TIMEOUT_MS = 10_000;

/** Plenty for a full process table; a truncated one would misresolve a name. */
const LIST_MAX_BUFFER = 16 * 1024 * 1024;

/** The extensions a .NET process is launched from, for name matching. */
const MANAGED_SUFFIXES: readonly string[] = ['.dll', '.exe', ''];

/** What resolving an attach configuration decided. */
export type AttachOutcome =
  | { readonly kind: 'attach'; readonly processId: number }
  | { readonly kind: 'refused'; readonly reason: string };

/** One row of the host's process table. */
interface ProcessRow {
  readonly pid: number;
  readonly commandLine: string;
}

/** True when `pid` names a process this user can signal — signal 0 only probes. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    // EPERM means the process exists but belongs to someone else, which is
    // still a live process and still a legitimate attach target.
    return isRecord(cause) && cause.code === 'EPERM';
  }
}

/** Narrow an unknown to an indexable object without asserting it is one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A configuration field read as a positive integer, or undefined. */
function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? wholeNumber(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * A pid spelling is DIGITS ONLY, checked by round-tripping through the same
 * parser rather than by pattern-matching the text.
 *
 * `Number.parseInt` stops at the first non-digit, so '12abc' reads as 12 - and
 * because a system-owned pid answers EPERM, which counts as alive, a mistyped
 * or truncated pid resolved to a real attach against an unrelated process.
 */
function wholeNumber(text: string): number {
  const parsed = Number.parseInt(text, 10);
  return String(parsed) === text ? parsed : Number.NaN;
}

/** Run a command and resolve with its stdout, or with '' when it fails. */
async function capture(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER },
      (error, stdout) => {
        resolve(error === null ? stdout : '');
      },
    );
  });
}

/**
 * One `ps` line split into its pid and its command line.
 *
 * `ps -Ao pid=,args=` emits the pid right-aligned in a fixed column followed by
 * the full argument vector, so the split is at the first run of whitespace and
 * everything after it — spaces included — is the command line.
 */
function posixRow(line: string): ProcessRow | undefined {
  const trimmed = line.trimStart();
  const gap = trimmed.indexOf(' ');
  if (gap <= 0) return undefined;
  const pid = positiveInteger(trimmed.slice(0, gap));
  if (pid === undefined) return undefined;
  return { pid, commandLine: trimmed.slice(gap + 1).trim() };
}

/** The host's process table on Linux and macOS. */
async function posixProcesses(): Promise<ProcessRow[]> {
  const listing = await capture('ps', ['-Ao', 'pid=,args=']);
  return listing
    .split('\n')
    .map((line) => posixRow(line))
    .filter((row): row is ProcessRow => row !== undefined);
}

/** One row of PowerShell's `Get-CimInstance Win32_Process` JSON. */
function windowsRow(entry: unknown): ProcessRow | undefined {
  if (!isRecord(entry)) return undefined;
  const pid = positiveInteger(entry.ProcessId);
  if (pid === undefined) return undefined;
  const commandLine = typeof entry.CommandLine === 'string' ? entry.CommandLine : '';
  const name = typeof entry.Name === 'string' ? entry.Name : '';
  return { pid, commandLine: commandLine.length > 0 ? commandLine : name };
}

/**
 * The host's process table on Windows.
 *
 * `ConvertTo-Json` is asked for explicitly rather than parsing `tasklist`'s
 * columns: the command line is the field a managed process must be matched on,
 * and it contains spaces and quotes that no column split survives.
 */
function windowsFilterCommand(processName: string): string {
  const stem = path.win32.basename(processName).replace(/\.(?:dll|exe)$/iu, '');
  const executable = `${stem}.exe`.replaceAll("'", "''");
  const filter = `Name='dotnet.exe' OR Name='${executable}'`;
  const encodedFilter = Buffer.from(filter, 'utf16le').toString('base64');
  return (
    `$filter=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedFilter}'));` +
    'Get-CimInstance Win32_Process -Filter $filter | ' +
    'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'
  );
}

async function windowsProcesses(processName: string): Promise<ProcessRow[]> {
  const listing = await capture('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    windowsFilterCommand(processName),
  ]);
  if (listing.trim().length === 0) return [];
  const parsed: unknown = JSON.parse(listing);
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((entry) => windowsRow(entry))
    .filter((row): row is ProcessRow => row !== undefined);
}

/** Every process visible to this user, on whichever host is running. */
async function listProcesses(processName: string): Promise<ProcessRow[]> {
  return process.platform === 'win32'
    ? await windowsProcesses(processName)
    : await posixProcesses();
}

/**
 * Split a command line into whitespace-separated tokens, honouring quotes.
 *
 * A managed entry point routinely lives under a path with spaces
 * (`"C:\Program Files\App\App.dll"`), so a bare split would shatter exactly the
 * token the name has to be matched against.
 */
export function commandTokens(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  for (const character of commandLine) {
    if (quote !== '') {
      if (character === quote) quote = '';
      else current += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ' ' || character === '\t') {
      if (current.length > 0) tokens.push(current);
      current = '';
    } else current += character;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * True when `row` is the process the user named.
 *
 * A .NET console app is normally launched as `dotnet Whatever.dll`, so the
 * assembly name appears as an ARGUMENT rather than as the executable. Matching
 * only the executable would resolve every such app to `dotnet` and attach to
 * whichever one happened to be first.
 */
export function matchesProcessName(row: ProcessRow, name: string): boolean {
  const wanted = MANAGED_SUFFIXES.map((suffix) => `${name}${suffix}`.toLowerCase());
  return commandTokens(row.commandLine).some((token) =>
    wanted.includes(fileNameOf(token).toLowerCase()),
  );
}

/**
 * The file name of `token`, whichever platform's separators the token uses.
 *
 * `path.basename` only knows the HOST's separator, so a Windows-shaped path in
 * a command line — `"C:\a b\StepTarget.dll"` — came back whole when the
 * listing was read on Linux, and a process the user named by assembly matched
 * nothing. A command line is text from another process, not a host path: it can
 * carry either separator wherever it is read.
 */
function fileNameOf(token: string): string {
  const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return cut === -1 ? token : token.slice(cut + 1);
}

/** The refusal a name that matched nothing produces. */
function noSuchName(name: string): AttachOutcome {
  return {
    kind: 'refused',
    reason: `No running .NET process named '${name}' was found to attach to.`,
  };
}

/** The refusal an ambiguous name produces, naming the pids it could mean. */
function ambiguousName(name: string, pids: readonly number[]): AttachOutcome {
  return {
    kind: 'refused',
    reason:
      `'${name}' matches ${String(pids.length)} running processes (${pids.join(', ')}). ` +
      'Attach with an explicit `processId` to choose one.',
  };
}

/** Resolve a `processName` to the single live process it names. */
async function resolveByName(name: string): Promise<AttachOutcome> {
  const matched = (await listProcesses(name)).filter(
    (row) => row.pid !== process.pid && matchesProcessName(row, name),
  );
  const pids = matched.map((row) => row.pid);
  if (pids.length === 0) return noSuchName(name);
  const only = pids[0];
  if (pids.length > 1 || only === undefined) return ambiguousName(name, pids);
  return { kind: 'attach', processId: only };
}

/**
 * Decide what an `attach` configuration actually addresses.
 *
 * Returns `undefined` for anything that is not an attach, so the caller can
 * pass a launch configuration straight through.
 */
export async function resolveAttachTarget(
  config: Record<string, unknown>,
): Promise<AttachOutcome | undefined> {
  if (config.request !== 'attach') return undefined;
  const pid = positiveInteger(config.processId);
  if (pid !== undefined) {
    if (isProcessAlive(pid)) return { kind: 'attach', processId: pid };
    return {
      kind: 'refused',
      reason: `Process ${String(pid)} is not running; nothing to attach to.`,
    };
  }
  const name = config.processName;
  if (typeof name === 'string' && name.trim().length > 0) return await resolveByName(name.trim());
  return {
    kind: 'refused',
    reason: 'An attach configuration must name either `processId` or `processName`.',
  };
}
