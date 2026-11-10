// Published extension activation, never local extension code. [DIST-VERSION-MATCH] #45.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { requiredPath } = require("./fixtures/release-editor.cjs");
const {
    requireBundle,
    requireExtensionManifest,
    skipUnlessEnabled,
} = require("./release-host.cjs");
const setting = {
    host: "sharplsp.lspPath",
    fsharp: "sharplsp.fsharpSidecarPath",
    csharp: "sharplsp.csharpSidecarPath",
};
const harnessManifest = {
    name: "sharplsp-release-resolution",
    publisher: "release-probe",
    version: "0.0.1",
    engines: { vscode: "^1.140.0" },
    main: "test.cjs",
};

function assertOlderVersion(name, binary) {
    const banner = execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 30000,
    }).trim();
    const id = name === "host" ? "sharplsp" : `sharplsp-sidecar-${name}`;
    assert.equal(
        banner,
        `${id} 0.32.1`,
        "negative control must be an older release binary",
    );
}

function olderBundle() {
    const root = requiredPath("SHARPLSP_OLDER_RELEASE_BUNDLE");
    const binaries = {
        host: join(root, "sharplsp"),
        fsharp: join(root, "sidecar-fsharp/SharpLsp.Sidecar.FSharp"),
        csharp: join(root, "sidecar-csharp/SharpLsp.Sidecar.CSharp"),
    };
    for (const [name, binary] of Object.entries(binaries)) {
        assertOlderVersion(name, binary);
    }
    return binaries;
}

function settingsFor(name, current, older) {
    const result = Object.fromEntries(
        Object.entries(setting).map(([key, field]) => [field, current[key]]),
    );
    if (name !== "positive") result[setting[name]] = older[name];
    result["dotnetAcquisitionExtension.existingDotnetPath"] = [
        {
            extensionId: "nimblesite.sharplsp",
            path: requiredPath("SHARPLSP_TEST_DOTNET"),
        },
    ];
    result["telemetry.telemetryLevel"] = "off";
    result["extensions.autoUpdate"] = false;
    result["extensions.autoCheckUpdates"] = false;
    result["workbench.startupEditor"] = "none";
    return result;
}

function createHarness(directory) {
    const harness = join(directory, "harness");
    fs.mkdirSync(harness);
    for (const [source, destination] of [
        ["version-resolution.cjs", "test.cjs"],
        ["release-editor.cjs", "release-editor.cjs"],
    ]) {
        fs.copyFileSync(
            join(__dirname, "fixtures", source),
            join(harness, destination),
        );
    }
    fs.writeFileSync(
        join(harness, "package.json"),
        JSON.stringify(harnessManifest),
    );
    return harness;
}

function prepareCase(directory, settings) {
    const workspace = join(directory, "workspace");
    const userData = join(directory, "profile");
    for (const folder of [join(workspace, ".vscode"), join(userData, "User")]) {
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(
            join(folder, "settings.json"),
            JSON.stringify(settings),
        );
    }
    const harness = createHarness(directory);
    const resultFile = join(directory, "result.json");
    return { workspace, userData, harness, resultFile };
}

function codeArguments(fixture) {
    return [
        "--new-window",
        "--user-data-dir",
        fixture.userData,
        "--extensions-dir",
        requiredPath("SHARPLSP_RELEASE_EXTENSIONS_DIR"),
        `--extensionDevelopmentPath=${fixture.harness}`,
        `--extensionTestsPath=${join(fixture.harness, "test.cjs")}`,
        "--disable-workspace-trust",
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        fixture.workspace,
    ];
}

function launchCode(name, fixture) {
    const env = {
        ...process.env,
        DOTNET_PROCESSOR_COUNT: "2",
        SHARPLSP_VERSION_CASE: name,
        SHARPLSP_VERSION_RESULT: fixture.resultFile,
    };
    return runCode(codeArguments(fixture), env);
}

function runCode(args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(requiredPath("SHARPLSP_TEST_CODE"), args, {
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.resume();
        child.stderr.resume();
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
}

async function runCases(context, directory) {
    requireExtensionManifest();
    const current = requireBundle();
    const older = olderBundle();
    const results = [];
    for (const name of ["positive", "fsharp", "csharp", "host"]) {
        const root = join(directory, name);
        const fixture = prepareCase(root, settingsFor(name, current, older));
        const exit = await launchCode(name, fixture);
        const result = JSON.parse(fs.readFileSync(fixture.resultFile, "utf8"));
        results.push({ ...result, exit });
    }
    context.diagnostic(JSON.stringify(results));
    assert.ok(
        results.every((result) => result.passed && result.exit.code === 0),
        JSON.stringify(results),
    );
}

test(
    "#45 explicit older binary settings block published VSIX startup",
    {
        timeout: 360000,
        skip: skipUnlessEnabled(
            "#45 v0.33.0 ignores explicit older binary settings and starts its bundled copy",
        ),
    },
    async (context) => {
        const directory = fs.mkdtempSync(join(tmpdir(), "slsp-version-"));
        try {
            await runCases(context, directory);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    },
);
