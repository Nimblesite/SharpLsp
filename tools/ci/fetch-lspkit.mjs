#!/usr/bin/env node
// Implements [PROFILER-SHARED-LIBRARY]: lspkit arrives as its published release
// assets — the prebuilt .NET engine and the consumer kit (fixtures) — never as
// its source. Every byte is checked against the release's SHA256SUMS, itself pinned.
//
// Usage: node tools/ci/fetch-lspkit.mjs kit <dir>
//        node tools/ci/fetch-lspkit.mjs engine <vsix-platform> <dir>
// Env:   LSPKIT_VERSION, LSPKIT_SUMS_SHA256
import { existsSync, writeFileSync } from "node:fs";
import { fetchPinned, unpack } from "../download/pinned.mjs";

const VERSION = process.env.LSPKIT_VERSION;
const RELEASE = `https://github.com/Nimblesite/lspkit/releases/download/v${VERSION}`;
/** VS Code platform → .NET runtime identifier of the engine build. */
const RIDS = new Map(
    ["arm64", "x64"].flatMap((arch) => [["darwin", "osx"], ["linux", "linux"], ["win32", "win"]]
        .map(([os, rid]) => [`${os}-${arch}`, `${rid}-${arch}`])),
);

/** The release's own asset hashes, trusted once SHA256SUMS matches its pin. */
async function releaseSums() {
    const sums = await fetchPinned("lspkit", `${RELEASE}/SHA256SUMS`, process.env.LSPKIT_SUMS_SHA256);
    return new Map(sums.toString().trim().split("\n").map((line) => line.split(/\s+/).reverse()));
}

async function unpackAsset(asset, dir) {
    const sums = await releaseSums();
    unpack("lspkit", await fetchPinned("lspkit", `${RELEASE}/${asset}`, sums.get(asset)), dir, ["--strip-components=1"]);
}

/** The release asset one fetch unpacks. */
function assetOf(kind, platform) {
    if (kind === "kit") return `lspkit-consumer-kit-${VERSION}.tar.gz`;
    if (kind !== "engine") throw new Error(`lspkit: unknown fetch ${kind}`);
    if (!RIDS.has(platform)) throw new Error(`lspkit: no engine build for platform ${platform}`);
    return `lsp-profiler-dotnet-engine-${VERSION}-${RIDS.get(platform)}.tar.gz`;
}

/** Fetches once per version and target; a marker beside the folder records it. */
async function main([kind, ...args]) {
    const dir = args.at(-1);
    const asset = assetOf(kind, args.length > 1 ? args[0] : undefined);
    // Beside the folder, not in it: the engine folder ships whole in the VSIX.
    const marker = `${dir}.${asset}.fetched`;
    if (existsSync(marker)) return;
    await unpackAsset(asset, dir);
    writeFileSync(marker, "");
}

main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
});
