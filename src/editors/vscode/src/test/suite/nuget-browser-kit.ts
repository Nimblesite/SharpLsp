// Fixtures for the NuGet browser suites: the fake ExtensionContext, the
// singleton-reset + open dance, and the one-package responses every panel test
// drives the LSP fake with.
//
// `NuGetBrowserPanel` is a singleton, so every test that opens a second panel
// must first dispose the previous one through `open()` itself — the same three
// lines each time, and easy to get subtly wrong (leaking a stale getClient).
// One helper owns that dance; the installed/search fixtures below give each
// test a named, typed response shape instead of an inline object literal.
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { NuGetBrowserPanel } from '../../nuget-browser.js';
import { type NuGetInstalledResponse, type NuGetSearchResult } from '../../nuget-browser/types.js';

/** A workspace-state-backed `ExtensionContext` with an in-memory store. */
export function fakeContextWithStore(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const workspaceState = {
    get: (key: string): unknown => store.get(key),
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => Array.from(store.keys()),
  };
  return { subscriptions: [], workspaceState } as unknown as vscode.ExtensionContext;
}

/** A virtual project path that does NOT exist on disk, so the panel's on-disk csproj sync short-circuits to `false` and the LSP path runs. */
export const VIRTUAL_PROJECT = '/virtual/nonexistent/Fake.csproj';

/** Disposes the current panel singleton so the next `open()` builds a fresh one. */
export function resetPanelSingleton(): void {
  NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
}

/** Resets the panel singleton, then opens a fresh panel backed by `getClient`. */
export function openFreshPanel(
  projectPath: string,
  name: string,
  getClient: () => LanguageClient | undefined,
): NuGetBrowserPanel {
  resetPanelSingleton();
  return NuGetBrowserPanel.open(fakeContextWithStore(), projectPath, name, getClient);
}

/** An installed list whose only entry is `id` pinned at `version`. */
export function installedSingle(id: string, version = '1.0.0'): NuGetInstalledResponse {
  return { packages: [{ id, requestedVersion: version, resolvedVersion: version }] };
}

/** An installed list with no packages. */
export function installedNone(): NuGetInstalledResponse {
  return { packages: [] };
}

/** A search result stripped to the bare metadata fields, under `id`. */
export function barePackage(id = 'X'): NuGetSearchResult {
  return { id, version: '1', description: '', authors: '', tags: [] };
}

/** The fake client's recorded `updatePreview` requests, in order. */
export function previewCalls(client: {
  readonly calls: readonly { readonly method: string; readonly payload: unknown }[];
}): { readonly method: string; readonly payload: unknown }[] {
  return client.calls.filter((call) => call.method.endsWith('updatePreview'));
}

/** A scratch csproj with Newtonsoft.Json 13.0.3 pinned. */
export const JSON_PROJECT_XML = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`;

/** A scratch csproj with no package references at all. */
export const EMPTY_PROJECT_XML = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup></ItemGroup>
</Project>`;
