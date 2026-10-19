// The Razor fixture solution ([RAZOR-TESTING]) for the VS Code Razor suite: the
// repository's src/sharplsp/tests/fixtures/razor, copied without its build output
// to a scratch root, built so the SDK's Razor generator has run, and loaded
// through the real extension.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { serverProjection } from '../../razor-html.js';
import { dotnet } from './dotnet-project-kit';
import { type LoadedFixture, useLoadedFixture } from './netfx-language-kit';
import { lspClient } from './profiler-kit';

/** The fixture in the repository. */
const SOURCE = path.resolve(__dirname, '../../../../../sharplsp/tests/fixtures/razor');

/** Build output a copy leaves behind: a copied `obj` would point back at the source. */
const BUILD_OUTPUT = new Set(['bin', 'obj']);

/** The Razor files the suite opens, relative to the fixture root. */
export const RAZOR_FILES = {
  counter: 'BlazorApp/Components/Pages/Counter.razor',
  board: 'BlazorApp/Components/Pages/Board.razor',
} as const;

/** The Razor file the suite writes where no project lists it. */
export const STRAY_RAZOR = 'Stray.razor';

/** Copy the fixture to `root` and build it. */
async function writeRazorFixture(root: string): Promise<LoadedFixture> {
  fs.cpSync(SOURCE, root, {
    recursive: true,
    filter: (source) => !BUILD_OUTPUT.has(path.basename(source)),
  });
  const solution = path.join(root, 'RazorFixtures.slnx');
  await dotnet(['build', solution], root);
  return {
    root,
    solution,
    ready: { file: RAZOR_FILES.counter, anchor: ['Current count: @currentCount', 'currentCount'] },
  };
}

/** The Razor fixture, built and loaded for the suite that calls this. */
export function useRazorFixture(): () => LoadedFixture {
  return useLoadedFixture('sharplsp-razor-', writeRazorFixture);
}

/**
 * Write `text` as a Razor file that no project lists: alone in a scratch folder, outside
 * the fixture and every workspace folder, so no watcher reloads a project. Returns the folder.
 */
export function writeStrayRazor(text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-razor-stray-'));
  fs.writeFileSync(path.join(root, STRAY_RAZOR), text);
  return root;
}

/** The server's HTML projection of `uri`, asked for as the extension asks. [RAZOR-FEATURES-HTML] */
export function htmlProjection(uri: vscode.Uri): Promise<string | undefined> {
  return serverProjection(lspClient)(uri.toString());
}
