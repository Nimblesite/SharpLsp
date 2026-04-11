import * as vscode from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
import * as log from "./log.js";
import { getErrorMessage } from "./utils.js";

// ── LSP Response Types ──────────────────────────────────────────

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

interface NuGetSearchResponse {
    readonly packages: NuGetSearchResult[];
    readonly totalHits: number;
}

interface NuGetVersionsResponse {
    readonly versions: string[];
}

interface InstalledPackage {
    readonly id: string;
    readonly requestedVersion: string;
    readonly resolvedVersion: string;
}

interface NuGetInstalledResponse {
    readonly packages: InstalledPackage[];
}

interface NuGetMutationResponse {
    readonly success: boolean;
    readonly message: string;
}

export interface WebviewMessage {
    command: string;
    data?: Record<string, unknown>;
}

// ── Panel ───────────────────────────────────────────────────────

export class NuGetBrowserPanel {
    private static instance: NuGetBrowserPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private readonly projectPath: string;
    private readonly projectName: string;
    private readonly getClient: () => LanguageClient | undefined;
    private readonly installedPackages = new Map<string, string>();
    private currentSearchQuery = "";
    private currentTab: "browse" | "installed" = "browse";
    private searchResults: NuGetSearchResult[] = [];
    private selectedPackage: NuGetSearchResult | undefined;
    /** Resolves when the constructor's async initial load completes. */
    private readonly initialLoadDone: Promise<void>;

