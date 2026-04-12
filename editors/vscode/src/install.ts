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

/** Type guard for the subset of package.json we care about. */
function hasVersionString(value: unknown): value is { version: string } {
    if (typeof value !== "object" || value === null) return false;
    if (!("version" in value)) return false;
    const record: Record<string, unknown> = value;
    return typeof record.version === "string";
}

/** Expected version — read from the extension's package.json via VS Code API. */
function expectedVersion(): string {
    const ext = extensions.getExtension("forge-lsp.forge");
    if (ext === undefined) {
        throw new Error(
            "Forge extension not found — cannot determine expected version",
        );
    }
    if (!hasVersionString(ext.packageJSON)) {
        throw new Error("Forge extension package.json has no version string");
    }
    return ext.packageJSON.version;
}

/** Standard install prefix. */
function installPrefix(): string {
    return path.join(os.homedir(), ".local");
}

/** Where forge-lsp should be installed. */
function installedBinaryPath(): string {
    return path.join(installPrefix(), "bin", SERVER_BINARY);
}

/** Path to the binary bundled inside the installed extension's bin/ folder. */
function bundledBinaryPath(): string | undefined {
    const ext = extensions.getExtension("forge-lsp.forge");
    if (ext === undefined) return undefined;
    const candidate = path.join(ext.extensionPath, "bin", SERVER_BINARY);
    if (!fs.existsSync(candidate)) return undefined;
    // Ensure the executable bit survived unpacking from the .vsix.
    try {
        fs.chmodSync(candidate, 0o755);
    } catch {
        /* best-effort */
    }
    return candidate;
}

/** Get the installed version by running `forge-lsp --version`. */
export function getInstalledVersion(binaryPath: string): string | undefined {
    try {
        const result = child_process.execFileSync(binaryPath, ["--version"], {
            timeout: 2000,
            encoding: "utf-8",
            killSignal: "SIGKILL",
        });
        // Output format: "forge-lsp 0.1.0"
        const parts = result.trim().split(" ");
        if (parts.length >= 2 && parts[0] === "forge-lsp") {
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

    if (platform === "darwin" && arch === "arm64")
        return "aarch64-apple-darwin";
    if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
    if (platform === "linux" && arch === "x64")
        return "x86_64-unknown-linux-gnu";
    if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
    return undefined;
}

/** Hard timeout (ms) for the GitHub release download path. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

/** Download a file from a URL, following redirects, with a hard timeout. */
async function downloadToFile(url: string, destPath: string): Promise<void> {
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
                timeout: DOWNLOAD_TIMEOUT_MS,
            };

            const request = https.get(options, (response) => {
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
            });

            request.on("error", reject);
            request.on("timeout", () => {
                request.destroy(
                    new Error(
                        `Download timed out after ${String(DOWNLOAD_TIMEOUT_MS)}ms: ${requestUrl}`,
                    ),
                );
            });
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
                    reject(err instanceof Error ? err : new Error(String(err)));
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
                fs.writeFileSync(
                    filePath,
                    data.subarray(offset, offset + size),
                );
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
 * Ensure forge-lsp is available, in this priority order:
 *
 * 1. User-configured `forge.server.path` (version-checked).
 * 2. Binary bundled in the extension VSIX itself (`<extensionPath>/bin/forge-lsp`).
 * 3. Standard install location (`~/.local/bin/forge-lsp`).
 * 4. Anything resolvable on `$PATH`.
 * 5. Download from a GitHub release.
 *
 * The bundled-binary check is intentionally trust-on-presence (no version
 * probe): it ships in the same .vsix as this code, so it cannot drift.
 * This also means activation never blocks on `forge-lsp --version` for the
 * common installed-from-vsix path, which previously hung the extension host
 * if the binary was wedged.
 */
export async function ensureBinaries(
    configuredPath: string,
): Promise<InstallResult> {
    const version = expectedVersion();

    // 1. User-configured path — trust it, but still version check.
    if (configuredPath.length > 0 && fs.existsSync(configuredPath)) {
        const installed = getInstalledVersion(configuredPath);
        if (installed === version) {
            log.info(
                `Using configured binary: ${configuredPath} (v${version})`,
            );
            return { serverPath: configuredPath };
        }
        log.info(
            `Configured binary version mismatch: expected ${version}, got ${String(installed)}`,
        );
    }

    // 2. Binary bundled inside the .vsix — preferred for installed extensions.
    const bundled = bundledBinaryPath();
    if (bundled !== undefined) {
        log.info(`Using bundled binary: ${bundled} (v${version})`);
        return { serverPath: bundled };
    }

    // 3. Standard install location.
    const standardPath = installedBinaryPath();
    if (fs.existsSync(standardPath)) {
        const installed = getInstalledVersion(standardPath);
        if (installed === version) {
            log.info(`Using installed binary: ${standardPath} (v${version})`);
            return { serverPath: standardPath };
        }
        log.info(
            `Installed binary version mismatch: expected ${version}, got ${String(installed)}`,
        );
    }

    // 4. Check $PATH.
    const pathVersion = getInstalledVersion(SERVER_BINARY);
    if (pathVersion === version) {
        log.info(`Using binary from PATH: ${SERVER_BINARY} (v${version})`);
        return { serverPath: SERVER_BINARY };
    }

    // 5. Not found or wrong version — download and install.
    log.info(
        `Forge v${version} not found. Attempting download from GitHub releases.`,
    );

    try {
        await downloadAndInstall(version);
        return { serverPath: installedBinaryPath() };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const fullMsg = `Forge: forge-lsp v${version} required but not found. ${msg}. Install manually: https://github.com/${GITHUB_REPO}/releases or run \`make install\` from source.`;
        log.info(fullMsg);
        void window.showErrorMessage(fullMsg);
        throw new Error(fullMsg, { cause: err });
    }
}

/**
 * Summarise why binary resolution failed, for user-facing error messages.
 * Returns the closest match (if any) and the expected version.
 */
export function describeBinaryStatus(configuredPath: string): {
    expected: string;
    found: string | undefined;
    location: string;
} {
    const expected = expectedVersion();
    const standardPath = installedBinaryPath();

    // Check standard install location first.
    if (fs.existsSync(standardPath)) {
        const installed = getInstalledVersion(standardPath);
        return { expected, found: installed, location: standardPath };
    }

    // Check configured path.
    if (configuredPath.length > 0 && fs.existsSync(configuredPath)) {
        const installed = getInstalledVersion(configuredPath);
        return { expected, found: installed, location: configuredPath };
    }

    return { expected, found: undefined, location: standardPath };
}
