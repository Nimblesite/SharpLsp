/** Extension-wide constants. */

export const EXTENSION_ID = 'forge-lsp';
export const EXTENSION_NAME = 'Forge';
export const OUTPUT_CHANNEL_NAME = 'Forge';
export const TRACE_CHANNEL_NAME = 'Forge Trace';
export const SERVER_BINARY = 'forge-lsp';
export const SERVER_BINARY_WIN = 'forge-lsp.exe';

export const CONFIG_SECTION = 'forge';
export const CONFIG_SERVER_PATH = 'server.path';
export const CONFIG_SERVER_EXTRA_ARGS = 'server.extraArgs';
export const CONFIG_LOGGING_LEVEL = 'logging.level';

export const CMD_RESTART_SERVER = 'forge.restartServer';
export const CMD_SHOW_OUTPUT = 'forge.showOutput';
export const CMD_SHOW_TRACE = 'forge.showTraceOutput';
export const CMD_SELECT_SOLUTION = 'forge.selectSolution';
export const CMD_REFRESH_EXPLORER = 'forge.refreshExplorer';
export const CMD_SORT_NATURAL = 'forge.sortNatural';
export const CMD_SORT_ALPHABETICAL = 'forge.sortAlphabetical';
export const CMD_SORT_ACCESSIBILITY = 'forge.sortAccessibility';

export const CMD_REMOVE_NUGET_PACKAGE = 'forge.removeNuGetPackage';
export const CMD_REMOVE_PROJECT_REFERENCE = 'forge.removeProjectReference';
export const CMD_SORT_MEMBERS = 'forge.sortMembers';
export const CMD_COPY_QUALIFIED_NAME = 'forge.copyQualifiedName';
export const CMD_COPY_NAME = 'forge.copyName';
export const CMD_REVEAL_IN_EXPLORER = 'forge.revealInExplorer';
export const CMD_BROWSE_NUGET_PACKAGES = 'forge.browseNuGetPackages';
export const CMD_OPEN_SOLUTION = 'forge.openSolution';

export const CMD_PROFILER_LIST_PROCESSES = 'forge.profiler.listProcesses';
export const CMD_PROFILER_START_TRACE = 'forge.profiler.startTrace';
export const CMD_PROFILER_STOP_TRACE = 'forge.profiler.stopTrace';
export const CMD_PROFILER_START_COUNTERS = 'forge.profiler.startCounters';
export const CMD_PROFILER_STOP_COUNTERS = 'forge.profiler.stopCounters';
export const CMD_PROFILER_COLLECT_DUMP = 'forge.profiler.collectDump';
export const CMD_PROFILER_ANALYZE_HEAP = 'forge.profiler.analyzeHeap';
export const CMD_PROFILER_REFRESH = 'forge.profiler.refresh';
export const CMD_PROFILER_DIFF_SNAPSHOTS = 'forge.profiler.diffSnapshots';
export const CMD_PROFILER_DETECT_LEAKS = 'forge.profiler.detectLeaks';
export const CMD_PROFILER_SHOW_OBJECT_GRAPH = 'forge.profiler.showObjectGraph';
export const CMD_PROFILER_INSPECT_OBJECT = 'forge.profiler.inspectObject';
export const CMD_PROFILER_OPEN_TRACE = 'forge.profiler.openTrace';
export const CMD_PROFILER_CONVERT_TRACE = 'forge.profiler.convertTrace';
export const CMD_PROFILER_STOP_SESSION = 'forge.profiler.stopSession';
export const CMD_PROFILER_REVEAL_OUTPUT = 'forge.profiler.revealOutput';
export const CMD_PROFILER_COPY_OUTPUT_PATH = 'forge.profiler.copyOutputPath';
export const CMD_PROFILER_SHOW_COUNTERS_PANEL = 'forge.profiler.showCountersPanel';
export const CMD_PROFILER_TRACE_PROCESS = 'forge.profiler.traceProcess';
export const CMD_PROFILER_COUNTERS_PROCESS = 'forge.profiler.countersProcess';
export const CMD_PROFILER_DUMP_PROCESS = 'forge.profiler.dumpProcess';
export const CMD_PROFILER_COPY_PID = 'forge.profiler.copyPid';

// Build commands
export const CMD_BUILD = 'forge.build';
export const CMD_REBUILD = 'forge.rebuild';
export const CMD_CLEAN = 'forge.clean';

// NuGet
export const CMD_NUGET_RESTORE = 'forge.nuget.restore';
export const CMD_NUGET_ADD_FROM_EXPLORER = 'forge.nuget.addFromExplorer';

// Project
export const CMD_OPEN_PROJECT_FILE = 'forge.openProjectFile';
export const CMD_ADD_PROJECT_REFERENCE = 'forge.addProjectReference';

// F# Interactive
export const CMD_FSI_SEND_SELECTION = 'forge.fsi.sendSelection';
export const CMD_FSI_SEND_FILE = 'forge.fsi.sendFile';
export const CMD_FSI_START = 'forge.fsi.start';
export const CMD_FSI_GENERATE_SIGNATURE = 'forge.fsi.generateSignature';

// Debug
export const DEBUG_TYPE = 'forge-coreclr';

// Test Explorer
export const CMD_TEST_RUN = 'forge.test.run';
export const CMD_TEST_DEBUG = 'forge.test.debug';
export const CMD_TEST_RUN_AT_CURSOR = 'forge.test.runAtCursor';
export const CMD_TEST_DEBUG_AT_CURSOR = 'forge.test.debugAtCursor';

export const VIEW_SOLUTION_EXPLORER = 'forge.solutionExplorer';
export const VIEW_PROFILER = 'forge.profiler';
export const VIEW_TEST_EXPLORER = 'forge.testExplorer';
