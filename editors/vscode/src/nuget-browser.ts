import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as log from "./log.js";
import { getErrorMessage } from "./utils.js";

const execFileAsync = promisify(execFile);

export interface NuGetSearchResult {
    readonly id: string;
    readonly version: string;
    readonly description: string;
    readonly authors: string;
    readonly iconUrl?: string;
    readonly licenseUrl?: string;
    readonly projectUrl?: string;
    readonly published?: string;
    readonly downloadCount?: number;
    readonly tags: string[];
    readonly isInstalled?: boolean;
    readonly installedVersion?: string | undefined;
}

export class NuGetBrowserPanel {
    private static instance: NuGetBrowserPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private readonly projectPath: string;
    private readonly projectName: string;
    private installedPackages: Map<string, string> = new Map();
    private currentSearchQuery = "";
    private currentTab: "browse" | "installed" | "updates" = "browse";
    private searchResults: NuGetSearchResult[] = [];
    private selectedPackage: NuGetSearchResult | undefined;

    private constructor(
        context: vscode.ExtensionContext,
        projectPath: string,
        projectName: string,
    ) {
        this.context = context;
        this.projectPath = projectPath;
        this.projectName = projectName;

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
                NuGetBrowserPanel.instance = undefined;
            },
            undefined,
            context.subscriptions,
        );

        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            undefined,
            context.subscriptions,
        );

        void this.loadInstalledPackages().then(() => {
            this.updateContent();
        });
    }

    public static open(
        context: vscode.ExtensionContext,
        projectPath: string,
        projectName: string,
    ): NuGetBrowserPanel {
        if (NuGetBrowserPanel.instance !== undefined) {
            NuGetBrowserPanel.instance.panel.reveal(vscode.ViewColumn.One);
            return NuGetBrowserPanel.instance;
        }
        NuGetBrowserPanel.instance = new NuGetBrowserPanel(
            context,
            projectPath,
            projectName,
        );
        return NuGetBrowserPanel.instance;
    }

    public dispose(): void {
        this.panel.dispose();
    }

    private async handleMessage(message: {
        command: string;
        data?: Record<string, unknown>;
    }): Promise<void> {
        switch (message.command) {
            case "search": {
                const query = String(message.data?.query ?? "");
                this.currentSearchQuery = query;
                await this.performSearch(query);
                break;
            }
            case "selectPackage": {
                const packageId = String(message.data?.packageId ?? "");
                const pkg = this.searchResults.find((p) => p.id === packageId);
                if (pkg !== undefined) {
                    this.selectedPackage = pkg;
                    await this.loadPackageDetails(pkg);
                    this.updateContent();
                }
                break;
            }
            case "install": {
                const packageId = String(message.data?.packageId ?? "");
                const version = String(message.data?.version ?? "");
                await this.installPackage(packageId, version);
                break;
            }
            case "uninstall": {
                const packageId = String(message.data?.packageId ?? "");
                await this.uninstallPackage(packageId);
                break;
            }
            case "changeVersion": {
                const packageId = String(message.data?.packageId ?? "");
                const version = String(message.data?.version ?? "");
                await this.changeVersion(packageId, version);
                break;
            }
            case "switchTab": {
                const tab = String(message.data?.tab ?? "browse") as
                    | "browse"
                    | "installed"
                    | "updates";
                this.currentTab = tab;
                if (tab === "installed") {
                    await this.loadInstalledPackages();
                }
                this.updateContent();
                break;
            }
            case "openExternal": {
                const url = String(message.data?.url ?? "");
                if (url.length > 0) {
                    void vscode.env.openExternal(vscode.Uri.parse(url));
                }
                break;
            }
        }
    }

    private async loadInstalledPackages(): Promise<void> {
        try {
            const result = await execFileAsync(
                "dotnet",
                ["list", this.projectPath, "package", "--format", "json"],
                { encoding: "utf-8" },
            );
            const data = JSON.parse(result.stdout) as {
                projects?: Array<{
                    frameworks?: Array<{
                        topLevelPackages?: Array<{
                            id: string;
                            requestedVersion: string;
                            resolvedVersion: string;
                        }>;
                    }>;
                }>;
            };

            this.installedPackages.clear();
            const project = data.projects?.[0];
            if (project?.frameworks !== undefined) {
                for (const framework of project.frameworks) {
                    for (const pkg of framework.topLevelPackages ?? []) {
                        this.installedPackages.set(pkg.id, pkg.resolvedVersion);
                    }
                }
            }
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.info(`Failed to load installed packages: ${msg}`);
        }
    }

    private async performSearch(query: string): Promise<void> {
        try {
            if (query.length === 0) {
                this.searchResults = await this.fetchPopularPackages();
            } else {
                this.searchResults = await this.searchNuGet(query);
            }
            this.updateContent();
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(`NuGet search failed: ${msg}`);
        }
    }

    private async searchNuGet(query: string): Promise<NuGetSearchResult[]> {
        const url = `https://azuresearch-usnc.nuget.org/query?q=${encodeURIComponent(query)}&prerelease=false&take=50`;
        const response = await fetch(url);
        const data = (await response.json()) as {
            data?: Array<{
                id: string;
                version: string;
                description: string;
                authors: string;
                iconUrl: string;
                licenseUrl: string;
                projectUrl: string;
                published: string;
                totalDownloads: number;
                tags: string[];
            }>;
        };

        return (data.data ?? []).map((pkg) => ({
            id: pkg.id,
            version: pkg.version,
            description: pkg.description,
            authors: pkg.authors,
            iconUrl: pkg.iconUrl,
            licenseUrl: pkg.licenseUrl,
            projectUrl: pkg.projectUrl,
            published: pkg.published,
            downloadCount: pkg.totalDownloads,
            tags: pkg.tags ?? [],
            isInstalled: this.installedPackages.has(pkg.id),
            installedVersion: this.installedPackages.get(pkg.id),
        }));
    }

    private async fetchPopularPackages(): Promise<NuGetSearchResult[]> {
        const popularQueries = ["microsoft", "newtonsoft", "serilog", "automapper"];
        const allResults: NuGetSearchResult[] = [];

        for (const q of popularQueries) {
            const results = await this.searchNuGet(q);
            allResults.push(...results.slice(0, 10));
        }

        const unique = new Map<string, NuGetSearchResult>();
        for (const pkg of allResults) {
            if (!unique.has(pkg.id) || (pkg.downloadCount ?? 0) > (unique.get(pkg.id)?.downloadCount ?? 0)) {
                unique.set(pkg.id, pkg);
            }
        }

        return Array.from(unique.values())
            .sort((a, b) => (b.downloadCount ?? 0) - (a.downloadCount ?? 0))
            .slice(0, 50);
    }

    private async loadPackageDetails(pkg: NuGetSearchResult): Promise<void> {
        try {
            const url = `https://api.nuget.org/v3-flatcontainer/${pkg.id.toLowerCase()}/index.json`;
            const response = await fetch(url);
            const data = (await response.json()) as { versions?: string[] };
            (pkg as unknown as { _versions?: string[] })._versions = data.versions ?? [];
        } catch (err: unknown) {
            log.info(`Failed to load versions for ${pkg.id}: ${getErrorMessage(err)}`);
        }
    }

    private async installPackage(packageId: string, version: string): Promise<void> {
        try {
            log.info(`Installing ${packageId} v${version} to ${this.projectName}`);
            await execFileAsync("dotnet", [
                "add", this.projectPath, "package", packageId, "--version", version,
            ]);
            void vscode.window.showInformationMessage(`Installed ${packageId} v${version}`);
            this.installedPackages.set(packageId, version);
            await this.loadInstalledPackages();
            await this.performSearch(this.currentSearchQuery);
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(`Failed to install package: ${msg}`);
            void vscode.window.showErrorMessage(`Failed to install: ${msg}`);
        }
    }

    private async uninstallPackage(packageId: string): Promise<void> {
        try {
            log.info(`Removing ${packageId} from ${this.projectName}`);
            await execFileAsync("dotnet", ["remove", this.projectPath, "package", packageId]);
            void vscode.window.showInformationMessage(`Removed ${packageId}`);
            this.installedPackages.delete(packageId);
            await this.loadInstalledPackages();
            await this.performSearch(this.currentSearchQuery);
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(`Failed to remove package: ${msg}`);
            void vscode.window.showErrorMessage(`Failed to remove: ${msg}`);
        }
    }

    private async changeVersion(packageId: string, version: string): Promise<void> {
        try {
            log.info(`Changing ${packageId} to v${version} in ${this.projectName}`);
            await execFileAsync("dotnet", ["remove", this.projectPath, "package", packageId]);
            await execFileAsync("dotnet", ["add", this.projectPath, "package", packageId, "--version", version]);
            void vscode.window.showInformationMessage(`Updated ${packageId} to v${version}`);
            this.installedPackages.set(packageId, version);
            await this.loadInstalledPackages();
            await this.performSearch(this.currentSearchQuery);
        } catch (err: unknown) {
            const msg = getErrorMessage(err);
            log.error(`Failed to change version: ${msg}`);
            void vscode.window.showErrorMessage(`Failed to update: ${msg}`);
        }
    }

    private updateContent(): void {
        this.panel.webview.html = this.buildHtml();
    }

    private escapeHtml(text: string): string {
        const amp = String.fromCharCode(38) + "amp;";
        const lt = String.fromCharCode(38) + "lt;";
        const gt = String.fromCharCode(38) + "gt;";
        const quot = String.fromCharCode(38) + "quot;";
        const apos = String.fromCharCode(38) + "#039;";
        return text
            .replace(/&/g, amp)
            .replace(/</g, lt)
            .replace(/>/g, gt)
            .replace(/"/g, quot)
            .replace(/'/g, apos);
    }

    private escapeAttr(text: string): string {
        const quot = String.fromCharCode(38) + "quot;";
        const apos = String.fromCharCode(38) + "#039;";
        return text.replace(/"/g, quot).replace(/'/g, apos);
    }

    private buildHtml(): string {
        const theme = {
            bg: "#131313",
            surface: "#1B1B1C",
            surfaceHigh: "#202020",
            surfaceHigher: "#2A2A2A",
            surfaceHighest: "#353535",
            onSurface: "#E5E2E1",
            onSurfaceVariant: "#C0C7D3",
            primary: "#9FCAFF",
            primaryContainer: "#007ACC",
            onPrimaryContainer: "#FFFFFF",
            outline: "#8A919D",
            outlineVariant: "#404751",
            error: "#FFB4AB",
        };

        const packages = this.currentTab === "installed"
            ? this.searchResults.filter((p) => p.isInstalled)
            : this.searchResults;

        const installedList = Array.from(this.installedPackages.entries()).map(
            ([id, version]) => ({ id, version, isInstalled: true, installedVersion: version }),
        );

        const safeProjectName = this.escapeHtml(this.projectName);
        const safeQuery = this.escapeAttr(this.currentSearchQuery);

        return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://*;">
<title>NuGet Architect - ${safeProjectName}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif; font-size: 13px; color: ${theme.onSurface}; background: ${theme.bg}; height: 100vh; overflow: hidden; display: flex; }
.sidebar { width: 64px; background: #1B1B1C; display: flex; flex-direction: column; align-items: center; padding: 16px 0; z-index: 50; }
.sidebar-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 8px; margin-bottom: 8px; color: ${theme.onSurfaceVariant}; cursor: pointer; transition: all 0.15s; }
.sidebar-icon:hover { background: ${theme.surfaceHighest}; color: ${theme.onSurface}; }
.sidebar-icon.active { color: ${theme.primary}; border-left: 2px solid ${theme.primary}; background: ${theme.surfaceHigh}; border-radius: 0 8px 8px 0; margin-left: -2px; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.header { height: 56px; background: ${theme.bg}; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; border-bottom: 1px solid ${theme.outlineVariant}20; }
.header-left { display: flex; align-items: center; gap: 32px; }
.logo { font-size: 18px; font-weight: 700; color: ${theme.primary}; letter-spacing: -0.02em; }
.nav-tabs { display: flex; height: 56px; }
.nav-tab { display: flex; align-items: center; padding: 0 16px; color: ${theme.onSurfaceVariant}; text-decoration: none; font-weight: 500; font-size: 13px; border-bottom: 2px solid transparent; height: 100%; cursor: pointer; transition: all 0.15s; }
.nav-tab:hover { color: ${theme.onSurface}; background: ${theme.surfaceHigh}; }
.nav-tab.active { color: ${theme.primary}; border-bottom-color: ${theme.primary}; }
.search-area { display: flex; align-items: center; gap: 12px; }
.search-box { position: relative; }
.search-box input { width: 280px; height: 32px; background: ${theme.bg}; border: 1px solid ${theme.outline}40; border-radius: 6px; padding: 0 12px 0 36px; color: ${theme.onSurface}; font-size: 13px; outline: none; transition: all 0.15s; }
.search-box input:focus { border-color: ${theme.primary}; box-shadow: 0 0 0 2px ${theme.primary}15; }
.search-box::before { content: "🔍"; position: absolute; left: 12px; top: 50%; transform: translateY(-50%); font-size: 12px; opacity: 0.6; }
.icon-btn { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: ${theme.onSurfaceVariant}; cursor: pointer; border-radius: 6px; font-size: 16px; }
.icon-btn:hover { background: ${theme.surfaceHigh}; color: ${theme.onSurface}; }
.content { flex: 1; display: flex; overflow: hidden; }
.package-list { flex: 1; overflow-y: auto; padding: 16px; }
.package-list-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px 16px; border-bottom: 1px solid ${theme.outlineVariant}20; margin-bottom: 8px; }
.package-list-title { font-size: 18px; font-weight: 700; color: ${theme.onSurface}; letter-spacing: -0.02em; }
.sort-select { display: flex; align-items: center; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: ${theme.onSurfaceVariant}; }
.sort-select select { background: ${theme.surfaceHigh}; border: none; border-radius: 4px; padding: 4px 8px; color: ${theme.onSurface}; font-size: 12px; cursor: pointer; }
.package-item { display: flex; gap: 16px; padding: 16px; border-radius: 6px; border-left: 2px solid transparent; cursor: pointer; transition: all 0.15s; margin-bottom: 4px; }
.package-item:hover { background: ${theme.surfaceHigh}; }
.package-item.selected { background: ${theme.surfaceHigh}; border-left-color: ${theme.primary}; }
.package-icon { width: 40px; height: 40px; border-radius: 6px; background: ${theme.surfaceHigh}; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 20px; }
.package-icon.selected { background: ${theme.primaryContainer}; }
.package-content { flex: 1; min-width: 0; }
.package-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
.package-name { font-size: 15px; font-weight: 600; color: ${theme.onSurface}; }
.package-version { font-size: 11px; color: ${theme.onSurfaceVariant}; background: ${theme.surfaceHigher}; padding: 2px 8px; border-radius: 999px; }
.package-version.installed { background: ${theme.primary}30; color: ${theme.primary}; }
.package-description { font-size: 13px; color: ${theme.onSurfaceVariant}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px; }
.package-meta { display: flex; gap: 16px; font-size: 11px; color: ${theme.onSurfaceVariant}90; }
.package-meta-item { display: flex; align-items: center; gap: 4px; }
.details-panel { width: 384px; background: ${theme.surface}; border-left: 1px solid ${theme.outlineVariant}20; overflow-y: auto; padding: 24px; }
.details-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: ${theme.onSurfaceVariant}; text-align: center; gap: 16px; }
.details-empty-icon { font-size: 48px; opacity: 0.5; }
.details-header { display: flex; gap: 12px; margin-bottom: 20px; }
.details-icon { width: 48px; height: 48px; border-radius: 8px; background: ${theme.primaryContainer}; display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0; }
.details-title h2 { font-size: 18px; font-weight: 700; color: ${theme.onSurface}; margin-bottom: 4px; line-height: 1.2; }
.details-title p { font-size: 12px; color: ${theme.onSurfaceVariant}; }
.details-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 24px; }
.btn { height: 36px; border-radius: 6px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; transition: all 0.15s; }
.btn-primary { background: linear-gradient(135deg, ${theme.primaryContainer}, #005a9e); color: ${theme.onPrimaryContainer}; }
.btn-primary:hover { filter: brightness(1.1); }
.btn-secondary { background: ${theme.surfaceHigher}; color: ${theme.onSurface}; }
.btn-secondary:hover { background: ${theme.surfaceHighest}; }
.btn-danger { background: ${theme.error}20; color: ${theme.error}; }
.btn-danger:hover { background: ${theme.error}30; }
.version-select { position: relative; }
.version-select select { width: 100%; height: 36px; background: ${theme.surfaceHigher}; border: 1px solid ${theme.outlineVariant}40; border-radius: 6px; padding: 0 32px 0 12px; color: ${theme.onSurface}; font-size: 12px; appearance: none; cursor: pointer; }
.section { margin-bottom: 24px; }
.section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: ${theme.onSurfaceVariant}; margin-bottom: 12px; }
.section-content { font-size: 12px; line-height: 1.6; color: ${theme.onSurfaceVariant}; }
.info-grid { display: flex; flex-direction: column; gap: 8px; }
.info-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid ${theme.outlineVariant}15; }
.info-label { font-size: 12px; color: ${theme.onSurfaceVariant}; }
.info-value { font-size: 12px; color: ${theme.onSurface}; }
.info-link { color: ${theme.primary}; text-decoration: none; display: flex; align-items: center; gap: 4px; }
.info-link:hover { text-decoration: underline; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { padding: 4px 10px; background: ${theme.surfaceHighest}; border: 1px solid ${theme.outlineVariant}20; border-radius: 999px; font-size: 10px; color: ${theme.onSurfaceVariant}; text-transform: uppercase; letter-spacing: 0.02em; }
.status-bar { height: 24px; background: ${theme.primaryContainer}; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; font-size: 11px; color: white; }
.status-left, .status-right { display: flex; gap: 16px; }
.status-item { display: flex; align-items: center; gap: 4px; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: ${theme.surfaceHighest}; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: ${theme.outlineVariant}; }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px; color: ${theme.onSurfaceVariant}; text-align: center; }
.empty-state-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
.empty-state-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; color: ${theme.onSurface}; }
</style>
</head>
<body>
<nav class="sidebar">
<div class="sidebar-icon" title="Explorer">📁</div>
<div class="sidebar-icon active" title="NuGet Packages">🔍</div>
<div class="sidebar-icon" title="Dependencies">📦</div>
<div style="flex: 1;"></div>
<div class="sidebar-icon" title="Settings">⚙️</div>
</nav>
<main class="main">
<header class="header">
<div class="header-left">
<span class="logo">NuGet Architect</span>
<nav class="nav-tabs">
<a class="nav-tab ${this.currentTab === "browse" ? "active" : ""}" onclick="switchTab('browse')">Browse</a>
<a class="nav-tab ${this.currentTab === "installed" ? "active" : ""}" onclick="switchTab('installed')">Installed</a>
<a class="nav-tab ${this.currentTab === "updates" ? "active" : ""}" onclick="switchTab('updates')">Updates</a>
</nav>
</div>
<div class="search-area">
${this.currentTab === "browse" ? `<div class="search-box"><input type="text" id="searchInput" placeholder="Search packages..." value="${safeQuery}" onkeydown="if(event.key==='Enter')doSearch()"></div>` : ""}
<button class="icon-btn" onclick="refresh()" title="Refresh">🔄</button>
<button class="icon-btn" title="Settings">⚙️</button>
</div>
</header>
<div class="content">
<section class="package-list">
${this.buildPackageListHtml(packages, installedList)}
</section>
<aside class="details-panel">
${this.buildDetailsHtml()}
</aside>
</div>
<footer class="status-bar">
<div class="status-left">
<span class="status-item">🌿 main*</span>
<span class="status-item">↔️ Ready</span>
</div>
<div class="status-right">
<span>NuGet v6.8.0</span>
<span>UTF-8</span>
</div>
</footer>
</main>
<script>
const vscode = acquireVsCodeApi();
function doSearch() { const query = document.getElementById('searchInput').value; vscode.postMessage({ command: 'search', data: { query } }); }
function switchTab(tab) { vscode.postMessage({ command: 'switchTab', data: { tab } }); }
function selectPackage(packageId) { vscode.postMessage({ command: 'selectPackage', data: { packageId } }); }
function installPackage(packageId, version) { vscode.postMessage({ command: 'install', data: { packageId, version } }); }
function uninstallPackage(packageId) { vscode.postMessage({ command: 'uninstall', data: { packageId } }); }
function changeVersion(packageId, version) { vscode.postMessage({ command: 'changeVersion', data: { packageId, version } }); }
function openExternal(url) { vscode.postMessage({ command: 'openExternal', data: { url } }); }
function refresh() { location.reload(); }
</script>
</body>
</html>`;
    }

    private buildPackageListHtml(
        packages: NuGetSearchResult[],
        installedPackages: Array<{ id: string; version: string; isInstalled: boolean }>,
    ): string {
        const displayPackages = this.currentTab === "installed" ? installedPackages : packages;

        if (displayPackages.length === 0) {
            const title = this.currentTab === "installed" ? "No packages installed" : "No packages found";
            const msg = this.currentTab === "installed" ? "This project has no NuGet packages installed." : "Try a different search term.";
            return `<div class="empty-state"><div class="empty-state-icon">📦</div><div class="empty-state-title">${title}</div><p>${msg}</p></div>`;
        }

        const items = displayPackages.map((pkg) => {
            const isSelected = this.selectedPackage?.id === pkg.id;
            const isInstalled = "isInstalled" in pkg && pkg.isInstalled;
            const installedVersion = "installedVersion" in pkg ? pkg.installedVersion : pkg.version;
            const downloadCount = "downloadCount" in pkg && pkg.downloadCount ? this.formatDownloads(pkg.downloadCount) : null;
            const safeId = this.escapeHtml(pkg.id);
            const safeDesc = this.escapeHtml(("description" in pkg ? pkg.description : "") || "No description available");
            const safeVersion = this.escapeHtml(installedVersion ?? "");
            const pkgVersion = this.escapeHtml("version" in pkg ? pkg.version : "");
            const safeAuthors = this.escapeHtml("authors" in pkg && pkg.authors ? pkg.authors : "");

            return `<div class="package-item ${isSelected ? "selected" : ""}" onclick="selectPackage('${safeId.replace(/'/g, "\\'")}')">
