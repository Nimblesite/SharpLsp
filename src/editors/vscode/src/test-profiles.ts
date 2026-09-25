/**
 * The three profiles the Testing view offers: Run, Debug, and Run with
 * Coverage, in the order it shows them.
 *
 * Kept apart from `testing.ts` so the controller file stays about state and
 * dispatch. The handlers themselves belong to the controller; this module only
 * declares the profiles and wires the lazy coverage lookup.
 *
 * Implements [TEST-EXPLORER] and [TEST-COVERAGE].
 */

import * as vscode from 'vscode';
import { loadDetailedCoverage } from './test-coverage.js';

/** One profile's handler, as VS Code invokes it. */
export type RunProfileHandler = (
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
) => Promise<void>;

/** What the controller supplies for each profile. */
export interface RunProfileHandlers {
  readonly run: RunProfileHandler;
  readonly debug: RunProfileHandler;
  readonly coverage: RunProfileHandler;
}

/** Register the three profiles and return them in display order. */
export function registerRunProfiles(
  controller: vscode.TestController,
  handlers: RunProfileHandlers,
): vscode.TestRunProfile[] {
  const run = controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, handlers.run, true);
  const debug = controller.createRunProfile(
    'Debug',
    vscode.TestRunProfileKind.Debug,
    handlers.debug,
  );
  const coverage = controller.createRunProfile(
    'Run with Coverage',
    vscode.TestRunProfileKind.Coverage,
    handlers.coverage,
  );
  coverage.loadDetailedCoverage =
    // eslint-disable-next-line @typescript-eslint/require-await -- VS Code API requires Thenable return but lookup is synchronous
    async (_run, fileCoverage, _token) => loadDetailedCoverage(fileCoverage);
  return [run, debug, coverage];
}
