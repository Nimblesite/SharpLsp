// Implements [PROF-UI]. See docs/specs/LSP-PROFILER-SPEC.md
/**
 * Shared constants and type helpers for profiler test suites.
 *
 * Extracted to avoid duplication across profiler.test.ts,
 * profiler-decorations.test.ts, and profiler-memory-integration.test.ts.
 *
 * Manifest contributions live in ./extension-manifest — they are read by every
 * suite, not just the profiler ones.
 */

/** Profiler client-side commands (registered in profiler.ts). */
export const PROFILER_CLIENT_COMMANDS = [
  'sharplsp.profiler.profileStart',
  'sharplsp.profiler.profileStop',
  'sharplsp.profiler.profileSnapshot',
  'sharplsp.profiler.profileAttachToDebug',
  'sharplsp.profiler.profileShowResults',
] as const;

/** Memory profiler client-side commands (registered in memory-profiler.ts). */
export const MEMORY_CLIENT_COMMANDS = [
  'sharplsp.profiler.memoryStart',
  'sharplsp.profiler.memorySnapshot',
  'sharplsp.profiler.memoryStop',
  'sharplsp.profiler.memoryReferences',
] as const;

/** Profiler server-side commands (advertised by LSP). */
export const PROFILER_SERVER_COMMANDS = [
  'sharplsp.lspProfiler.cpu.start',
  'sharplsp.lspProfiler.cpu.stop',
  'sharplsp.lspProfiler.cpu.snapshot',
  'sharplsp.lspProfiler.cpu.list',
  'sharplsp.lspProfiler.cpu.cooperativeScript',
  'sharplsp.lspProfiler.cpu.cooperativeAttach',
] as const;

/** Profiler configuration keys. */
export const PROFILER_SETTINGS = [
  'sharplsp.profiler.sampleRate',
  'sharplsp.profiler.includeNative',
  'sharplsp.profiler.lineThreshold',
  'sharplsp.profiler.functionThreshold',
  'sharplsp.profiler.maxDiagnosticsPerFile',
  'sharplsp.profiler.showInlineHeatMap',
] as const;

/** Additional profiler configuration keys. */
export const PROFILER_EXTRA_SETTINGS = [
  'sharplsp.profiler.profileOnLaunch',
  'sharplsp.profiler.preset',
] as const;
