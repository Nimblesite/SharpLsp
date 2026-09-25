// [DIST-VSIX-REBUILD] Remove generated .NET outputs, including stale BuildHost
// files that incremental publish and dotnet clean can leave behind.
import { readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function cleanSidecarOutput(root) {
    const sidecars = join(root, "src", "sidecars");
    if (!existsSync(join(sidecars, "SharpLsp.Sidecars.sln")))
        throw new Error("Not a SharpLsp sidecar tree");
    for (const project of projectDirectories(sidecars)) {
        for (const output of ["bin", "obj"])
            rmSync(join(project, output), { recursive: true, force: true });
    }
    for (const output of ["sidecar-csharp", "sidecar-fsharp"]) {
        rmSync(join(root, "target", output), { recursive: true, force: true });
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
