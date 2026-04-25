// ── Types shared across the NuGet browser module ──────────────

export interface NuGetSearchResult {
  id: string;
  version: string;
  description: string;
  authors: string;
  iconUrl?: string;
  licenseUrl?: string;
  projectUrl?: string;
  published?: string;
  downloadCount?: number;
  tags: string[];
  isInstalled?: boolean;
  installedVersion?: string | undefined;
  _versions?: string[];
}

export interface NuGetSearchResponse {
  readonly packages: NuGetSearchResult[];
  readonly totalHits: number;
}

export interface NuGetVersionsResponse {
  readonly versions: string[];
}

export interface InstalledPackage {
  readonly id: string;
  readonly requestedVersion: string;
  readonly resolvedVersion: string;
}

export interface NuGetInstalledResponse {
  readonly packages: InstalledPackage[];
}

export interface NuGetMutationResponse {
  readonly success: boolean;
  readonly message: string;
  readonly modifiedFiles?: string[];
}

export type TargetKind = 'project' | 'buildProps';
export type TargetLanguage = 'csharp' | 'fsharp';

export interface NuGetTarget {
  id: string;
  kind: TargetKind;
  displayName: string;
  path: string;
  language?: TargetLanguage;
  framework?: string[];
}

export interface NuGetTargetsResponse {
  readonly targets: NuGetTarget[];
  readonly defaultTargetId: string | null;
  readonly cpmEnabled: boolean;
  readonly cpmFile?: string;
}

export type RestorePhase = 'started' | 'restoring' | 'succeeded' | 'failed';

export interface RestoreProgressParams {
  readonly targetId: string;
  readonly phase: RestorePhase;
  readonly message?: string;
}

export interface WebviewMessage {
  command: string;
  data?: Record<string, unknown>;
}

export type LoadingKey =
  | 'targets'
  | 'installed'
  | 'search'
  | 'versions'
  | `install:${string}`
  | `uninstall:${string}`
  | `restore:${string}`;

export function installKey(packageId: string): LoadingKey {
  return `install:${packageId}`;
}

export function uninstallKey(packageId: string): LoadingKey {
  return `uninstall:${packageId}`;
}

export function restoreKey(targetId: string): LoadingKey {
  return `restore:${targetId}`;
}
