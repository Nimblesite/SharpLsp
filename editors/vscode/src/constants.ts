/** Extension-wide constants. */

export const EXTENSION_ID = "forge-lsp";
export const EXTENSION_NAME = "Forge";
export const OUTPUT_CHANNEL_NAME = "Forge";
export const TRACE_CHANNEL_NAME = "Forge Trace";
export const SERVER_BINARY = "forge-lsp";
export const SERVER_BINARY_WIN = "forge-lsp.exe";

export const CONFIG_SECTION = "forge";
export const CONFIG_SERVER_PATH = "server.path";
export const CONFIG_SERVER_EXTRA_ARGS = "server.extraArgs";
export const CONFIG_LOGGING_LEVEL = "logging.level";

export const CMD_RESTART_SERVER = "forge.restartServer";
export const CMD_SHOW_OUTPUT = "forge.showOutput";
export const CMD_SHOW_TRACE = "forge.showTraceOutput";
export const CMD_SELECT_SOLUTION = "forge.selectSolution";
export const CMD_REFRESH_EXPLORER = "forge.refreshExplorer";
export const CMD_SORT_NATURAL = "forge.sortNatural";
export const CMD_SORT_ALPHABETICAL = "forge.sortAlphabetical";
export const CMD_SORT_ACCESSIBILITY = "forge.sortAccessibility";

export const CMD_REMOVE_NUGET_PACKAGE = "forge.removeNuGetPackage";
export const CMD_REMOVE_PROJECT_REFERENCE = "forge.removeProjectReference";
export const CMD_SORT_MEMBERS = "forge.sortMembers";
export const CMD_COPY_QUALIFIED_NAME = "forge.copyQualifiedName";
export const CMD_COPY_NAME = "forge.copyName";
export const CMD_REVEAL_IN_EXPLORER = "forge.revealInExplorer";

export const CMD_PROFILER_LIST_PROCESSES = "forge.profiler.listProcesses";
export const CMD_PROFILER_START_TRACE = "forge.profiler.startTrace";
export const CMD_PROFILER_STOP_TRACE = "forge.profiler.stopTrace";
export const CMD_PROFILER_START_COUNTERS = "forge.profiler.startCounters";
export const CMD_PROFILER_STOP_COUNTERS = "forge.profiler.stopCounters";
export const CMD_PROFILER_COLLECT_DUMP = "forge.profiler.collectDump";
export const CMD_PROFILER_ANALYZE_HEAP = "forge.profiler.analyzeHeap";
export const CMD_PROFILER_REFRESH = "forge.profiler.refresh";
export const CMD_PROFILER_DIFF_SNAPSHOTS = "forge.profiler.diffSnapshots";
export const CMD_PROFILER_DETECT_LEAKS = "forge.profiler.detectLeaks";
export const CMD_PROFILER_SHOW_OBJECT_GRAPH = "forge.profiler.showObjectGraph";
export const CMD_PROFILER_INSPECT_OBJECT = "forge.profiler.inspectObject";

export const VIEW_SOLUTION_EXPLORER = "forge.solutionExplorer";
export const VIEW_PROFILER = "forge.profiler";
