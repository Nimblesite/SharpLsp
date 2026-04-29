// Orchestrates website screenshot capture from the VS Code e2e suite.
// The tests write .signal files; sidecar.mjs observes them over CDP and
// captures the real VS Code workbench.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vscodeDir = path.resolve(__dirname, "..");
const screenshotCdpPort = process.env.SHARPLSP_SCREENSHOT_CDP_PORT ?? "9239";
const userDataDir =
  process.env.SHARPLSP_TEST_USER_DATA_DIR ??
  path.join(process.env.TMPDIR ?? "/tmp", `sharplsp-screenshot-userdata-${process.pid}`);

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: vscodeDir,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });

  return {
    child,
    done: new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    }),
  };
}

async function main() {
  const screenshotEnv = {
    FORGE_SCREENSHOTS: "1",
    FORGE_SCREENSHOT_CDP_PORT: screenshotCdpPort,
    FORGE_TEST_USER_DATA_DIR: userDataDir,
  };

  const sidecar = run(process.execPath, ["screenshots/sidecar.mjs"], {
    env: screenshotEnv,
  });
  const tests = run("npm", ["test", "--", "--coverage"], {
    env: screenshotEnv,
  });

  const result = await tests.done;
  sidecar.child.kill("SIGTERM");

  const code = result.code ?? (result.signal === null ? 1 : 128);
  process.exit(code);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
