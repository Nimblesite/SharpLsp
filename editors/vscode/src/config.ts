import { workspace } from 'vscode';
import {
  CONFIG_SECTION,
  CONFIG_SERVER_PATH,
  CONFIG_SERVER_EXTRA_ARGS,
  CONFIG_LOGGING_LEVEL,
  CONFIG_FSI_EXTRA_ARGS,
} from './constants.js';

function section(): ReturnType<typeof workspace.getConfiguration> {
  return workspace.getConfiguration(CONFIG_SECTION);
}

/**
 * User-configured path to the sharplsp binary, or empty string.
 *
 * Implements [DIST-WORKSPACE-TRUST]: this value selects which executable is
 * spawned as the language server, so an untrusted workspace must never be able
 * to supply it. `package.json` already lists `sharplsp.lspPath` under
 * `capabilities.untrustedWorkspaces.restrictedConfigurations`, which makes
 * VS Code ignore workspace-scoped values until trust is granted; this guard is
 * defence-in-depth so the dangerous path is never honoured in an untrusted
 * window even if the declarative restriction is ever lifted.
 */
export function serverPath(): string {
  if (!workspace.isTrusted) return '';
  return section().get<string>(CONFIG_SERVER_PATH) ?? '';
}

/**
 * Extra CLI arguments to pass to the server process.
 *
 * Implements [DIST-WORKSPACE-TRUST]: extra args are applied to whatever server
 * binary runs, so an untrusted workspace must not be able to inject them.
 */
export function serverExtraArgs(): readonly string[] {
  if (!workspace.isTrusted) return [];
  return section().get<string[]>(CONFIG_SERVER_EXTRA_ARGS) ?? [];
}

/** Logging level forwarded to the server as `RUST_LOG`. */
export function loggingLevel(): string {
  return section().get<string>(CONFIG_LOGGING_LEVEL) ?? 'info';
}

/**
 * Extra arguments passed to `dotnet fsi` when starting F# Interactive.
 *
 * Implements [DIST-WORKSPACE-TRUST]: these are CLI arguments applied to a
 * spawned process, so — like `serverExtraArgs` — an untrusted workspace must
 * not be able to inject them. `package.json` lists this key under
 * `restrictedConfigurations`; this guard is defence-in-depth.
 */
export function fsiExtraArgs(): readonly string[] {
  if (!workspace.isTrusted) return [];
  return section().get<string[]>(CONFIG_FSI_EXTRA_ARGS) ?? [];
}

/** Whether to show parameter name inlay hints. */
export function inlayHintsParameterNames(): boolean {
  return section().get<boolean>('inlayHints.parameterNames') ?? true;
}

/** Whether to show type inference inlay hints. */
export function inlayHintsTypeInference(): boolean {
  return section().get<boolean>('inlayHints.typeInference') ?? true;
}

/** Whether to show F# pipeline type hints. */
export function inlayHintsPipelineTypes(): boolean {
  return section().get<boolean>('inlayHints.pipelineTypes') ?? true;
}

/** Whether to include prerelease NuGet packages. */
export function nugetIncludePrerelease(): boolean {
  return section().get<boolean>('nuget.includePrerelease') ?? false;
}

/** Whether hot reload on save is enabled. */
export function hotReloadOnSave(): boolean {
  return section().get<boolean>('hotReload.onSave') ?? false;
}
