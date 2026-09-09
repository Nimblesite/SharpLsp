/**
 * Reading a waiting test host's pid out of a debug run's live output.
 *
 * Under a debug run every test host announces itself and then BLOCKS until a
 * debugger attaches, so this text is the only signal saying which process to
 * attach to. Both runners print it: VSTest from its `testhost.dll` child, and a
 * Microsoft.Testing.Platform module about itself.
 *
 * Pure — no VS Code, no process — so it is asserted at its own boundary rather
 * than only through a real debug session.
 *
 * Implements [DEBUG-FEATURES-TESTS] and [TEST-MTP-DEBUG].
 */

/** The stable text of a waiting host's announcement, en-US pinned. */
const PROCESS_ID_PREFIX = 'Process Id:';

/** ASCII digits only, checked per UTF-16 unit — a pid is never a surrogate. */
function isAllDigits(candidate: string): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

/**
 * The pid a waiting test host announced on `line`, or undefined.
 *
 * The contract is the console line `Process Id: {0}, Name: {1}`, printed by the
 * HOST about itself — the parent never prints it with `VSTEST_RUNNER_DEBUG`
 * pinned off.
 *
 * A Microsoft.Testing.Platform module prints the SAME text behind a prefix:
 * `Waiting for debugger to attach... Process Id: 212243, Name: dotnet`. The
 * text is therefore found ANYWHERE in the line rather than only at its start —
 * anchored to the start, every MTP debug run hung on a module nothing ever
 * attached to. Spec: [TEST-MTP-DEBUG].
 *
 * The digits are validated whole: a partial `parseInt` would accept a corrupted
 * line and aim the debugger at noise.
 */
export function announcedTestHostPid(line: string): number | undefined {
  const trimmed = line.trim();
  const marker = trimmed.indexOf(PROCESS_ID_PREFIX);
  if (marker < 0) return undefined;
  const rest = trimmed.slice(marker + PROCESS_ID_PREFIX.length);
  const comma = rest.indexOf(',');
  const digits = (comma === -1 ? rest : rest.slice(0, comma)).trim();
  if (digits.length === 0 || !isAllDigits(digits)) return undefined;
  const pid = Number.parseInt(digits, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Watches a debug run's live output for waiting test hosts, once each.
 *
 * Chunk boundaries fall anywhere, so lines are reassembled before parsing; a
 * solution with several test projects announces one host PER ASSEMBLY, and
 * every one of them is waiting — each new pid is handed on exactly once.
 */
export class TestHostWatcher {
  private tail = '';
  private readonly announced = new Set<number>();

  constructor(private readonly onHost: (pid: number) => void) {}

  /** Feed one raw output chunk; complete lines are scanned for announcements. */
  public absorb(chunk: string): void {
    const lines = (this.tail + chunk).split('\n');
    this.tail = lines.pop() ?? '';
    for (const line of lines) this.offer(line);
  }

  private offer(line: string): void {
    const pid = announcedTestHostPid(line);
    if (pid === undefined || this.announced.has(pid)) return;
    this.announced.add(pid);
    this.onHost(pid);
  }
}
