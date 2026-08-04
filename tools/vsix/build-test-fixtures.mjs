// Build the VS Code test-fixture solution before the extension host launches.
//
// The e2e suites drive a REAL LSP over `test-fixtures/workspace`, and several of
// them assert on results that only exist once the solution has been restored and
// built:
//
//   * Unused-package detection ([PKG-UNUSED-DETECT-CS]) compares a project's
//     declared PackageReferences against the assemblies Roslyn actually
//     resolved. With nothing restored there is no Serilog assembly among the
//     compilation's references, so nothing can be classified and the request
//     comes back empty — the suite then passes vacuously.
//   * The mixed-language rename fixtures ([RENAME-CROSSLANGUAGE]) bind C# to F#
//     through a project reference. Roslyn's MSBuildWorkspace cannot load an
//     `.fsproj`, so that reference degrades to a metadata reference resolved
//     from the F# project's build output on disk.
//
// This has to run in `pretest`, not in a suite's setup: the extension activates
// and Roslyn loads the solution on the first C# file any suite opens, and a
// build after that point does not refresh the already-loaded snapshot.
//
// Debug is pinned because MSBuildWorkspace opens the solution under MSBuild's
// default configuration, so Debug is where it looks for project output.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const solution = path.resolve(
  here,
  '..',
  '..',
  'src',
  'editors',
  'vscode',
  'test-fixtures',
  'workspace',
  'TestFixtures.slnx',
);

if (!existsSync(solution)) {
  console.error(`build-test-fixtures: solution not found at ${solution}`);
  process.exit(1);
}

console.log(`==> Building test fixtures (${solution})...`);
try {
  execFileSync('dotnet', ['build', solution, '--configuration', 'Debug', '--nologo'], {
    stdio: 'inherit',
  });
} catch (error) {
  console.error(`build-test-fixtures: dotnet build failed: ${error.message}`);
  process.exit(1);
}
