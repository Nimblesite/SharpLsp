// Implements [TUTORIAL-DETECT-EDITOR], [TUTORIAL-PROGRESS] and [TUTORIAL-FIRST-RUN].
import * as vscode from 'vscode';
import {
  CMD_TUTORIAL_OPEN,
  CMD_TUTORIAL_OPEN_FILE,
  CMD_TUTORIAL_RESET,
  CONFIG_SECTION,
  CONFIG_TUTORIAL_SHOW_ON_STARTUP,
} from '../constants.js';
import * as log from '../log.js';
import { effect, type Signal } from '../signals.js';
import { getErrorMessage } from '../utils.js';
import type { TutorialProgress } from './model.generated.js';
import { createTutorialPanel, type TutorialPanel } from './panel.js';
import {
  EMPTY_PROGRESS,
  isTutorialProgress,
  progress,
  record,
  resetProgress,
  stepStates,
} from './progress.js';
import {
  contextKey,
  type LanguageKind,
  LANGUAGES,
  languageLabel,
  languageOfId,
  stepOf,
} from './steps.js';
import { tutorialSourceFile } from './source-file.js';

const PROGRESS_KEY = 'sharplsp.tutorial.progress';
const SHOWN_KEY = 'sharplsp.tutorial.shown';

/** The tutorial's test seam on the extension API ([TUTORIAL-TESTING]). */
export interface TutorialApi {
  readonly progress: Signal<TutorialProgress>;
  readonly panel: TutorialPanel;
}

function restore(state: vscode.Memento): TutorialProgress {
  const stored = state.get<unknown>(PROGRESS_KEY);
  if (stored === undefined || isTutorialProgress(stored)) return stored ?? EMPTY_PROGRESS;
  log.warn('Tutorial: discarding stored progress this version does not understand');
  return EMPTY_PROGRESS;
}

/** Persist every change, and mirror it into the walkthrough's context keys. */
function mirror(context: vscode.ExtensionContext): void {
  const stop = effect(() => {
    const current = progress.value;
    void context.globalState.update(PROGRESS_KEY, current);
    for (const { step, done } of stepStates(current)) {
      void vscode.commands.executeCommand('setContext', contextKey(step), done);
    }
  });
  context.subscriptions.push({ dispose: stop });
}

function noteEditor(editor: vscode.TextEditor | undefined): void {
  const document = editor?.document;
  if (document === undefined || !['file', 'untitled'].includes(document.uri.scheme)) return;
  const language = languageOfId(document.languageId);
  if (language !== undefined) record(stepOf(language, 'OpenFile'));
}

function noteExplorer(visible: boolean): void {
  if (!visible) return;
  for (const language of LANGUAGES) record(stepOf(language, 'SolutionExplorer'));
}

function watchEditor(context: vscode.ExtensionContext, explorer: vscode.TreeView<unknown>): void {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(noteEditor),
    explorer.onDidChangeVisibility((event) => {
      noteExplorer(event.visible);
    }),
  );
  noteEditor(vscode.window.activeTextEditor);
  noteExplorer(explorer.visible);
}

/** Open a `language` file the server has loaded ([TUTORIAL-OPEN-FILE]). */
async function openFirstFile(language: LanguageKind): Promise<void> {
  const file = await tutorialSourceFile(language);
  if (file.kind === 'none') {
    const where = file.where === 'solution' ? 'the loaded solution' : 'this workspace';
    void vscode.window.showInformationMessage(
      `There is no ${languageLabel(language)} file in ${where}.`,
    );
    return;
  }
  log.info(`Tutorial: opening ${file.uri.toString()} for ${language}`);
  await vscode.window.showTextDocument(file.uri, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
}

function languageArg(value: unknown): LanguageKind {
  return LANGUAGES.find((language) => language === value) ?? 'FSharp';
}

function registerCommands(context: vscode.ExtensionContext, panel: TutorialPanel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_TUTORIAL_OPEN, (language?: unknown) => {
      panel.open(languageArg(language));
    }),
    vscode.commands.registerCommand(CMD_TUTORIAL_OPEN_FILE, async (language?: unknown) => {
      await openFirstFile(languageArg(language));
    }),
    vscode.commands.registerCommand(CMD_TUTORIAL_RESET, resetProgress),
  );
}

/** Open the F# walkthrough and the panel once per install ([TUTORIAL-FIRST-RUN]). */
async function firstRun(context: vscode.ExtensionContext, panel: TutorialPanel): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>(CONFIG_TUTORIAL_SHOW_ON_STARTUP, true);
  if (context.extensionMode === vscode.ExtensionMode.Test || !enabled) return;
  if (context.globalState.get<boolean>(SHOWN_KEY) === true) return;
  await context.globalState.update(SHOWN_KEY, true);
  const walkthrough = `${context.extension.id}#sharplsp.tutorial.fsharp`;
  await vscode.commands.executeCommand('workbench.action.openWalkthrough', walkthrough, false);
  panel.open('FSharp');
}

export function registerTutorial(
  context: vscode.ExtensionContext,
  explorer: vscode.TreeView<unknown>,
): TutorialApi {
  progress.value = restore(context.globalState);
  mirror(context);
  const panel = createTutorialPanel(context, (language) => {
    void openFirstFile(language);
  });
  registerCommands(context, panel);
  watchEditor(context, explorer);
  void firstRun(context, panel).catch((error: unknown) => {
    log.warn(`Tutorial first run failed: ${getErrorMessage(error)}`);
  });
  return { progress, panel };
}
