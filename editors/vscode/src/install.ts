/**
 * Binary version checking and auto-installation from GitHub releases.
 *
 * All Forge binaries live in a central location (~/.local/bin + ~/.local/lib/forge/).
 * Extensions are thin clients that launch system-installed binaries.
 * If the correct version is not installed, download from GitHub releases.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { extensions, window } from "vscode";
import { SERVER_BINARY } from "./constants.js";
import * as log from "./log.js";

/** Result of a version check or install attempt. */
interface InstallResult {
    readonly serverPath: string;
}

/** GitHub release repo (owner/repo). */
const GITHUB_REPO = "forge-lsp/forge";

/** Expected version — read from the extension's package.json via VS Code API. */
function expectedVersion(): string {
    const ext = extensions.getExtension("forge-lsp.forge");
    if (ext === undefined) {
        throw new Error("Forge extension not found — cannot determine expected version");
    }
    return ext.packageJSON.version as string;
}

/** Standard install prefix. */
function installPrefix(): string {
    return path.join(os.homedir(), ".local");
}

/** Where forge-lsp should be installed. */
function installedBinaryPath(): string {
    return path.join(installPrefix(), "bin", SERVER_BINARY);
}

/** Get the installed version by running `forge-lsp --version`. */
function getInstalledVersion(binaryPath: string): string | undefined {
    try {
        const result = child_process.execFileSync(binaryPath, ["--version"], {
            timeout: 5000,
            encoding: "utf-8",
        });
        // Output format: "forge-lsp 0.1.0"
        const parts = result.trim().split(" ");
        if (parts.length >= 2) {
            return parts[1];
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/** Determine the .NET runtime identifier for the current platform. */
function platformRid(): string | undefined {
    const arch = os.arch();
    const platform = os.platform();

    if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
    if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
    if (platform === "linux" && arch === "x64")
        return "x86_64-unknown-linux-gnu";
    if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
    return undefined;
}

/** Download a file from a URL, following redirects. */
async function downloadToFile(
    url: string,
    destPath: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const doRequest = (requestUrl: string, redirectCount: number): void => {
            if (redirectCount > 5) {
                reject(new Error("Too many redirects"));
                return;
            }

            const parsed = new URL(requestUrl);
            const options = {
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                headers: { "User-Agent": "forge-vscode-extension" },
            };

            https
                .get(options, (response) => {
                    // Follow redirects
                    if (
                        (response.statusCode === 301 ||
                            response.statusCode === 302) &&
                        response.headers.location !== undefined
                    ) {
                        doRequest(response.headers.location, redirectCount + 1);
                        return;
                    }

                    if (response.statusCode !== 200) {
                        reject(
                            new Error(
                                `Download failed: HTTP ${String(response.statusCode)}`,
                            ),
                        );
                        return;
                    }

                    const file = fs.createWriteStream(destPath);
                    response.pipe(file);
                    file.on("finish", () => {
                        file.close(() => {
                            resolve();
                        });
                    });
                    file.on("error", (err) => {
                        fs.unlinkSync(destPath);
                        reject(err);
                    });
                })
                .on("error", reject);
        };

        doRequest(url, 0);
    });
}

/** Extract a .tar.gz archive to a destination directory. */
async function extractTarGz(
    archivePath: string,
    destDir: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const gunzip = zlib.createGunzip();
        const input = fs.createReadStream(archivePath);

        // Simple tar extraction — tar is a stream of 512-byte blocks.
        // Each file has a header block followed by data blocks.
        const chunks: Buffer[] = [];

        input
            .pipe(gunzip)
            .on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            })
            .on("end", () => {
                try {
                    const data = Buffer.concat(chunks);
                    extractTarBuffer(data, destDir);
                    resolve();
                } catch (err: unknown) {
                    reject(
                        err instanceof Error
                            ? err
                            : new Error(String(err)),
                    );
                }
            })
            .on("error", reject);
    });
}