<div class="package-icon ${isSelected ? "selected" : ""}">${isInstalled ? "📦" : "📋"}</div>
<div class="package-content">
<div class="package-header">
<span class="package-name">${safeId}</span>
${isInstalled ? `<span class="package-version installed">v${safeVersion}</span>` : `<span class="package-version">v${pkgVersion}</span>`}
</div>
<p class="package-description">${safeDesc}</p>
<div class="package-meta">
${downloadCount ? `<span class="package-meta-item">⬇️ ${downloadCount}</span>` : ""}
${safeAuthors ? `<span class="package-meta-item">👤 ${safeAuthors}</span>` : ""}
</div>
</div>
</div>`;
        });

        const listTitle = this.currentTab === "installed" ? "Installed Packages" : "Available Packages";
        return `<div class="package-list-header"><span class="package-list-title">${listTitle}</span><div class="sort-select"><span>Sort By:</span><select><option>Relevance</option><option>Downloads</option><option>Recently Updated</option></select></div></div>${items.join("")}`;
    }

    private buildDetailsHtml(): string {
        if (this.selectedPackage === undefined) {
            return `<div class="details-empty"><div class="details-empty-icon">📦</div><p>Select a package to view details</p></div>`;
        }

        const pkg = this.selectedPackage;
        const isInstalled = pkg.isInstalled ?? false;
        const versions = ((pkg as unknown as { _versions?: string[] })._versions ?? []).slice().reverse().slice(0, 20);
        const safeId = this.escapeHtml(pkg.id);
        const safeAuthors = this.escapeHtml(pkg.authors || "Unknown author");
        const safeDesc = this.escapeHtml(pkg.description || "No description available");

        let infoRows = "";
        if (pkg.licenseUrl) {
            infoRows += `<div class="info-row"><span class="info-label">License</span><a class="info-value info-link" href="#" onclick="openExternal('${pkg.licenseUrl}')">View License ↗</a></div>`;
        }
        if (pkg.published) {
            infoRows += `<div class="info-row"><span class="info-label">Published</span><span class="info-value">${this.formatDate(pkg.published)}</span></div>`;
        }
        if (pkg.projectUrl) {
            const safeUrl = this.escapeHtml(pkg.projectUrl);
            infoRows += `<div class="info-row"><span class="info-label">Project URL</span><a class="info-value info-link" href="#" onclick="openExternal('${pkg.projectUrl}')">${safeUrl} ↗</a></div>`;
        }
        if (pkg.downloadCount) {
            infoRows += `<div class="info-row"><span class="info-label">Downloads</span><span class="info-value">${this.formatDownloads(pkg.downloadCount)}</span></div>`;
        }

        const tagsHtml = pkg.tags.length > 0
            ? `<div class="section"><h4 class="section-title">Tags</h4><div class="tags">${pkg.tags.map((t) => `<span class="tag">${this.escapeHtml(t.toUpperCase())}</span>`).join("")}</div></div>`
            : "";

        const versionOptions = versions.map((v) => `<option value="${v}" ${v === pkg.installedVersion ? "selected" : ""}>${v}</option>`).join("");

        return `<div class="details-header"><div class="details-icon">📦</div><div class="details-title"><h2>${safeId}</h2><p>${safeAuthors}</p></div></div>
<div class="details-actions">
${isInstalled ? `<button class="btn btn-danger" onclick="uninstallPackage('${safeId.replace(/'/g, "\\'")}')">🗑️ Remove</button>` : `<button class="btn btn-primary" onclick="installPackage('${safeId.replace(/'/g, "\\'")}', '${pkg.version}')">⬇️ Install</button>`}
<div class="version-select"><select onchange="changeVersion('${safeId.replace(/'/g, "\\'")}', this.value)" ${!isInstalled ? "disabled" : ""}>${versionOptions}</select></div>
</div>
<div class="section"><h4 class="section-title">Description</h4><p class="section-content">${safeDesc}</p></div>
<div class="section"><div class="info-grid">${infoRows}</div></div>${tagsHtml}`;
    }

    private formatDownloads(count: number): string {
        if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
        if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
        if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
        return count.toString();
    }

    private formatDate(dateStr: string): string {
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diff = now.getTime() - date.getTime();
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            if (days < 1) return "Today";
            if (days === 1) return "Yesterday";
            if (days < 30) return `${days} days ago`;
            if (days < 365) return `${Math.floor(days / 30)} months ago`;
            return `${Math.floor(days / 365)} years ago`;
        } catch {
            return dateStr;
        }
    }
}