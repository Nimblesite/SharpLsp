#!/usr/bin/env node
// Implements [DIST-RUNTIME-ACQUIRE].
//
// Guards the drift that shipped a broken editor experience: `global.json` was
// bumped to a new SDK feature band while nothing verified that the band was
// what CI actually installs. CI stayed green because `setup-dotnet` puts the
// pinned SDK on `$PATH`, so every `dotnet` call there resolved it — while any
// machine without that exact band failed every build with exit code 155.
//
// This check fails when a workflow pins a .NET 10 SDK that cannot satisfy the
// repository's own `global.json`, so the two can never silently diverge again.
//
// Usage: node tools/ci/check-sdk-pin.mjs
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
// js-yaml ships with the extension's toolchain; parse the YAML rather than
// pattern-matching it, so a reformatted workflow cannot slip past the guard.
const require = createRequire(
    join(REPO_ROOT, "src", "editors", "vscode", "node_modules", "/"),
);
const yaml = require("js-yaml");

/** Parse `major.minor.bpp` into its comparable parts. */
function parseVersion(version) {
    const parts = String(version).split("-")[0].split(".");
    if (parts.length < 3) return undefined;
    const [major, minor, third] = parts.map(Number);
    if (![major, minor, third].every((n) => Number.isInteger(n) && n >= 0)) {
        return undefined;
    }
    return {
        major,
        minor,
        band: Math.floor(third / 100) * 100,
        patch: third % 100,
    };
}

function compare(a, b) {
    return (
        a.major - b.major ||
        a.minor - b.minor ||
        a.band - b.band ||
        a.patch - b.patch
    );
}

/** Mirror of the SDK's `rollForward` semantics (see src/editors/vscode/src/global-json.ts). */
function satisfies(installed, pin) {
    if (pin.rollForward === "disable") return installed === pin.version;
    const want = parseVersion(pin.version);
    const got = parseVersion(installed);
    if (!want || !got || compare(got, want) < 0) return false;
    const feature = !["patch", "latestPatch"].includes(pin.rollForward);
    const minor = ["minor", "latestMinor", "major", "latestMajor"].includes(
        pin.rollForward,
    );
    const major = ["major", "latestMajor"].includes(pin.rollForward);
    if (got.major !== want.major && !major) return false;
    if (got.minor !== want.minor && !minor) return false;
    return got.band === want.band || feature;
}

/** The repository's own SDK pin. */
function readPin() {
    const sdk = JSON.parse(
        readFileSync(join(REPO_ROOT, "global.json"), "utf8"),
    ).sdk;
    return { version: sdk.version, rollForward: sdk.rollForward ?? "latestPatch" };
}

/** Every `dotnet-version` value any workflow step requests, with its origin. */
function declaredVersions() {
    const found = [];
    for (const file of readdirSync(WORKFLOW_DIR)) {
        if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
        const doc = yaml.load(readFileSync(join(WORKFLOW_DIR, file), "utf8"));
        for (const job of Object.values(doc?.jobs ?? {})) {
            for (const step of job?.steps ?? []) {
                const requested = step?.with?.["dotnet-version"];
                if (requested === undefined) continue;
                for (const line of String(requested).split("\n")) {
                    const version = line.trim();
                    if (version.length > 0) found.push({ file, version });
                }
            }
        }
    }
    return found;
}

const pin = readPin();
const versions = declaredVersions();
// Only .NET 10 pins are candidates: a workflow may legitimately also install
// 9.0.x side by side for the multi-target sidecar builds.
const tenDot = versions.filter((entry) => entry.version.startsWith("10."));
const offenders = tenDot.filter(
    (entry) => !entry.version.endsWith(".x") && !satisfies(entry.version, pin),
);

if (tenDot.length === 0) {
    console.error(
        "No workflow pins a .NET 10 SDK, so nothing guarantees CI builds on the pinned band.",
    );
    process.exit(1);
}
if (offenders.length > 0) {
    console.error(
        `global.json pins .NET SDK ${pin.version} (rollForward: ${pin.rollForward}), ` +
            "but these workflow pins cannot satisfy it:",
    );
    for (const entry of offenders) {
        console.error(`  ${entry.file}: dotnet-version ${entry.version}`);
    }
    console.error(
        "Bump global.json and every workflow together, or widen rollForward.",
    );
    process.exit(1);
}

console.log(
    `global.json pins ${pin.version} (${pin.rollForward}); ${String(tenDot.length)} workflow .NET 10 pins all satisfy it.`,
);
