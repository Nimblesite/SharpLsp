/** Extension-wide constants. */

export const EXTENSION_ID = 'sharplsp';
export const EXTENSION_NAME = 'SharpLsp';
export const OUTPUT_CHANNEL_NAME = 'SharpLsp';
export const TRACE_CHANNEL_NAME = 'SharpLsp Trace';
export const SERVER_BINARY = 'sharplsp';
export const SERVER_BINARY_WIN = 'sharplsp.exe';

export const CONFIG_SECTION = 'sharplsp';
export const CONFIG_SERVER_PATH = 'lspPath';
export const CONFIG_SERVER_EXTRA_ARGS = 'server.extraArgs';
export const CONFIG_LOGGING_LEVEL = 'logging.level';

export const CMD_RESTART_SERVER = 'sharplsp.restartServer';
export const CMD_RETRY_DOTNET_ACQUISITION = 'sharplsp.retryDotnetAcquisition';
export const CMD_SHOW_OUTPUT = 'sharplsp.showOutput';
export const CMD_SHOW_TRACE = 'sharplsp.showTraceOutput';
export const CMD_SELECT_SOLUTION = 'sharplsp.selectSolution';
export const CMD_REFRESH_EXPLORER = 'sharplsp.refreshExplorer';
export const CMD_SORT_NATURAL = 'sharplsp.sortNatural';
export const CMD_SORT_ALPHABETICAL = 'sharplsp.sortAlphabetical';
export const CMD_SORT_ACCESSIBILITY = 'sharplsp.sortAccessibility';

export const CMD_REMOVE_NUGET_PACKAGE = 'sharplsp.removeNuGetPackage';
export const CMD_REMOVE_PROJECT_REFERENCE = 'sharplsp.removeProjectReference';
export const CMD_REMOVE_UNUSED_PACKAGES = 'sharplsp.removeUnusedPackages';
export const CMD_CONSOLIDATE_PACKAGES = 'sharplsp.consolidatePackages';
export const CMD_SORT_MEMBERS = 'sharplsp.sortMembers';
export const CMD_COPY_QUALIFIED_NAME = 'sharplsp.copyQualifiedName';
export const CMD_COPY_NAME = 'sharplsp.copyName';
export const CMD_REVEAL_IN_EXPLORER = 'sharplsp.revealInExplorer';
export const CMD_BROWSE_NUGET_PACKAGES = 'sharplsp.browseNuGetPackages';
export const CMD_OPEN_SOLUTION = 'sharplsp.openSolution';

export const CMD_PROFILER_LIST_PROCESSES = 'sharplsp.profiler.listProcesses';
export const CMD_PROFILER_START_TRACE = 'sharplsp.profiler.startTrace';
export const CMD_PROFILER_STOP_TRACE = 'sharplsp.profiler.stopTrace';
export const CMD_PROFILER_START_COUNTERS = 'sharplsp.profiler.startCounters';
export const CMD_PROFILER_STOP_COUNTERS = 'sharplsp.profiler.stopCounters';
export const CMD_PROFILER_COLLECT_DUMP = 'sharplsp.profiler.collectDump';
export const CMD_PROFILER_ANALYZE_HEAP = 'sharplsp.profiler.analyzeHeap';
export const CMD_PROFILER_REFRESH = 'sharplsp.profiler.refresh';
export const CMD_PROFILER_DIFF_SNAPSHOTS = 'sharplsp.profiler.diffSnapshots';
export const CMD_PROFILER_DETECT_LEAKS = 'sharplsp.profiler.detectLeaks';
export const CMD_PROFILER_SHOW_OBJECT_GRAPH = 'sharplsp.profiler.showObjectGraph';
export const CMD_PROFILER_INSPECT_OBJECT = 'sharplsp.profiler.inspectObject';
export const CMD_PROFILER_OPEN_TRACE = 'sharplsp.profiler.openTrace';
export const CMD_PROFILER_CONVERT_TRACE = 'sharplsp.profiler.convertTrace';
export const CMD_PROFILER_STOP_SESSION = 'sharplsp.profiler.stopSession';
export const CMD_PROFILER_REVEAL_OUTPUT = 'sharplsp.profiler.revealOutput';
export const CMD_PROFILER_COPY_OUTPUT_PATH = 'sharplsp.profiler.copyOutputPath';
export const CMD_PROFILER_SHOW_COUNTERS_PANEL = 'sharplsp.profiler.showCountersPanel';
export const CMD_PROFILER_TRACE_PROCESS = 'sharplsp.profiler.traceProcess';
export const CMD_PROFILER_COUNTERS_PROCESS = 'sharplsp.profiler.countersProcess';
export const CMD_PROFILER_DUMP_PROCESS = 'sharplsp.profiler.dumpProcess';
export const CMD_PROFILER_COPY_PID = 'sharplsp.profiler.copyPid';
export const CMD_PROFILER_KILL_PROCESS = 'sharplsp.profiler.killProcess';

// Build commands
export const CMD_BUILD = 'sharplsp.build';
export const CMD_REBUILD = 'sharplsp.rebuild';
export const CMD_CLEAN = 'sharplsp.clean';

// NuGet
export const CMD_NUGET_RESTORE = 'sharplsp.nuget.restore';
export const CMD_NUGET_ADD_FROM_EXPLORER = 'sharplsp.nuget.addFromExplorer';

// Project
export const CMD_OPEN_PROJECT_FILE = 'sharplsp.openProjectFile';
export const CMD_ADD_PROJECT_REFERENCE = 'sharplsp.addProjectReference';

// Scaffolding (dotnet new)
export const CMD_NEW_SOLUTION = 'sharplsp.newSolution';
export const CMD_NEW_PROJECT = 'sharplsp.newProject';
export const CMD_NEW_FILE = 'sharplsp.newFile';
export const CMD_ADD_PROJECT_TO_SOLUTION = 'sharplsp.addProjectToSolution';

// F# Interactive
export const CMD_FSI_SEND_SELECTION = 'sharplsp.fsi.sendSelection';
export const CMD_FSI_SEND_FILE = 'sharplsp.fsi.sendFile';
export const CMD_FSI_START = 'sharplsp.fsi.start';
export const CMD_FSI_GENERATE_SIGNATURE = 'sharplsp.fsi.generateSignature';

// Debug
export const DEBUG_TYPE = 'sharplsp-coreclr';
export const CMD_DEBUG_PROGRAM = 'sharplsp.debugProgram';

// Test Explorer
export const CMD_TEST_RUN = 'sharplsp.test.run';
export const CMD_TEST_DEBUG = 'sharplsp.test.debug';
export const CMD_TEST_RUN_AT_CURSOR = 'sharplsp.test.runAtCursor';
export const CMD_TEST_DEBUG_AT_CURSOR = 'sharplsp.test.debugAtCursor';

export const VIEW_SOLUTION_EXPLORER = 'sharplsp.solutionExplorer';
export const VIEW_PROFILER = 'sharplsp.profiler';
export const VIEW_TEST_EXPLORER = 'sharplsp.testExplorer';