    private constructor(
        context: vscode.ExtensionContext,
        projectPath: string,
        projectName: string,
        getClient: () => LanguageClient | undefined,
    ) {
        this.context = context;
        this.projectPath = projectPath;
        this.projectName = projectName;
        this.getClient = getClient;

        log.info(`NuGetBrowserPanel: creating panel for ${projectName}`);
        this.panel = vscode.window.createWebviewPanel(
            "nugetBrowser",
            `NuGet: ${projectName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [],
            },
        );

        this.panel.onDidDispose(
            () => {
                log.info("NuGetBrowserPanel: panel disposed");
                NuGetBrowserPanel.instance = undefined;
            },
            null,
            this.context.subscriptions,
        );

        this.panel.webview.onDidReceiveMessage(
            (message: WebviewMessage) => {
                void this.handleMessage(message);
            },
            null,
            this.context.subscriptions,
        );

        this.initialLoadDone = this.initialLoad();
    }

    private async initialLoad(): Promise<void> {
        await this.loadInstalledPackages();
        log.info(
            "NuGetBrowserPanel: installed loaded, fetching popular packages",
        );
        // Populate the Browse tab with popular packages so it's not empty.
        await this.performSearch("");
        log.info("NuGetBrowserPanel: initial load complete");
    }

    // ── Test helpers ────────────────────────────────────────────
    // These accessors exist so e2e tests can observe internal state
    // after opening the panel without resorting to webview DOM scraping.

    /** Resolves when the initial load (installed + popular) has completed. */
    public async waitForInitialLoad(): Promise<void> {
        await this.initialLoadDone;
    }

    public getSearchResultsCount(): number {
        return this.searchResults.length;
    }

    public getInstalledPackageIds(): string[] {
        return Array.from(this.installedPackages.keys());
    }

    public getSelectedPackageId(): string | undefined {
        return this.selectedPackage?.id;
    }

    public getCurrentTab(): "browse" | "installed" {
        return this.currentTab;
    }

    /** Return the HTML currently set on the webview (for assertions). */
    public getRenderedHtml(): string {
        return this.panel.webview.html;
    }

    /** Simulate a webview message for testing. */
    public async simulateWebviewMessage(
        message: WebviewMessage,
    ): Promise<void> {
        await this.handleMessage(message);
    }

    public static open(
        context: vscode.ExtensionContext,
        projectPath: string,
        projectName: string,
        getClient: () => LanguageClient | undefined,
    ): NuGetBrowserPanel {
        if (NuGetBrowserPanel.instance !== undefined) {
            log.info("NuGetBrowserPanel: reusing existing panel, revealing");
            NuGetBrowserPanel.instance.panel.reveal(vscode.ViewColumn.One);
            return NuGetBrowserPanel.instance;
        }
        log.info(`NuGetBrowserPanel: creating new instance for ${projectName}`);
        NuGetBrowserPanel.instance = new NuGetBrowserPanel(
            context,
            projectPath,
            projectName,
            getClient,
        );
        return NuGetBrowserPanel.instance;
    }

    public dispose(): void {
        this.panel.dispose();
    }

    // ── Message handling ────────────────────────────────────────

    private async handleMessage(message: WebviewMessage): Promise<void> {
        log.info(
            `NuGetBrowserPanel: received message command=${message.command}`,
        );
        switch (message.command) {
            case "search": {
                const query = this.str(message.data?.query);
                this.currentSearchQuery = query;
                await this.performSearch(query);
                break;
            }
            case "selectPackage": {
                const packageId = this.str(message.data?.packageId);
                const pkg = this.findOrSynthesizePackage(packageId);
                if (pkg !== undefined) {
                    this.selectedPackage = pkg;
                    // Render the skeleton immediately so the panel feels snappy.
                    this.updateContent();
                    // Enrich installed-only packages with real metadata.
                    if (pkg.description.length === 0) {
                        await this.enrichPackageMetadata(pkg);
                    }
                    await this.loadPackageVersions(pkg);
                    this.updateContent();
                }
                break;
            }
            case "install": {
                const packageId = this.str(message.data?.packageId);
                const version = this.str(message.data?.version);
                await this.installPackage(packageId, version);
                break;
            }
            case "uninstall": {
                const packageId = this.str(message.data?.packageId);
                await this.uninstallPackage(packageId);
                break;
            }
            case "changeVersion": {
                const packageId = this.str(message.data?.packageId);
                const version = this.str(message.data?.version);
                await this.changeVersion(packageId, version);
                break;
            }
            case "switchTab": {
                const tabValue = this.str(message.data?.tab, "browse");
                const tab: "browse" | "installed" =
                    tabValue === "installed" ? "installed" : "browse";
                this.currentTab = tab;
                if (tab === "installed") {
                    await this.loadInstalledPackages();
                }
                this.updateContent();
                break;
            }
            case "openExternal": {
                const url = this.str(message.data?.url);
                if (url.length > 0) {
                    void vscode.env.openExternal(vscode.Uri.parse(url));
                }
                break;
            }
        }
    }

    private str(value: unknown, defaultValue = ""): string {
        if (typeof value === "string") return value;
        return defaultValue;
    }

    /**
     * Find a package by id across all known sources.
     *
     * On the Browse tab packages come from `searchResults`. On the Installed
     * tab they come from `installedPackages` (a simple Map) — those items
     * aren't in `searchResults` until the user searches, so we synthesize a
     * minimal `NuGetSearchResult` on demand so selection still works.
     */
    private findOrSynthesizePackage(
        packageId: string,
    ): NuGetSearchResult | undefined {
        const existing = this.searchResults.find((p) => p.id === packageId);
        if (existing !== undefined) return existing;

        const installedVersion = this.installedPackages.get(packageId);
        if (installedVersion === undefined) return undefined;

        // Synthesize a minimal record for installed-only packages. Versions
        // will be fetched lazily by loadPackageVersions() on selection.
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

    // ── LSP operations ──────────────────────────────────────────

    private async loadInstalledPackages(): Promise<void> {
        log.info(`NuGetBrowserPanel: loading installed packages via LSP`);
        const lsp = this.getClient();
        if (lsp === undefined) {
            log.error("NuGetBrowserPanel: no LSP client available");
            return;
        }
        try {
            const result = await lsp.sendRequest<NuGetInstalledResponse>(
                "forge/nuget/installed",
                { projectPath: this.projectPath },
            );
            this.installedPackages.clear();
            for (const pkg of result.packages) {
                this.installedPackages.set(pkg.id, pkg.resolvedVersion);
            }
            log.info(
                `NuGetBrowserPanel: loaded ${this.installedPackages.size.toString()} installed packages`,
            );
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(
                `NuGetBrowserPanel: failed to load installed packages: ${msg}`,
            );
        }
    }

    private async performSearch(query: string): Promise<void> {
        const displayQuery = query.length > 0 ? query : "(popular)";
        log.info(`NuGetBrowserPanel: searching query="${displayQuery}"`);
        const lsp = this.getClient();
        if (lsp === undefined) {
            log.error("NuGetBrowserPanel: no LSP client available");
            return;
        }
        try {
            const result = await lsp.sendRequest<NuGetSearchResponse>(
                "forge/nuget/search",
                {
                    query,
                    projectPath: this.projectPath,
                    prerelease: false,
                    take: 50,
                    skip: 0,
                },
            );
            this.searchResults = result.packages;
            log.info(
                `NuGetBrowserPanel: search returned ${this.searchResults.length.toString()} results`,
            );
            this.updateContent();
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(`NuGetBrowserPanel: search failed: ${msg}`);
        }
    }

    /**
     * Fetch full metadata for a package that was synthesized from the
     * installed list. Uses an exact-match search and copies description,
     * authors, icon, license, etc. into the target package object.
     */
    private async enrichPackageMetadata(pkg: NuGetSearchResult): Promise<void> {
        const lsp = this.getClient();
        if (lsp === undefined) return;
        try {
            const result = await lsp.sendRequest<NuGetSearchResponse>(
                "forge/nuget/search",
                {
                    query: `packageid:${pkg.id}`,
                    projectPath: this.projectPath,
                    prerelease: false,
                    take: 1,
                    skip: 0,
                },
            );
            const match = result.packages.find((p) => p.id === pkg.id);
            if (match === undefined) {
                log.info(`NuGetBrowserPanel: no metadata for ${pkg.id}`);
                return;
            }
            // Mutate the package in place so the selected reference still
            // points to the enriched object.
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
            log.info(`NuGetBrowserPanel: enriched metadata for ${pkg.id}`);
        } catch (err: unknown) {
            log.error(
                `NuGetBrowserPanel: failed to enrich ${pkg.id}: ${getErrorMessage(err)}`,
            );
        }
    }

    private async loadPackageVersions(pkg: NuGetSearchResult): Promise<void> {
        log.info(`NuGetBrowserPanel: loading versions for ${pkg.id}`);
        const lsp = this.getClient();
        if (lsp === undefined) return;
        try {
            const result = await lsp.sendRequest<NuGetVersionsResponse>(
                "forge/nuget/versions",
                { packageId: pkg.id },
            );
            pkg._versions = result.versions;
            log.info(
                `NuGetBrowserPanel: loaded ${pkg._versions.length.toString()} versions for ${pkg.id}`,
            );
        } catch (err: unknown) {
            log.error(
                `NuGetBrowserPanel: failed to load versions for ${pkg.id}: ${getErrorMessage(err)}`,
            );
        }
    }

    private async installPackage(
        packageId: string,
        version: string,
    ): Promise<void> {
        const lsp = this.getClient();
        if (lsp === undefined) return;
        try {
            log.info(`NuGetBrowserPanel: installing ${packageId} v${version}`);
            const result = await lsp.sendRequest<NuGetMutationResponse>(
                "forge/nuget/install",
                {
                    projectPath: this.projectPath,
                    packageId,
                    version,
                },
            );
            if (result.success) {
                void vscode.window.showInformationMessage(
                    `Installed ${packageId} v${version}`,
                );
                this.installedPackages.set(packageId, version);
                await this.loadInstalledPackages();
                await this.performSearch(this.currentSearchQuery);
            } else {
                void vscode.window.showErrorMessage(
                    `Failed to install: ${result.message}`,
                );
            }
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(
                `NuGetBrowserPanel: failed to install ${packageId}: ${msg}`,
            );
            void vscode.window.showErrorMessage(`Failed to install: ${msg}`);
        }
    }

    private async uninstallPackage(packageId: string): Promise<void> {
        const lsp = this.getClient();
        if (lsp === undefined) return;
        try {
            log.info(`NuGetBrowserPanel: removing ${packageId}`);
            const result = await lsp.sendRequest<NuGetMutationResponse>(
                "forge/nuget/uninstall",
                {
                    projectPath: this.projectPath,
                    packageId,
                },
            );
            if (result.success) {
                void vscode.window.showInformationMessage(
                    `Removed ${packageId}`,
                );
                this.installedPackages.delete(packageId);
                await this.loadInstalledPackages();
                await this.performSearch(this.currentSearchQuery);
            } else {
                void vscode.window.showErrorMessage(
                    `Failed to remove: ${result.message}`,
                );
            }
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(
                `NuGetBrowserPanel: failed to remove ${packageId}: ${msg}`,
            );
            void vscode.window.showErrorMessage(`Failed to remove: ${msg}`);
        }
    }

    private async changeVersion(
        packageId: string,
        version: string,
    ): Promise<void> {
        const lsp = this.getClient();
        if (lsp === undefined) return;
        try {
            log.info(`NuGetBrowserPanel: changing ${packageId} to v${version}`);
            const result = await lsp.sendRequest<NuGetMutationResponse>(
                "forge/nuget/install",
                {
                    projectPath: this.projectPath,
                    packageId,
                    version,
                },
            );
            if (result.success) {
                void vscode.window.showInformationMessage(
                    `Updated ${packageId} to v${version}`,
                );
                this.installedPackages.set(packageId, version);
                await this.loadInstalledPackages();
                await this.performSearch(this.currentSearchQuery);
            } else {
                void vscode.window.showErrorMessage(
                    `Failed to update: ${result.message}`,
                );
            }
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(
                `NuGetBrowserPanel: failed to change ${packageId} version: ${msg}`,
            );
            void vscode.window.showErrorMessage(`Failed to update: ${msg}`);
        }
    }

    // ── Rendering ───────────────────────────────────────────────

    private updateContent(): void {
        log.info(
            `NuGetBrowserPanel: rendering tab=${this.currentTab} packages=${this.searchResults.length.toString()} installed=${this.installedPackages.size.toString()}`,
        );
        this.panel.webview.html = this.buildHtml();
    }

    private esc(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    private escAttr(text: string): string {
        return text.replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    private buildHtml(): string {
        const packages = this.searchResults;

        const installedList = Array.from(this.installedPackages.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, version]) => ({
                id,
                version,
                isInstalled: true as const,
                installedVersion: version,
            }));

        const safeProjectName = this.esc(this.projectName);
        const safeQuery = this.escAttr(this.currentSearchQuery);

        return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline';">
<title>NuGet Architect - ${safeProjectName}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
${this.buildCss()}
</head>
<body>
<main class="main">
${this.buildHeader(safeQuery)}
<div class="content">
<section class="package-list">
${this.buildPackageListHtml(packages, installedList)}
</section>
<aside class="details-panel">
${this.buildDetailsHtml()}
</aside>
</div>
</main>
<script>
const vscode = acquireVsCodeApi();
function doSearch() { const q = document.getElementById('searchInput')?.value ?? ''; vscode.postMessage({ command: 'search', data: { query: q } }); }
function switchTab(tab) { vscode.postMessage({ command: 'switchTab', data: { tab } }); }
function selectPackage(id) { vscode.postMessage({ command: 'selectPackage', data: { packageId: id } }); }
function installPackage(id, v) { vscode.postMessage({ command: 'install', data: { packageId: id, version: v } }); }
function uninstallPackage(id) { vscode.postMessage({ command: 'uninstall', data: { packageId: id } }); }
function changeVersion(id, v) { vscode.postMessage({ command: 'changeVersion', data: { packageId: id, version: v } }); }
function openExternal(url) { vscode.postMessage({ command: 'openExternal', data: { url } }); }
function refresh() { doSearch(); }
</script>
</body>
</html>`;
    }

    private buildHeader(safeQuery: string): string {
        return `<header class="header">
<div class="header-left">
<span class="logo">NuGet</span>
<nav class="nav-tabs">
<a class="nav-tab ${this.currentTab === "browse" ? "active" : ""}" onclick="switchTab('browse')">Browse</a>
<a class="nav-tab ${this.currentTab === "installed" ? "active" : ""}" onclick="switchTab('installed')">Installed</a>
</nav>
</div>
<div class="header-right">
${this.currentTab === "browse" ? `<div class="search-box"><span class="material-symbols-outlined search-icon">search</span><input type="text" id="searchInput" placeholder="Search packages..." value="${safeQuery}" onkeydown="if(event.key==='Enter')doSearch()"></div>` : ""}
<button class="icon-btn" onclick="refresh()" title="Refresh"><span class="material-symbols-outlined">sync</span></button>
</div>
</header>`;
    }

    private buildPackageListHtml(
        packages: NuGetSearchResult[],
        installedPackages: {
            id: string;
            version: string;
            isInstalled: true;
            installedVersion: string;
        }[],
    ): string {
        if (this.currentTab === "installed") {
            return this.buildInstalledListHtml(installedPackages);
        }
        return this.buildBrowseListHtml(packages);
    }

    private buildInstalledListHtml(
        installedPackages: {
            id: string;
            version: string;
            isInstalled: true;
            installedVersion: string;
        }[],
    ): string {
        if (installedPackages.length === 0) {
            return `<div class="empty-state"><span class="material-symbols-outlined empty-icon">package_2</span><div class="empty-title">No packages installed</div><p>This project has no NuGet packages installed.</p></div>`;
        }
        const items = installedPackages
            .map((pkg) => {
                const sel = this.selectedPackage?.id === pkg.id;
                const safeId = this.esc(pkg.id);
                const safeVer = this.esc(pkg.installedVersion);
                return `<div class="package-item ${sel ? "selected" : ""}" onclick="selectPackage('${this.escAttr(pkg.id)}')">
<div class="package-icon-box ${sel ? "selected" : ""}"><span class="material-symbols-outlined">package_2</span></div>
<div class="package-content">
<div class="package-header"><span class="package-name">${safeId}</span><span class="package-version installed">v${safeVer}</span></div>
<p class="package-description">Installed package</p>
</div>
</div>`;
            })
            .join("");
        return `<div class="list-header"><span class="list-title">Installed Packages</span></div>${items}`;
    }

    private buildBrowseListHtml(packages: NuGetSearchResult[]): string {
        if (packages.length === 0) {
            return `<div class="empty-state"><span class="material-symbols-outlined empty-icon">package_2</span><div class="empty-title">No packages found</div><p>Try a different search term.</p></div>`;
        }
        const items = packages
            .map((pkg) => {
                const sel = this.selectedPackage?.id === pkg.id;
                const safeId = this.esc(pkg.id);
                const desc =
                    pkg.description.length > 0
                        ? pkg.description
                        : "No description available";
                const version = pkg.installedVersion ?? pkg.version;
                const installed = pkg.isInstalled === true;
                const dl =
                    pkg.downloadCount !== undefined
                        ? this.fmtDl(pkg.downloadCount)
                        : null;
                const icon = installed ? "database" : "package_2";
                return `<div class="package-item ${sel ? "selected" : ""}" onclick="selectPackage('${this.escAttr(pkg.id)}')">
<div class="package-icon-box ${sel ? "selected" : ""}"><span class="material-symbols-outlined ${sel ? "icon-selected" : ""}">${icon}</span></div>
<div class="package-content">
<div class="package-header"><span class="package-name">${safeId}</span><span class="package-version ${installed ? "installed" : ""}">v${this.esc(version)}</span></div>
<p class="package-description">${this.esc(desc)}</p>
<div class="package-meta">
${dl !== null ? `<span class="meta-item"><span class="material-symbols-outlined meta-icon">download</span>${dl}</span>` : ""}
${pkg.authors.length > 0 ? `<span class="meta-item"><span class="material-symbols-outlined meta-icon">person</span>${this.esc(pkg.authors)}</span>` : ""}
</div>
</div>
</div>`;
            })
            .join("");
        return `<div class="list-header"><span class="list-title">Available Packages</span></div>${items}`;
    }

    private buildDetailsHtml(): string {
        if (this.selectedPackage === undefined) {
            return `<div class="details-empty"><span class="material-symbols-outlined empty-icon">package_2</span><p>Select a package to view details</p></div>`;
        }

        const pkg = this.selectedPackage;
        const installed = pkg.isInstalled === true;
        const versions = (pkg._versions ?? []).slice(0, 20);
        const safeId = this.esc(pkg.id);
        const safeAuthors = this.esc(pkg.authors || "Unknown author");
        const safeDesc = this.esc(
            pkg.description || "No description available",
        );

        let infoRows = "";
        if (pkg.licenseUrl !== undefined && pkg.licenseUrl.length > 0) {
            infoRows += `<div class="info-row"><span class="info-label">License</span><a class="info-link" href="#" onclick="openExternal('${this.escAttr(pkg.licenseUrl)}')">View License <span class="material-symbols-outlined" style="font-size: 0.8rem;">open_in_new</span></a></div>`;
        }
        if (pkg.published !== undefined && pkg.published.length > 0) {
            infoRows += `<div class="info-row"><span class="info-label">Published</span><span class="info-value">${this.fmtDate(pkg.published)}</span></div>`;
        }
        if (pkg.projectUrl !== undefined && pkg.projectUrl.length > 0) {
            infoRows += `<div class="info-row"><span class="info-label">Project URL</span><a class="info-link" href="#" onclick="openExternal('${this.escAttr(pkg.projectUrl)}')">${this.esc(pkg.projectUrl)} <span class="material-symbols-outlined" style="font-size: 0.8rem;">link</span></a></div>`;
        }
        if (pkg.downloadCount !== undefined && pkg.downloadCount > 0) {
            infoRows += `<div class="info-row"><span class="info-label">Downloads</span><span class="info-value">${this.fmtDl(pkg.downloadCount)}</span></div>`;
        }

        const tagsHtml =
            pkg.tags.length > 0
                ? `<div class="section"><h4 class="section-title">Tags</h4><div class="tags">${pkg.tags.map((t) => `<span class="tag">${this.esc(t.toUpperCase())}</span>`).join("")}</div></div>`
                : "";

        const versionOptions = versions
            .map(
                (v) =>
                    `<option value="${this.escAttr(v)}" ${v === pkg.installedVersion ? "selected" : ""}>${this.esc(v)}</option>`,
            )
            .join("");

        return `<div class="details-header">
<div class="details-icon-box"><span class="material-symbols-outlined details-icon-glyph" style="font-variation-settings: 'FILL' 1;">database</span></div>
<div class="details-title"><h2>${safeId}</h2><p>${safeAuthors}</p></div>
</div>
<div class="details-actions">
${installed ? `<button class="btn btn-danger" onclick="uninstallPackage('${this.escAttr(pkg.id)}')"><span class="material-symbols-outlined btn-icon">delete</span> Remove</button>` : `<button class="btn btn-primary" onclick="installPackage('${this.escAttr(pkg.id)}', '${this.escAttr(pkg.version)}')"><span class="material-symbols-outlined btn-icon">download</span> Install</button>`}
<div class="version-select"><select onchange="changeVersion('${this.escAttr(pkg.id)}', this.value)" ${!installed ? "disabled" : ""}>${versionOptions}</select><span class="material-symbols-outlined version-chevron">expand_more</span></div>
</div>
<div class="section"><h4 class="section-title">Description</h4><p class="section-content">${safeDesc}</p></div>
<div class="section"><div class="info-grid">${infoRows}</div></div>
${tagsHtml}`;
    }

    private fmtDl(count: number): string {
        if (count >= 1_000_000_000)
            return `${(count / 1_000_000_000).toFixed(1)}B Downloads`;
        if (count >= 1_000_000)
            return `${(count / 1_000_000).toFixed(1)}M Downloads`;
        if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K Downloads`;
        return `${count.toString()} Downloads`;
    }

    private fmtDate(dateStr: string): string {
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diff = now.getTime() - date.getTime();
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            if (days < 1) return "Today";
            if (days === 1) return "Yesterday";
            if (days < 30) return `${days.toString()} days ago`;
            if (days < 365)
                return `${Math.floor(days / 30).toString()} months ago`;
            return `${Math.floor(days / 365).toString()} years ago`;
        } catch {
            return dateStr;
        }
    }

    private buildCss(): string {
        return `<style>
.material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; vertical-align: middle; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #E5E2E1; background: #131313; height: 100vh; overflow: hidden; display: flex; }

/* Main */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* Header */
.header { height: 56px; background: #131313; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; z-index: 40; }
.header-left { display: flex; align-items: center; gap: 32px; }
.header-right { display: flex; align-items: center; gap: 16px; }
.logo { font-size: 18px; font-weight: 700; color: #9FCAFF; letter-spacing: -0.02em; }
.nav-tabs { display: flex; height: 56px; }
.nav-tab { display: flex; align-items: center; padding: 0 16px; color: #C0C7D3; text-decoration: none; font-weight: 500; font-size: 13px; border-bottom: 2px solid transparent; height: 100%; cursor: pointer; transition: all 0.15s; }
.nav-tab:hover { color: #FFFFFF; background: #202020; }
.nav-tab.active { color: #9FCAFF; border-bottom-color: #9FCAFF; font-weight: 600; }
.search-box { position: relative; }
.search-box input { width: 256px; height: 30px; background: #0E0E0E; border: 1px solid rgba(138,145,157,0.2); border-radius: 6px; padding: 0 12px 0 36px; color: #E5E2E1; font-size: 13px; font-family: 'Inter', sans-serif; outline: none; transition: all 0.15s; }
.search-box input:focus { border-color: #9FCAFF; box-shadow: 0 0 0 1px rgba(159,202,255,0.1); }
.search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 16px; color: #8A919D; }
.icon-btn { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #C0C7D3; cursor: pointer; border-radius: 4px; transition: all 0.15s; }
.icon-btn:hover { background: #202020; color: #E5E2E1; }
.icon-btn .material-symbols-outlined { font-size: 20px; }

/* Content */
.content { flex: 1; display: flex; overflow: hidden; }
.package-list { flex: 1; overflow-y: auto; padding: 16px; }
.list-header { display: flex; justify-content: space-between; align-items: center; padding: 24px 16px 16px; }
.list-title { font-size: 20px; font-weight: 700; color: #E5E2E1; letter-spacing: -0.02em; }

/* Package items */
.package-item { display: flex; gap: 16px; padding: 16px; border-radius: 6px; border-left: 2px solid transparent; cursor: pointer; transition: all 0.15s; margin-bottom: 8px; }
.package-item:hover { background: #1B1B1C; }
.package-item.selected { background: #1B1B1C; border-left-color: #9FCAFF; }
.package-icon-box { width: 40px; height: 40px; border-radius: 4px; background: #202020; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.package-icon-box.selected { background: #007ACC; }
.package-icon-box .material-symbols-outlined { font-size: 20px; color: #9FCAFF; }
.package-icon-box.selected .material-symbols-outlined { color: #FFFFFF; }
.icon-selected { color: #FFFFFF !important; }
.package-content { flex: 1; min-width: 0; }
.package-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
.package-name { font-size: 15px; font-weight: 600; color: #E5E2E1; }
.package-version { font-size: 11px; color: #C0C7D3; background: #2A2A2A; padding: 2px 8px; border-radius: 999px; }
.package-version.installed { background: rgba(159,202,255,0.18); color: #9FCAFF; }
.package-description { font-size: 13px; color: #C0C7D3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 12px; }
.package-meta { display: flex; gap: 16px; }
.meta-item { display: flex; align-items: center; gap: 4px; font-size: 0.65rem; color: rgba(192,199,211,0.7); }
.meta-icon { font-size: 1rem !important; }

/* Details panel */
.details-panel { width: 384px; background: #1B1B1C; border-left: 1px solid rgba(64,71,81,0.1); overflow-y: auto; padding: 24px; flex-shrink: 0; }
.details-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #C0C7D3; text-align: center; gap: 16px; }
.empty-icon { font-size: 48px; opacity: 0.5; }
.empty-title { font-size: 16px; font-weight: 600; color: #E5E2E1; margin-bottom: 8px; }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px; color: #C0C7D3; text-align: center; }
.details-header { display: flex; gap: 12px; margin-bottom: 16px; }
.details-icon-box { width: 48px; height: 48px; border-radius: 8px; background: #007ACC; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.details-icon-glyph { font-size: 24px; color: #FFFFFF; }
.details-title h2 { font-size: 18px; font-weight: 700; color: #E5E2E1; line-height: 1.2; }
.details-title p { font-size: 12px; color: #C0C7D3; }
.details-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 24px; }
.btn { height: 36px; border-radius: 6px; border: none; font-size: 13px; font-weight: 600; font-family: 'Inter', sans-serif; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.15s; }
.btn-icon { font-size: 16px !important; }
.btn-primary { background: #007ACC; color: #FFFFFF; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-danger { background: rgba(255,180,171,0.12); color: #FFB4AB; }
.btn-danger:hover { background: rgba(255,180,171,0.2); }
.version-select { position: relative; }
.version-select select { width: 100%; height: 36px; background: #2A2A2A; border: 1px solid rgba(64,71,81,0.2); border-radius: 6px; padding: 0 32px 0 12px; color: #E5E2E1; font-size: 12px; font-family: 'Inter', sans-serif; appearance: none; cursor: pointer; }
.version-chevron { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 16px; pointer-events: none; color: #C0C7D3; }

/* Sections */
.section { margin-bottom: 24px; }
.section-title { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #C0C7D3; margin-bottom: 12px; }
.section-content { font-size: 12px; line-height: 1.6; color: #C0C7D3; }
.info-grid { display: flex; flex-direction: column; gap: 4px; }
.info-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(64,71,81,0.05); }
.info-label { font-size: 0.7rem; color: #C0C7D3; }
.info-value { font-size: 0.7rem; color: #E5E2E1; }
.info-link { font-size: 0.7rem; color: #9FCAFF; text-decoration: none; display: flex; align-items: center; gap: 4px; }
.info-link:hover { text-decoration: underline; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; }
.tag { padding: 4px 8px; background: #353535; border: 1px solid rgba(64,71,81,0.1); border-radius: 999px; font-size: 0.6rem; color: #C0C7D3; text-transform: uppercase; letter-spacing: 0.02em; }


/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: #131313; }
::-webkit-scrollbar-thumb { background: #353535; }
::-webkit-scrollbar-thumb:hover { background: #404751; }
</style>`;
    }
}
