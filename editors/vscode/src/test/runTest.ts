import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspacePath = path.resolve(
    extensionDevelopmentPath,
    "test-fixtures",
    "workspace",
  );

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, "--disable-extensions"],
  });
}

main().catch((err) => {
  console.error("Failed to run tests:", err);
  process.exit(1);
});
