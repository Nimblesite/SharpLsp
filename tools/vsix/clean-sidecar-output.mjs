// [DIST-VSIX-REBUILD] Remove generated .NET outputs, including stale BuildHost
// files that incremental publish and dotnet clean can leave behind.
import { readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `reinstall-vsix` kills the installed servers and VS Code's language client
// restarts them at once; their MSBuild design-time builds then write into the
// very bin/obj being removed. A removal that loses that race is retried until
// the writer pauses, never failed on the first collision.
const RACED_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);
const ATTEMPTS = 40;
const PAUSE_MS = 250;
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

export function cleanSidecarOutput(root) {
    const sidecars = join(root, "src", "sidecars");
    if (!existsSync(join(sidecars, "SharpLsp.Sidecars.sln")))
        throw new Error("Not a SharpLsp sidecar tree");
    for (const project of projectDirectories(sidecars)) {
        for (const output of ["bin", "obj"])
            removeOutlastingWriters(join(project, output));
    }
    for (const output of ["sidecar-csharp", "sidecar-fsharp"]) {
        removeOutlastingWriters(join(root, "target", output));
    }
}

function removeOutlastingWriters(output, attempt = 1) {
    try {
        rmSync(output, { recursive: true, force: true });
    } catch (error) {
        if (!RACED_CODES.has(error.code) || attempt >= ATTEMPTS) throw error;
        Atomics.wait(PAUSE, 0, 0, PAUSE_MS);
        removeOutlastingWriters(output, attempt + 1);
    }
}

function projectDirectories(sidecars) {
    return readdirSync(sidecars, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sidecars, entry.name))
        .filter((project) =>
            readdirSync(project).some(
                (name) => name.endsWith(".csproj") || name.endsWith(".fsproj"),
            ),
        );
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    cleanSidecarOutput(
        resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    );
}
