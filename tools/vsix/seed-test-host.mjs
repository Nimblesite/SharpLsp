// Implements [DIST-CI-VSIX-HOST-CACHE]: download exactly the host the test config
// asks for, under the config's own connection settings, into `.vscode-test`.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const fromExtension = pathToFileURL(`${process.cwd()}/package.json`);
const { downloadAndUnzipVSCode } = createRequire(fromExtension)("@vscode/test-electron");
const { default: config } = await import(new URL(".vscode-test.mjs", fromExtension).href);
await downloadAndUnzipVSCode(config.tests[0].version);
