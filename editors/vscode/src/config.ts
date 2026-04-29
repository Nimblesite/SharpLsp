import { workspace } from 'vscode';
import {
  CONFIG_SECTION,
  CONFIG_SERVER_PATH,
  CONFIG_SERVER_EXTRA_ARGS,
  CONFIG_LOGGING_LEVEL,
} from './constants.js';

function section(): ReturnType<typeof workspace.getConfiguration> {
  return workspace.getConfiguration(CONFIG_SECTION);
}

/** User-configured path to the sharplsp binary, or empty string. */
export function serverPath(): string {
  return section().get<string>(CONFIG_SERVER_PATH) ?? '';
}

/** Extra CLI arguments to pass to the server process. */
export function serverExtraArgs(): readonly string[] {
  return section().get<string[]>(CONFIG_SERVER_EXTRA_ARGS) ?? [];
}

/** Logging level forwarded to the server as `RUST_LOG`. */
export function loggingLevel(): string {
  return section().get<string>(CONFIG_LOGGING_LEVEL) ?? 'info';
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
