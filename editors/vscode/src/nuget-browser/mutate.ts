// Optimistic install / uninstall helpers — pure data manipulation,
// no VS Code APIs, no rendering. Keeps `nuget-browser.ts` thin and gives
// us a place to unit-test the optimistic / revert flows in isolation.

import { type LanguageClient } from "vscode-languageclient/node";
import { searchPackages } from "./lsp.js";
import {
    type NuGetSearchResult,
    type NuGetTarget,
} from "./types.js";

export interface OptimisticSnapshot {
    /** Previous installed version (if any) so we can revert on failure. */
    readonly previousVersion: string | undefined;
    /** Reference to the search-result item that was mutated, if any. */
    readonly mutatedSearchResult: NuGetSearchResult | undefined;
}

/** Apply an optimistic install to local state and return a snapshot for revert. */
export function applyOptimisticInstall(
    installed: Map<string, string>,
    searchResults: NuGetSearchResult[],
    packageId: string,
    version: string,
): OptimisticSnapshot {
    const previousVersion = installed.get(packageId);
    installed.set(packageId, version);
    const pkg = searchResults.find((p) => p.id === packageId);
    if (pkg !== undefined) {
        pkg.isInstalled = true;
        pkg.installedVersion = version;
    }
    return { previousVersion, mutatedSearchResult: pkg };
}

/** Revert an optimistic install using the snapshot returned earlier. */
export function revertOptimisticInstall(
    installed: Map<string, string>,
    packageId: string,
    snapshot: OptimisticSnapshot,
): void {
    if (snapshot.previousVersion === undefined) {
        installed.delete(packageId);
        if (snapshot.mutatedSearchResult !== undefined) {
            snapshot.mutatedSearchResult.isInstalled = false;
            snapshot.mutatedSearchResult.installedVersion = undefined;
        }
    } else {
        installed.set(packageId, snapshot.previousVersion);
    }
}

/** Apply an optimistic uninstall and return a snapshot for revert. */
export function applyOptimisticUninstall(
    installed: Map<string, string>,
    searchResults: NuGetSearchResult[],
    packageId: string,
): OptimisticSnapshot {
    const previousVersion = installed.get(packageId);
    installed.delete(packageId);
    const pkg = searchResults.find((p) => p.id === packageId);
    if (pkg !== undefined) {
        pkg.isInstalled = false;
        pkg.installedVersion = undefined;
    }
    return { previousVersion, mutatedSearchResult: pkg };
}

/** Revert an optimistic uninstall using the snapshot returned earlier. */
export function revertOptimisticUninstall(
    installed: Map<string, string>,
    packageId: string,
    snapshot: OptimisticSnapshot,
): void {
    if (snapshot.previousVersion !== undefined) {
        installed.set(packageId, snapshot.previousVersion);
        if (snapshot.mutatedSearchResult !== undefined) {
            snapshot.mutatedSearchResult.isInstalled = true;
            snapshot.mutatedSearchResult.installedVersion = snapshot.previousVersion;
        }
    }
}

/** Build the toast text for an optimistic install. */
export function buildInstallToast(
    target: NuGetTarget,
    packageId: string,
    version: string,
): string {
    return `Installing ${packageId} ${version} into ${target.displayName}…`;
}

export function buildUninstallToast(
    target: NuGetTarget,
    packageId: string,
): string {
    return `Removing ${packageId} from ${target.displayName}…`;
}

/**
 * Fetch full metadata for a synthesized package via a targeted exact-match
 * search. Mutates the package in place so the panel's `selectedPackage`
 * reference picks up the new fields.
 */
export async function enrichPackageMetadata(
    lsp: LanguageClient,
    target: NuGetTarget,
    pkg: NuGetSearchResult,
): Promise<void> {
    const result = await searchPackages(lsp, target, `packageid:${pkg.id}`, 1);
    if (!result.ok) return;
    const match = result.value.packages.find((p) => p.id === pkg.id);
    if (match === undefined) return;
    Object.assign(pkg, {
        description: match.description,
        authors: match.authors,
        iconUrl: match.iconUrl,
        licenseUrl: match.licenseUrl,
        projectUrl: match.projectUrl,
        published: match.published,
        downloadCount: match.downloadCount,
        tags: match.tags,
        version: match.version,
    });
}

/** Find or synthesize a package by id. Used by `selectPackage`. */
export function findOrSynthesizePackage(
    searchResults: NuGetSearchResult[],
    installed: Map<string, string>,
    packageId: string,
): NuGetSearchResult | undefined {
    const existing = searchResults.find((p) => p.id === packageId);
    if (existing !== undefined) return existing;
    const installedVersion = installed.get(packageId);
    if (installedVersion === undefined) return undefined;
    return {
        id: packageId,
        version: installedVersion,
        description: "",
        authors: "",
        tags: [],
        isInstalled: true,
        installedVersion,
    };
}
