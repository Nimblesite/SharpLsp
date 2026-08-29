// Signalling a child that never started signals US.
//
// `ChildProcess.kill()` forwards to `kill(this.pid, ...)`, and a child whose
// spawn FAILED carries no pid — Node then issues `kill(0, ...)`, which POSIX
// defines as "every process in the CALLER'S process group". Spawn failures on
// Node's EACCES/EAGAIN/EMFILE/ENFILE/ENOENT allowlist arrive ASYNCHRONOUSLY, so
// the window between constructing a child and learning it never started is the
// ordinary case, not a rare one: a bundled netcoredbg that lost its execute bit
// in a VSIX unzip lands squarely in it.
//
// In the extension host that process group is the whole VS Code tree; under CI
// it also holds the test runner, `make` and the runner agent, so one unstartable
// debugger terminated the entire job with no test output at all.
//
// Implements [DEBUG-ARCHITECTURE-ROUTER].
import type { ChildProcess } from 'node:child_process';

/** The pid of a child that really started, or undefined when it never did. */
export function livePid(child: ChildProcess): number | undefined {
  const pid = child.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Signal `child` only when it really started. Returns whether a signal was sent,
 * so a caller that must escalate can tell "already gone" from "still running".
 */
export function signalChild(child: ChildProcess, signal?: NodeJS.Signals): boolean {
  return livePid(child) === undefined ? false : child.kill(signal);
}
