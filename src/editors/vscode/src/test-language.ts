/**
 * The language of the project that built a test assembly, so the Testing view
 * tags every F# test `fsharp` — xUnit, NUnit, MSTest, Expecto and FsCheck alike
 * — and no C# test, whatever the tests are called (#604).
 *
 * The project is the one the listing names, else the nearest project file above
 * the assembly's output folder (`bin/<config>/<tfm>/`). Nothing found is
 * `undefined`: the row is left untagged rather than guessed.
 *
 * Implements [TEST-EXPLORER].
 */

import * as fs from 'node:fs';
import { directoryOf, hasExtension, isProjectFile, joinPath } from './paths';
import type { TestAssemblyListing } from './test-listing-model.js';

/** A .NET project language a test can be written in. */
export type ProjectLanguage = 'fsharp' | 'csharp';

/** How many folders above the assembly a project file may sit (`bin/<config>/<tfm>`, plus RID). */
const MAX_LEVELS = 5;

/** The language of the project that built `assembly`, when one can be found. */
export function projectLanguageOf(assembly: TestAssemblyListing): ProjectLanguage | undefined {
  const project = assembly.projectFile ?? nearestProject(directoryOf(assembly.path));
  if (project === undefined) return undefined;
  return hasExtension(project, '.fsproj') ? 'fsharp' : 'csharp';
}

/** The first project file in `dir` or the folders above it, within {@link MAX_LEVELS}. */
function nearestProject(dir: string): string | undefined {
  let current = dir;
  for (let level = 0; level <= MAX_LEVELS; level += 1) {
    const found = projectFilesIn(current);
    if (found.length > 0) return found.find((file) => hasExtension(file, '.fsproj')) ?? found[0];
    const parent = directoryOf(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** The project files directly inside `dir`; none when it cannot be read. */
function projectFilesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => isProjectFile(name))
      .map((name) => joinPath(dir, name));
  } catch {
    return [];
  }
}
