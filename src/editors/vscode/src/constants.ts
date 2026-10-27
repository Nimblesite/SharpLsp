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
export const CONFIG_FSI_EXTRA_ARGS = 'fsi.extraArgs';

export const CMD_RESTART_SERVER = 'sharplsp.restartServer';
export const CMD_RETRY_DOTNET_ACQUISITION = 'sharplsp.retryDotnetAcquisition';
export const CMD_SHOW_OUTPUT = 'sharplsp.showOutput';
export const CMD_SHOW_TRACE = 'sharplsp.showTraceOutput';
export const CMD_SELECT_SOLUTION = 'sharplsp.selectSolution';
export const CMD_SELECT_TARGET_FRAMEWORK = 'sharplsp.selectTargetFramework';
export const CMD_REFRESH_EXPLORER = 'sharplsp.refreshExplorer';
export const CMD_SORT_NATURAL = 'sharplsp.sortNatural';
export const CMD_SORT_ALPHABETICAL = 'sharplsp.sortAlphabetical';
export const CMD_SORT_ACCESSIBILITY = 'sharplsp.sortAccessibility';
export const CMD_NEST_NAMESPACES = 'sharplsp.nestNamespaces';
export const CMD_FLATTEN_NAMESPACES = 'sharplsp.flattenNamespaces';

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

// Add source file into compile order (GitHub #493, [SE-ADD-FILE-COMMAND])
export const CMD_ADD_FSHARP_FILE = 'sharplsp.addFSharpSourceFile';
/** VS Code context key: the Solution Explorer selection belongs to an F# project. */
export const CONTEXT_FS_PROJECT_SELECTED = 'sharplsp.fsProjectSelected';

// Scaffolding (dotnet new)
export const CMD_NEW_SOLUTION = 'sharplsp.newSolution';
export const CMD_NEW_PROJECT = 'sharplsp.newProject';
export const CMD_NEW_FILE = 'sharplsp.newFile';
export const CMD_ADD_PROJECT_TO_SOLUTION = 'sharplsp.addProjectToSolution';

// F# Interactive
export const CMD_FSI_SEND_FILE = 'sharplsp.fsi.sendFile';
export const CMD_FSI_START = 'sharplsp.fsi.start';
export const CMD_FSI_GENERATE_SIGNATURE = 'sharplsp.fsi.generateSignature';

// Debug
export const DEBUG_TYPE = 'sharplsp-coreclr';
export const CMD_DEBUG_PROGRAM = 'sharplsp.debugProgram';
export const CMD_RUN_PROGRAM = 'sharplsp.runProgram';

// Test Explorer
export const CMD_TEST_RUN_AT_CURSOR = 'sharplsp.test.runAtCursor';
export const CMD_TEST_DEBUG_AT_CURSOR = 'sharplsp.test.debugAtCursor';

// Interactive tutorial ([TUTORIAL])
export const CMD_TUTORIAL_OPEN = 'sharplsp.tutorial.open';
export const CMD_TUTORIAL_OPEN_FILE = 'sharplsp.tutorial.openFile';
export const CMD_TUTORIAL_RESET = 'sharplsp.tutorial.reset';
export const CONFIG_TUTORIAL_SHOW_ON_STARTUP = 'tutorial.showOnStartup';

export const VIEW_SOLUTION_EXPLORER = 'sharplsp.solutionExplorer';
export const VIEW_PROFILER = 'sharplsp.profiler.processes';
export const VIEW_TEST_EXPLORER = 'sharplsp.testExplorer';
