import { type LanguageClient } from 'vscode-languageclient/node';
import * as log from '../log.js';
import { getErrorMessage } from '../utils.js';
import {
  type NuGetInstalledResponse,
  type NuGetMutationResponse,
  type NuGetSearchResponse,
  type NuGetTarget,
  type NuGetTargetsResponse,
  type NuGetVersionsResponse,
} from './types.js';

// ── LSP request wrappers ──────────────────────────────────────
//
// Every wrapper returns a discriminated `Result<T, E>` so callers can
// surface errors without try/catch sprinkled at call sites.

export type LspResult<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): LspResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): LspResult<T> {
  return { ok: false, error };
}

export async function fetchTargets(
  lsp: LanguageClient,
  workspaceRoot: string,
): Promise<LspResult<NuGetTargetsResponse>> {
  try {
    log.info(`nuget/lsp: fetchTargets workspace=${workspaceRoot}`);
    const result = await lsp.sendRequest<NuGetTargetsResponse>('forge/nuget/targets', {
      workspaceRoot,
    });
    return ok(result);
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    log.error(`nuget/lsp: fetchTargets failed: ${msg}`);
    return fail(msg);
  }
}

export async function fetchInstalled(
  lsp: LanguageClient,
  target: NuGetTarget,
): Promise<LspResult<NuGetInstalledResponse>> {
  try {
    log.info(`nuget/lsp: fetchInstalled target=${target.id}`);
    const result = await lsp.sendRequest<NuGetInstalledResponse>('forge/nuget/installed', {
      target,
      projectPath: target.path,
    });
    return ok(result);
  } catch (err: unknown) {
    return fail(getErrorMessage(err));
  }
}

export async function searchPackages(
  lsp: LanguageClient,
  target: NuGetTarget,
  query: string,
  take = 50,
): Promise<LspResult<NuGetSearchResponse>> {
  try {
    log.info(`nuget/lsp: searchPackages target=${target.id} query="${query}"`);
    const result = await lsp.sendRequest<NuGetSearchResponse>('forge/nuget/search', {
      query,
      target,
      projectPath: target.path,
      prerelease: false,
      take,
      skip: 0,
    });
    return ok(result);
  } catch (err: unknown) {
    return fail(getErrorMessage(err));
  }
}

export async function fetchVersions(
  lsp: LanguageClient,
  packageId: string,
): Promise<LspResult<NuGetVersionsResponse>> {
  try {
    const result = await lsp.sendRequest<NuGetVersionsResponse>('forge/nuget/versions', {
      packageId,
    });
    return ok(result);
  } catch (err: unknown) {
    return fail(getErrorMessage(err));
  }
}

export async function installPackage(
  lsp: LanguageClient,
  target: NuGetTarget,
  packageId: string,
  version: string,
): Promise<LspResult<NuGetMutationResponse>> {
  try {
    log.info(`nuget/lsp: install ${packageId} v${version} into ${target.id}`);
    const result = await lsp.sendRequest<NuGetMutationResponse>('forge/nuget/install', {
      target,
      projectPath: target.path,
      packageId,
      version,
    });
    return ok(result);
  } catch (err: unknown) {
    return fail(getErrorMessage(err));
  }
}

export async function uninstallPackage(
  lsp: LanguageClient,
  target: NuGetTarget,
  packageId: string,
): Promise<LspResult<NuGetMutationResponse>> {
  try {
    log.info(`nuget/lsp: uninstall ${packageId} from ${target.id}`);
    const result = await lsp.sendRequest<NuGetMutationResponse>('forge/nuget/uninstall', {
      target,
      projectPath: target.path,
      packageId,
    });
    return ok(result);
  } catch (err: unknown) {
    return fail(getErrorMessage(err));
  }
}
