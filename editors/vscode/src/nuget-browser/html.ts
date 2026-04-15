import { buildCss } from './css.js';
import {
  installKey,
  type LoadingKey,
  type NuGetSearchResult,
  type NuGetTarget,
  uninstallKey,
} from './types.js';

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function escAttr(text: string): string {
  return text.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function spinner(): string {
  return `<span class="material-symbols-outlined spin">progress_activity</span>`;
}

/**
 * Single source of truth for the <img> overlay used in every package icon
 * box (list rows AND details-panel header). Hides itself on load error so
 * the material-symbol glyph underneath remains visible as fallback.
 */
function packageIconImg(pkg: NuGetSearchResult): string {
  if (pkg.iconUrl === undefined || pkg.iconUrl.length === 0) return '';
  return `<img class="package-icon-img" src="${escAttr(pkg.iconUrl)}" alt="" onerror="this.style.display='none'" />`;
}

export interface ToastState {
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface RenderState {
  projectName: string;
  currentTab: 'browse' | 'installed';
  currentSearchQuery: string;
  targets: NuGetTarget[];
  selectedTargetId: string | undefined;
  targetsLoading: boolean;
  searchResults: NuGetSearchResult[];
  installedPackages: Map<string, string>;
  installedMetadata: Map<string, NuGetSearchResult>;
  selectedPackage: NuGetSearchResult | undefined;
  loading: Set<LoadingKey>;
  toast: ToastState | undefined;
}

export function buildHtml(state: RenderState): string {
  const safeProjectName = esc(state.projectName);
  const safeQuery = escAttr(state.currentSearchQuery);

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; img-src https: data:;">
<title>NuGet - ${safeProjectName}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
${buildCss()}
</head>
<body>
<main class="main">
${buildHeader(state, safeQuery)}
<div class="content">
<section class="package-list">
${buildPackageListHtml(state)}
</section>
<aside class="details-panel">
${buildDetailsHtml(state)}
</aside>
</div>
</main>
${buildToast(state.toast)}
<script>
const vscode = acquireVsCodeApi();
let _searchDebounce;
function doSearch() {
  const q = document.getElementById('searchInput')?.value ?? '';
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => vscode.postMessage({ command: 'search', data: { query: q } }), 250);
}
function switchTab(tab) { vscode.postMessage({ command: 'switchTab', data: { tab } }); }
function selectPackage(id) { vscode.postMessage({ command: 'selectPackage', data: { packageId: id } }); }
function installPackage(id, v) { vscode.postMessage({ command: 'install', data: { packageId: id, version: v } }); }
function uninstallPackage(id) { vscode.postMessage({ command: 'uninstall', data: { packageId: id } }); }
function changeVersion(id, v) { vscode.postMessage({ command: 'changeVersion', data: { packageId: id, version: v } }); }
function changeTarget(id) { vscode.postMessage({ command: 'changeTarget', data: { targetId: id } }); }
function openExternal(url) { vscode.postMessage({ command: 'openExternal', data: { url } }); }
function refresh() { vscode.postMessage({ command: 'refresh' }); }
</script>
</body>
</html>`;
}

function buildHeader(state: RenderState, safeQuery: string): string {
  const tabs = `
<nav class="nav-tabs">
<a class="nav-tab ${state.currentTab === 'browse' ? 'active' : ''}" onclick="switchTab('browse')">Browse</a>
<a class="nav-tab ${state.currentTab === 'installed' ? 'active' : ''}" onclick="switchTab('installed')">Installed</a>
</nav>`;

  const targetDropdown = buildTargetDropdown(state);

  const searchSpinner = state.loading.has('search') ? spinner() : '';
  const searchBox =
    state.currentTab === 'browse'
      ? `<div class="search-box"><span class="material-symbols-outlined search-icon">search</span><input type="text" id="searchInput" placeholder="Search packages..." value="${safeQuery}" oninput="doSearch()" onkeydown="if(event.key==='Enter')doSearch()"><span class="search-spinner">${searchSpinner}</span></div>`
      : '';

  return `<header class="header">
<div class="header-left">
<span class="logo">NuGet</span>
${tabs}
${targetDropdown}
</div>
<div class="header-right">
${searchBox}
<button class="icon-btn" onclick="refresh()" title="Refresh"><span class="material-symbols-outlined">sync</span></button>
</div>
</header>`;
}

function buildTargetDropdown(state: RenderState): string {
  const projectGroup = state.targets.filter((t) => t.kind === 'project');
  const propsGroup = state.targets.filter((t) => t.kind === 'buildProps');
  const disabled = state.targetsLoading || state.targets.length === 0;
  const loadingSpinner = state.targetsLoading
    ? `<span class="target-spinner">${spinner()}</span>`
    : '';

  const renderOptions = (targets: NuGetTarget[]): string =>
    targets
      .map(
        (t) =>
          `<option value="${escAttr(t.id)}" ${t.id === state.selectedTargetId ? 'selected' : ''}>${esc(t.displayName)}</option>`,
      )
      .join('');

  const groups: string[] = [];
  if (projectGroup.length > 0) {
    groups.push(`<optgroup label="Projects">${renderOptions(projectGroup)}</optgroup>`);
  }
  if (propsGroup.length > 0) {
    groups.push(`<optgroup label="Build Props">${renderOptions(propsGroup)}</optgroup>`);
  }
  if (groups.length === 0) {
    groups.push(
      `<option value="">${state.targetsLoading ? 'Loading targets…' : 'No targets found'}</option>`,
    );
  }

  return `<div class="target-dropdown" title="Select install target">
<span class="material-symbols-outlined target-icon">account_tree</span>
<select onchange="changeTarget(this.value)" ${disabled ? 'disabled' : ''}>
${groups.join('\n')}
</select>
${loadingSpinner}
<span class="material-symbols-outlined target-chevron">expand_more</span>
</div>`;
}

function buildToast(toast: ToastState | undefined): string {
  if (toast === undefined) return '';
  const icon =
    toast.kind === 'error'
      ? 'error'
      : toast.kind === 'success'
        ? 'check_circle'
        : 'progress_activity';
  const spinClass = toast.kind === 'info' ? ' spin' : '';
  return `<div class="toast ${toast.kind}"><span class="material-symbols-outlined toast-icon${spinClass}">${icon}</span><span class="toast-text">${esc(toast.text)}</span></div>`;
}

function buildPackageListHtml(state: RenderState): string {
  if (state.currentTab === 'installed') {
    return buildInstalledListHtml(state);
  }
  return buildBrowseListHtml(state);
}

function buildInstalledListHtml(state: RenderState): string {
  const installedRows = Array.from(state.installedPackages.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, version]) => hydrateInstalledRow(state, id, version));

  const loadingRow = state.loading.has('installed')
    ? `<div class="inline-loading-row">${spinner()}<span>Loading installed packages…</span></div>`
    : '';

  if (installedRows.length === 0) {
    return `<div class="list-header"><span class="list-title">Installed Packages</span></div>${loadingRow}<div class="empty-state"><span class="material-symbols-outlined empty-icon">package_2</span><div class="empty-title">No packages installed</div><p>This target has no NuGet packages installed.</p></div>`;
  }

  const items = installedRows.map((pkg) => buildPackageItem(state, pkg)).join('');
  return `<div class="list-header"><span class="list-title">Installed Packages</span></div>${loadingRow}${items}`;
}

/**
 * Build a NuGetSearchResult for an installed package, pulling any enriched
 * metadata (icon, description, authors) from the current searchResults if
 * we've seen it. This keeps the installed list visually identical to browse.
 */
function hydrateInstalledRow(
  state: RenderState,
  id: string,
  resolvedVersion: string,
): NuGetSearchResult {
  const fromMetadata = state.installedMetadata.get(id);
  if (fromMetadata !== undefined) {
    return { ...fromMetadata, isInstalled: true, installedVersion: resolvedVersion };
  }
  const fromSearch = state.searchResults.find((r) => r.id === id);
  if (fromSearch !== undefined) {
    return { ...fromSearch, isInstalled: true, installedVersion: resolvedVersion };
  }
  return {
    id,
    version: resolvedVersion,
    description: 'Installed package',
    authors: '',
    tags: [],
    isInstalled: true,
    installedVersion: resolvedVersion,
  };
}

function buildBrowseListHtml(state: RenderState): string {
  if (state.searchResults.length === 0 && state.loading.has('search')) {
    return `<div class="list-header"><span class="list-title">Available Packages</span></div>${skeletonList()}`;
  }
  if (state.searchResults.length === 0) {
    return `<div class="list-header"><span class="list-title">Available Packages</span></div><div class="empty-state"><span class="material-symbols-outlined empty-icon">package_2</span><div class="empty-title">No packages found</div><p>Try a different search term.</p></div>`;
  }
  const items = state.searchResults.map((pkg) => buildPackageItem(state, pkg)).join('');
  return `<div class="list-header"><span class="list-title">Available Packages</span></div>${items}`;
}

function buildPackageItem(state: RenderState, pkg: NuGetSearchResult): string {
  const sel = state.selectedPackage?.id === pkg.id;
  const safeId = esc(pkg.id);
  const desc = pkg.description.length > 0 ? pkg.description : 'No description available';
  // Derive `installed` + version from the live installedPackages signal,
  // not the snapshot — keeps every row in sync with on-disk csproj edits.
  const installedVersion = state.installedPackages.get(pkg.id);
  const installed = installedVersion !== undefined;
  const version = installedVersion ?? pkg.installedVersion ?? pkg.version;
  const pending = state.loading.has(installKey(pkg.id)) || state.loading.has(uninstallKey(pkg.id));
  const dl = pkg.downloadCount !== undefined ? formatDownloads(pkg.downloadCount) : null;
  const icon = installed ? 'database' : 'package_2';
  return `<div class="package-item ${sel ? 'selected' : ''} ${pending ? 'pending' : ''}" onclick="selectPackage('${escAttr(pkg.id)}')">
<div class="package-icon-box ${sel ? 'selected' : ''}"><span class="material-symbols-outlined ${sel ? 'icon-selected' : ''}">${icon}</span>${packageIconImg(pkg)}</div>
<div class="package-content">
<div class="package-header"><span class="package-name">${safeId}</span><span class="package-version ${installed ? 'installed' : ''} ${pending ? 'pending' : ''}">v${esc(version)}</span></div>
<p class="package-description">${esc(desc)}</p>
<div class="package-meta">
${dl !== null ? `<span class="meta-item"><span class="material-symbols-outlined meta-icon">download</span>${dl}</span>` : ''}
${pkg.authors.length > 0 ? `<span class="meta-item"><span class="material-symbols-outlined meta-icon">person</span>${esc(pkg.authors)}</span>` : ''}
</div>
</div>
</div>`;
}

function skeletonList(): string {
  const row = `<div class="skeleton"><div class="skeleton-icon"></div><div class="skeleton-lines"><div class="skeleton-line med"></div><div class="skeleton-line long"></div><div class="skeleton-line short"></div></div></div>`;
  return row.repeat(6);
}

function buildDetailsHtml(state: RenderState): string {
  const pkg = state.selectedPackage;
  if (pkg === undefined) {
    return `<div class="details-empty"><span class="material-symbols-outlined empty-icon">package_2</span><p>Select a package to view details</p></div>`;
  }

  // Derive `installed` from the live installedPackages signal at render
  // time — never trust the selectedPackage snapshot's isInstalled flag,
  // which is stale the moment the user (or another tool) edits the csproj.
  const installed = state.installedPackages.has(pkg.id);
  const versions = (pkg._versions ?? []).slice(0, 20);
  const safeId = esc(pkg.id);
  const safeAuthors = esc(pkg.authors.length > 0 ? pkg.authors : 'Unknown author');
  const safeDesc = esc(pkg.description.length > 0 ? pkg.description : 'No description available');

  const installPending = state.loading.has(installKey(pkg.id));
  const uninstallPending = state.loading.has(uninstallKey(pkg.id));
  const versionsPending = state.loading.has('versions');

  const tagsHtml =
    pkg.tags.length > 0
      ? `<div class="section"><h4 class="section-title">Tags</h4><div class="tags">${pkg.tags.map((t) => `<span class="tag">${esc(t.toUpperCase())}</span>`).join('')}</div></div>`
      : '';

  const versionOptions = versions
    .map(
      (v) =>
        `<option value="${escAttr(v)}" ${v === pkg.installedVersion ? 'selected' : ''}>${esc(v)}</option>`,
    )
    .join('');

  let infoRows = '';
  if (pkg.licenseUrl !== undefined && pkg.licenseUrl.length > 0) {
    infoRows += `<div class="info-row"><span class="info-label">License</span><a class="info-link" href="#" onclick="openExternal('${escAttr(pkg.licenseUrl)}')">View License <span class="material-symbols-outlined" style="font-size: 0.8rem;">open_in_new</span></a></div>`;
  }
  if (pkg.published !== undefined && pkg.published.length > 0) {
    infoRows += `<div class="info-row"><span class="info-label">Published</span><span class="info-value">${formatDate(pkg.published)}</span></div>`;
  }
  if (pkg.projectUrl !== undefined && pkg.projectUrl.length > 0) {
    infoRows += `<div class="info-row"><span class="info-label">Project URL</span><a class="info-link" href="#" onclick="openExternal('${escAttr(pkg.projectUrl)}')">${esc(pkg.projectUrl)} <span class="material-symbols-outlined" style="font-size: 0.8rem;">link</span></a></div>`;
  }
  if (pkg.downloadCount !== undefined && pkg.downloadCount > 0) {
    infoRows += `<div class="info-row"><span class="info-label">Downloads</span><span class="info-value">${formatDownloads(pkg.downloadCount)}</span></div>`;
  }

  const installBtn = installed
    ? `<button class="btn btn-danger" ${uninstallPending ? 'disabled' : ''} onclick="uninstallPackage('${escAttr(pkg.id)}')">${uninstallPending ? `${spinner()} Removing…` : `<span class="material-symbols-outlined btn-icon">delete</span> Remove`}</button>`
    : `<button class="btn btn-primary" ${installPending ? 'disabled' : ''} onclick="installPackage('${escAttr(pkg.id)}', '${escAttr(pkg.version)}')">${installPending ? `${spinner()} Installing…` : `<span class="material-symbols-outlined btn-icon">download</span> Install`}</button>`;

  return `<div class="details-header">
<div class="details-icon-box"><span class="material-symbols-outlined details-icon-glyph" style="font-variation-settings: 'FILL' 1;">database</span>${packageIconImg(pkg)}</div>
<div class="details-title"><h2>${safeId}</h2><p>${safeAuthors}</p></div>
</div>
<div class="details-actions">
${installBtn}
<div class="version-select"><select onchange="changeVersion('${escAttr(pkg.id)}', this.value)" ${!installed || versionsPending ? 'disabled' : ''}>${versionOptions}</select><span class="material-symbols-outlined version-chevron">${versionsPending ? 'progress_activity' : 'expand_more'}</span></div>
</div>
<div class="section"><h4 class="section-title">Description</h4><p class="section-content">${safeDesc}</p></div>
<div class="section"><div class="info-grid">${infoRows}</div></div>
${tagsHtml}`;
}

function formatDownloads(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B Downloads`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M Downloads`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K Downloads`;
  return `${count.toString()} Downloads`;
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days < 1) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30) return `${days.toString()} days ago`;
    if (days < 365) return `${Math.floor(days / 30).toString()} months ago`;
    return `${Math.floor(days / 365).toString()} years ago`;
  } catch {
    return dateStr;
  }
}