/** Extract files from a tar buffer into destDir, stripping the first path component. */
function extractTarBuffer(data: Buffer, destDir: string): void {
    let offset = 0;
    const TAR_BLOCK = 512;

    while (offset + TAR_BLOCK <= data.length) {
        const header = data.subarray(offset, offset + TAR_BLOCK);

        // Check for end-of-archive (two zero blocks).
        if (header.every((b) => b === 0)) break;

        const nameRaw = header.subarray(0, 100).toString("utf-8");
        const name = nameRaw.replace(/\0.*$/, "");
        const sizeOctal = header.subarray(124, 136).toString("utf-8").trim();
        const size = parseInt(sizeOctal, 8);
        const typeFlag = header[156];

        // Strip first path component (e.g. "forge-v0.1.0-aarch64-apple-darwin/bin/forge-lsp" -> "bin/forge-lsp")
        const parts = name.split("/");
        const stripped = parts.slice(1).join("/");

        offset += TAR_BLOCK;

        if (typeFlag === 53) {
            // Directory
            if (stripped.length > 0) {
                fs.mkdirSync(path.join(destDir, stripped), { recursive: true });
            }
        } else if (typeFlag === 0 || typeFlag === 48) {
            // Regular file
            if (stripped.length > 0 && !isNaN(size)) {
                const filePath = path.join(destDir, stripped);
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, data.subarray(offset, offset + size));
                // Make executables in bin/ executable
                if (stripped.startsWith("bin/")) {
                    fs.chmodSync(filePath, 0o755);
                }
            }
        }

        // Advance past data blocks (rounded up to TAR_BLOCK).
        const blocks = Math.ceil(size / TAR_BLOCK);
        offset += blocks * TAR_BLOCK;
    }
}

/** Download and install Forge binaries from GitHub releases. */
async function downloadAndInstall(version: string): Promise<void> {
    const rid = platformRid();
    if (rid === undefined) {
        throw new Error(
            `Unsupported platform: ${os.platform()} ${os.arch()}. Download manually from https://github.com/${GITHUB_REPO}/releases`,
        );
    }

    const tag = `v${version}`;
    const archiveName = `forge-${tag}-${rid}.tar.gz`;
    const url = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${archiveName}`;

    log.info(`Downloading Forge ${version} from ${url}`);

    void window.showInformationMessage(
        `Forge: Installing binaries v${version}...`,
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-install-"));
    const archivePath = path.join(tmpDir, archiveName);

    try {
        await downloadToFile(url, archivePath);

        const prefix = installPrefix();
        await extractTarGz(archivePath, prefix);

        // Verify the binary works after install.
        const binaryPath = installedBinaryPath();
        if (!fs.existsSync(binaryPath)) {
            throw new Error(
                `Installation completed but ${binaryPath} not found`,
            );
        }

        const installed = getInstalledVersion(binaryPath);
        if (installed !== version) {
            throw new Error(
                `Version mismatch after install: expected ${version}, got ${String(installed)}`,
            );
        }

        log.info(`Forge ${version} installed successfully to ${prefix}`);
        void window.showInformationMessage(
            `Forge: Binaries v${version} installed to ${prefix}`,
        );
    } finally {
        // Clean up temp files.
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Ensure the correct version of forge-lsp is installed.
 *
 * 1. Check user-configured path first.
 * 2. Check standard install location (~/.local/bin/forge-lsp).
 * 3. Check $PATH.
 * 4. If missing or wrong version: download from GitHub release.
 * 5. If download fails: hard error.
 */
export async function ensureBinaries(
    configuredPath: string,
): Promise<InstallResult> {
    const version = expectedVersion();

    // 1. User-configured path — trust it, but still version check.
    if (configuredPath.length > 0 && fs.existsSync(configuredPath)) {
        const installed = getInstalledVersion(configuredPath);
        if (installed === version) {
            log.info(`Using configured binary: ${configuredPath} (v${version})`);
            return { serverPath: configuredPath };
        }
        log.info(
            `Configured binary version mismatch: expected ${version}, got ${String(installed)}`,
        );
    }

    // 2. Standard install location.
    const standardPath = installedBinaryPath();
    if (fs.existsSync(standardPath)) {
        const installed = getInstalledVersion(standardPath);
        if (installed === version) {
            log.info(
                `Using installed binary: ${standardPath} (v${version})`,
            );
            return { serverPath: standardPath };
        }
        log.info(
            `Installed binary version mismatch: expected ${version}, got ${String(installed)}`,
        );
    }

    // 3. Check $PATH.
    const pathVersion = getInstalledVersion(SERVER_BINARY);
    if (pathVersion === version) {
        log.info(`Using binary from PATH: ${SERVER_BINARY} (v${version})`);
        return { serverPath: SERVER_BINARY };
    }

    // 4. Not found or wrong version — download and install.
    log.info(
        `Forge v${version} not found. Attempting download from GitHub releases.`,
    );

    try {
        await downloadAndInstall(version);
        return { serverPath: installedBinaryPath() };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const fullMsg = `Forge: FATAL — Failed to install binaries v${version}. ${msg}. Install manually: https://github.com/${GITHUB_REPO}/releases or run \`make install\` from source.`;
        log.info(fullMsg);
        void window.showErrorMessage(fullMsg);
        throw new Error(fullMsg);
    }
}
