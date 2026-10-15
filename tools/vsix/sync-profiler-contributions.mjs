// Writes the profiler UI's package.json contributions into the extension
// manifest from the library's generator, so the manifest and the library's
// command registrations never drift. Implements [PROFILER-SHARED-LIBRARY-VSCODE].
//
//   node tools/vsix/sync-profiler-contributions.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, "../../src/editors/vscode");
const manifestPath = path.join(extensionDir, "package.json");
const require = createRequire(path.join(extensionDir, "package.json"));
const generator = require.resolve("@nimblesite/lsp-profiler-ui/scripts/contributions.mjs");
const { profilerContributions } = await import(generator);

const host = {
  prefix: "sharplsp",
  brand: "SharpLsp",
  container: "sharplsp-explorer",
  debugType: "sharplsp-coreclr",
  restartCommand: "sharplsp.restartServer",
};
const generated = profilerContributions(host);
const PROFILER_VIEW = "sharplsp.profiler.processes";
const isProfiler = (id) => typeof id === "string" && id.startsWith("sharplsp.profiler.");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const contributes = manifest.contributes;

contributes.commands = [...contributes.commands.filter((c) => !isProfiler(c.command)), ...generated.commands];
for (const [menu, entries] of Object.entries(contributes.menus)) {
  contributes.menus[menu] = entries.filter((e) => !isProfiler(e.command) && !(typeof e.when === "string" && e.when.includes(PROFILER_VIEW)));
}
for (const [menu, entries] of Object.entries(generated.menus)) {
  contributes.menus[menu] = [...(contributes.menus[menu] ?? []), ...entries];
}
for (const [container, views] of Object.entries(contributes.views)) {
  contributes.views[container] = views.filter((v) => !isProfiler(v.id) && v.id !== "sharplsp.profiler");
}
for (const [container, views] of Object.entries(generated.views)) {
  contributes.views[container] = [...(contributes.views[container] ?? []), ...views];
}
contributes.viewsWelcome = [...(contributes.viewsWelcome ?? []).filter((w) => w.view !== PROFILER_VIEW), ...generated.viewsWelcome];
contributes.keybindings = [...(contributes.keybindings ?? []).filter((k) => !isProfiler(k.command)), ...generated.keybindings];
const properties = contributes.configuration.properties;
for (const key of Object.keys(properties)) {
  if (isProfiler(key)) delete properties[key];
}
Object.assign(properties, generated.configuration);

const next = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (fs.readFileSync(manifestPath, "utf8") !== next) {
    console.error("package.json profiler contributions are stale: run tools/vsix/sync-profiler-contributions.mjs");
    process.exit(1);
  }
} else {
  fs.writeFileSync(manifestPath, next);
  console.log(`synced ${generated.commands.length} profiler commands into ${manifestPath}`);
}
