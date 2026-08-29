// Process-tree resource assertions for the real-repository extension-host suites.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export interface ProcessSample {
  pid: number;
  parentPid: number;
  name: string;
  rssBytes: number;
  cpuSeconds: number;
  commandLine: string;
}

interface Win32ProcessRow {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
  WorkingSetSize: number;
  UserModeTime: number;
  KernelModeTime: number;
}

const WINDOWS_PROCESS_QUERY =
  'Get-CimInstance Win32_Process | ' +
  'Select-Object ProcessId,ParentProcessId,Name,CommandLine,' +
  'WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress';

const ownedProcessIdentities = new Map<number, string>();

/** Sample the SharpLsp fleet started by this host, retaining any surviving orphans. */
export function sampleServerProcesses(rootPid = process.pid): ProcessSample[] {
  const all = process.platform === 'win32' ? sampleWindows() : samplePosix();
  const descendants = descendantPids(all, rootPid);
  pruneOwnedProcesses(all);
  rememberOwnedProcesses(all, descendants);
  return all.filter((sample) => ownedProcessIdentities.get(sample.pid) === processIdentity(sample));
}

function pruneOwnedProcesses(samples: readonly ProcessSample[]): void {
  const live = new Map(samples.map((sample) => [sample.pid, sample]));
  for (const [pid, identity] of ownedProcessIdentities) {
    const sample = live.get(pid);
    if (
      sample === undefined ||
      !isSharpLspProcess(sample) ||
      processIdentity(sample) !== identity
    ) {
      ownedProcessIdentities.delete(pid);
    }
  }
}

function rememberOwnedProcesses(
  samples: readonly ProcessSample[],
  descendants: ReadonlySet<number>,
): void {
  for (const sample of samples) {
    if (descendants.has(sample.pid) && isSharpLspProcess(sample)) {
      ownedProcessIdentities.set(sample.pid, processIdentity(sample));
    }
  }
}

function processIdentity(sample: ProcessSample): string {
  return `${sample.name}\u001f${sample.commandLine}`;
}

function sampleWindows(): ProcessSample[] {
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY],
    { encoding: 'utf8', timeout: 30_000 },
  ).trim();
  if (raw.length === 0) return [];
  const parsed = JSON.parse(raw) as Win32ProcessRow | Win32ProcessRow[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(windowsProcessSample);
}

function windowsProcessSample(row: Win32ProcessRow): ProcessSample {
  return {
    pid: row.ProcessId,
    parentPid: row.ParentProcessId,
    name: row.Name,
    rssBytes: row.WorkingSetSize,
    cpuSeconds: (row.UserModeTime + row.KernelModeTime) / 1e7,
    commandLine: row.CommandLine ?? '',
  };
}

function samplePosix(): ProcessSample[] {
  const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,time=,args='], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parsePosixSample)
    .filter((sample): sample is ProcessSample => sample !== undefined);
}

function parsePosixSample(line: string): ProcessSample | undefined {
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
  const [, pid, parentPid, rssKb, time, args] = match ?? [];
  if (
    pid === undefined ||
    parentPid === undefined ||
    rssKb === undefined ||
    time === undefined ||
    args === undefined
  )
    return undefined;
  return {
    pid: Number(pid),
    parentPid: Number(parentPid),
    name: path.basename(args.split(' ')[0] ?? ''),
    rssBytes: Number(rssKb) * 1024,
    cpuSeconds: parsePsTime(time),
    commandLine: args,
  };
}

function descendantPids(samples: readonly ProcessSample[], rootPid: number): Set<number> {
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const sample of samples) {
      if (!descendants.has(sample.parentPid) || descendants.has(sample.pid)) continue;
      descendants.add(sample.pid);
      changed = true;
    }
  }
  return descendants;
}

function isSharpLspProcess(sample: ProcessSample): boolean {
  const name = sample.name.toLowerCase();
  return (
    name.startsWith('sharplsp') ||
    ((name === 'dotnet' || name === 'dotnet.exe') && sidecarLanguage(sample) !== undefined)
  );
}

function sidecarLanguage(sample: ProcessSample): 'csharp' | 'fsharp' | undefined {
  const processText = `${sample.name} ${sample.commandLine}`.toLowerCase();
  if (processText.includes('sidecar-csharp') || processText.includes('sidecar.csharp')) {
    return 'csharp';
  }
  if (processText.includes('sidecar-fsharp') || processText.includes('sidecar.fsharp')) {
    return 'fsharp';
  }
  return undefined;
}

function parsePsTime(time: string): number {
  const dashIndex = time.indexOf('-');
  const days = dashIndex >= 0 ? Number(time.slice(0, dashIndex)) : 0;
  const clock = dashIndex >= 0 ? time.slice(dashIndex + 1) : time;
  const parts = clock.split(':').map(Number).reverse();
  const [seconds = 0, minutes = 0, hours = 0] = parts;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

const HOST_RSS_MAX_BYTES = 2 * 1024 ** 3;
const SIDECAR_RSS_MAX_BYTES = 4 * 1024 ** 3;
const MAX_SIDECARS_PER_LANGUAGE = 2;

export function assertServerResourceBounds(samples: ProcessSample[]): void {
  assert.ok(samples.length >= 1, 'at least one SharpLsp server process must be running');
  for (const sample of samples) assertProcessResourceBound(sample);
  for (const language of ['csharp', 'fsharp'] as const) {
    const count = samples.filter((sample) => sidecarLanguage(sample) === language).length;
    assert.ok(
      count <= MAX_SIDECARS_PER_LANGUAGE,
      `${count.toString()} ${language} sidecars running - expected <= ${MAX_SIDECARS_PER_LANGUAGE.toString()}`,
    );
  }
}

function assertProcessResourceBound(sample: ProcessSample): void {
  const isHost =
    sample.name.toLowerCase().startsWith('sharplsp') && !sample.commandLine.includes('sidecar');
  const cap = isHost ? HOST_RSS_MAX_BYTES : SIDECAR_RSS_MAX_BYTES;
  const mib = Math.round(sample.rssBytes / 1024 ** 2);
  assert.ok(
    sample.rssBytes < cap,
    `${sample.name} (pid ${sample.pid.toString()}) rss ${mib.toString()} MiB exceeds cap`,
  );
  assert.ok(sample.cpuSeconds >= 0, `${sample.name} cpu time must be readable`);
}

export async function assertCpuSettles(windowMs: number, maxCpuSeconds: number): Promise<void> {
  const attempts = 12;
  let lastDelta = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = totalCpuSeconds(sampleServerProcesses());
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    lastDelta = totalCpuSeconds(sampleServerProcesses()) - before;
    if (lastDelta < maxCpuSeconds) return;
  }
  assert.fail(
    `server fleet never settled: ${lastDelta.toFixed(1)} cpu-seconds per ` +
      `${windowMs.toString()}ms window; cap ${maxCpuSeconds.toString()}s`,
  );
}

function totalCpuSeconds(samples: ProcessSample[]): number {
  return samples.reduce((sum, sample) => sum + sample.cpuSeconds, 0);
}
