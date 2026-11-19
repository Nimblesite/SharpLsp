// Implements [DIST-CI-VSIX-HOST-CACHE]: put the extension SharpLsp depends on
// ([DIST-RUNTIME-ACQUIRE]) into the test host's extensions dir once. A copy the
// host cache restored is reused without touching the Marketplace; a missing one
// is installed with retries, because the gallery answers 503 often enough to
// fail a shard that tests nothing about it.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const DEPENDENCY = "ms-dotnettools.vscode-dotnet-runtime";
const ATTEMPTS = 4;
const fromExtension = pathToFileURL(`${process.cwd()}/package.json`);
const electron = createRequire(fromExtension)("@vscode/test-electron");
const { default: config } = await import(new URL(".vscode-test.mjs", fromExtension).href);

/** Whether the extensions dir already holds an installed copy. */
function installed(directory) {
  return existsSync(directory) && readdirSync(directory).some((name) => name.startsWith(`${DEPENDENCY}-`));
}

/** One CLI install; true when it succeeded. */
function attempt(cli, args) {
  const shell = process.platform === "win32";
  const run = spawnSync(shell ? `"${cli}"` : cli, [...args, "--install-extension", DEPENDENCY], { stdio: "inherit", shell });
  return run.status === 0;
}

/** Install with a growing pause between tries; fails after the last one. */
async function install(cli, args) {
  for (let tries = 1; tries <= ATTEMPTS; tries += 1) {
    if (attempt(cli, args)) return;
    await new Promise((resolve) => setTimeout(resolve, tries * 15_000));
  }
  throw new Error(`${DEPENDENCY} could not be installed after ${ATTEMPTS} attempts`);
}

const options = config.tests[0];
const host = await electron.downloadAndUnzipVSCode(options.version);
const [cli, ...args] = electron.resolveCliArgsFromVSCodeExecutablePath(host, options);
const directory = args.find((arg) => arg.startsWith("--extensions-dir="))?.slice("--extensions-dir=".length);
if (directory && installed(directory)) process.exit(0);
await install(cli, args);
