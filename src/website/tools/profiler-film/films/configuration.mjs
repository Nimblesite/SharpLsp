// Implements [WEB-DESIGN-MEDIA]. The "Configuration" walkthrough
// (`configuration`): SharpLsp's VS Code settings, then sharplsp.toml beside
// the solution, monorepo mode switched on, the server restarted, and an
// unused public property reported as dead code.
//
//   node src/website/tools/profiler-film/film.mjs configuration
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../kit/editor.mjs';
import { LANGUAGE, awaitSemantics, hoverEach, prepareCode, scene, settingsEditor } from '../kit/acts/language.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep, typeAt } from '../kit/workbench.mjs';

/** The documented sharplsp.toml, every field at its default. */
const TOML = [
  '[server]',
  'log_level = "info"',
  'debounce_ms = 150',
  '',
  '[csharp]',
  'enabled = true',
  'solution_path = ""',
  '',
  '[fsharp]',
  'enabled = true',
  '',
  '[diagnostics]',
  'analyzers_enabled = true',
  'solution_wide_analysis = true',
  'project_filter = []',
  '',
  '[analyzers]',
  'dead_code = true',
  'monorepo = false',
];
const MONOREPO = TOML.indexOf('monorepo = false') + 1;

/** The file as staged beside the solution. */
export const configurationToml = `${TOML.join('\n')}\n`;
const SESSIONS = 'SessionCache.cs';
const PROBE = { line: 8, word: 'Remember' };

async function settings({ page }) {
  await settingsEditor.open(page, 'sharplsp');
  await sleep(2500);
  await page.mouse.move(1100, 600);
  await page.mouse.wheel(0, 500);
  await sleep(3000);
  await settingsEditor.close(page);
}

async function monorepo({ page }) {
  await runCommand(page, 'View: Close All Editors');
  await openFile(page, 'sharplsp.toml');
  await sleep(1500);
  await typeAt(page, { line: MONOREPO, text: 'monorepo = true' });
  await page.keyboard.press('Meta+S');
  await sleep(2000);
}

async function restart({ page }) {
  await runCommand(page, 'SharpLsp: Restart Language Server');
  await openFile(page, SESSIONS);
  await awaitSemantics(page, PROBE);
  await sleep(1500);
}

async function deadCode({ page }) {
  await sleep(3000);
  await hoverEach(page, [{ line: 17, word: 'SnapshotBytes' }], { hold: 4500 });
  await page.keyboard.press('Meta+Shift+M');
  await sleep(4000);
}

export default {
  name: 'configuration',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'configuration.narration.json',
  poster: { scene: 'toml', at: 5 },
  scenes: [
    { offCamera: ({ workspace }) => fs.writeFileSync(path.join(workspace, 'sharplsp.toml'), configurationToml) },
    { offCamera: prepareCode(SESSIONS, PROBE) },
    scene('settings', 1, 'Editor settings: VS Code\'s Settings, under SharpLsp', settings),
    scene('toml', 2, 'Server settings: sharplsp.toml, beside the solution', monorepo),
    scene('restart', 3, 'Restart the language server to apply it', restart, { speed: 4 }),
    scene('effect', 4, 'Monorepo mode: unused public members are dead code', deadCode),
  ],
};
