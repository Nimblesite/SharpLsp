/**
 * Shared UI-stubbing harness for coarse end-to-end tests.
 *
 * Real command handlers prompt the user through modal `vscode.window.show*`
 * dialogs that cannot run in a headless test host. To drive a command end-to-end
 * we temporarily replace those members with queue-backed stubs, invoke the real
 * command, then assert on the real side effects (files created, packages added,
 * webviews opened) AND on the prompts that were shown.
 *
 * Every stub is restored via `restore()` (call it in `teardown`) so unrelated
 * suites observe a pristine `vscode.window` / `vscode.workspace`.
 */
import * as vscode from 'vscode';

type ShowInputBox = typeof vscode.window.showInputBox;
type ShowQuickPick = typeof vscode.window.showQuickPick;
type ShowInfo = typeof vscode.window.showInformationMessage;
type ShowWarning = typeof vscode.window.showWarningMessage;
type ShowError = typeof vscode.window.showErrorMessage;
type ShowOpenDialog = typeof vscode.window.showOpenDialog;
type ShowSaveDialog = typeof vscode.window.showSaveDialog;

interface MutableWindow {
  showInputBox: ShowInputBox;
  showQuickPick: ShowQuickPick;
  showInformationMessage: ShowInfo;
  showWarningMessage: ShowWarning;
  showErrorMessage: ShowError;
  showOpenDialog: ShowOpenDialog;
  showSaveDialog: ShowSaveDialog;
}

/** A QuickPick selector: an index, a label substring, or a predicate. */
export type PickSelector = number | string | ((items: readonly unknown[]) => unknown) | undefined;

/** A message-box selector: the action label to click, or undefined to dismiss. */
export type MessageSelector = string | undefined;

/** Everything the command-under-test asked the user, recorded in order. */
export interface PromptLog {
  readonly inputBoxOptions: (vscode.InputBoxOptions | undefined)[];
  readonly quickPickItems: unknown[][];
  readonly quickPickOptions: (vscode.QuickPickOptions | undefined)[];
  readonly infoMessages: string[];
  readonly warningMessages: string[];
  readonly errorMessages: string[];
  readonly openDialogOptions: (vscode.OpenDialogOptions | undefined)[];
  readonly saveDialogOptions: (vscode.SaveDialogOptions | undefined)[];
}

/** Live handle to an installed stub harness. */
export interface UiStubs {
  readonly log: PromptLog;
  /** Queue values returned by successive `showInputBox` calls. */
  queueInput(...values: (string | undefined)[]): UiStubs;
  /** Queue selections for successive `showQuickPick` calls. */
  queuePick(...selectors: PickSelector[]): UiStubs;
  /** Queue button responses for successive `showInformationMessage` calls. */
  queueInfo(...selectors: MessageSelector[]): UiStubs;
  /** Queue button responses for successive `showWarningMessage` calls. */
  queueWarning(...selectors: MessageSelector[]): UiStubs;
  /** Queue button responses for successive `showErrorMessage` calls. */
  queueError(...selectors: MessageSelector[]): UiStubs;
  /** Queue URIs returned by successive `showOpenDialog` calls. */
  queueOpenDialog(...results: (vscode.Uri[] | undefined)[]): UiStubs;
  /** Queue URIs returned by successive `showSaveDialog` calls. */
  queueSaveDialog(...results: (vscode.Uri | undefined)[]): UiStubs;
  /** Restore every patched member. Idempotent. */
  restore(): void;
}

function resolvePick(selector: PickSelector, items: readonly unknown[]): unknown {
  if (selector === undefined) return undefined;
  if (typeof selector === 'number') return items[selector];
  if (typeof selector === 'function') return selector(items);
  // string: match by label substring.
  return items.find((item) => {
    const label = (item as { label?: string }).label ?? String(item);
    return label.includes(selector);
  });
}

function pickActionFromArgs(selector: MessageSelector, args: unknown[]): string | undefined {
  if (selector === undefined) return undefined;
  // Message items may be strings or { title } objects; return whichever the
  // handler offered so its `=== 'Action'` comparison can match.
  for (const arg of args) {
    if (arg === selector) return selector;
    if (typeof arg === 'object' && arg !== null && (arg as { title?: string }).title === selector) {
      return selector;
    }
  }
  return selector;
}

/**
 * Install the harness over `vscode.window`. By default every prompt is
 * "cancelled" (returns undefined); queue methods supply real answers FIFO.
 */
export function installUiStubs(): UiStubs {
  const mutWindow = vscode.window as unknown as MutableWindow;

  const original = {
    showInputBox: mutWindow.showInputBox,
    showQuickPick: mutWindow.showQuickPick,
    showInformationMessage: mutWindow.showInformationMessage,
    showWarningMessage: mutWindow.showWarningMessage,
    showErrorMessage: mutWindow.showErrorMessage,
    showOpenDialog: mutWindow.showOpenDialog,
    showSaveDialog: mutWindow.showSaveDialog,
  };

  const log: PromptLog = {
    inputBoxOptions: [],
    quickPickItems: [],
    quickPickOptions: [],
    infoMessages: [],
    warningMessages: [],
    errorMessages: [],
    openDialogOptions: [],
    saveDialogOptions: [],
  };

  const inputs: (string | undefined)[] = [];
  const picks: PickSelector[] = [];
  const infos: MessageSelector[] = [];
  const warnings: MessageSelector[] = [];
  const errors: MessageSelector[] = [];
  const openDialogs: (vscode.Uri[] | undefined)[] = [];
  const saveDialogs: (vscode.Uri | undefined)[] = [];

  mutWindow.showInputBox = async (options?: vscode.InputBoxOptions) => {
    log.inputBoxOptions.push(options);
    return inputs.length > 0 ? inputs.shift() : undefined;
  };

  mutWindow.showQuickPick = (async (items: unknown, options?: vscode.QuickPickOptions) => {
    const resolved = (await items) as unknown[];
    log.quickPickItems.push(resolved);
    log.quickPickOptions.push(options);
    return picks.length > 0 ? resolvePick(picks.shift(), resolved) : undefined;
  }) as ShowQuickPick;

  mutWindow.showInformationMessage = async (message: string, ...rest: unknown[]) => {
    log.infoMessages.push(message);
    return infos.length > 0 ? pickActionFromArgs(infos.shift(), rest) : undefined;
  };

  mutWindow.showWarningMessage = async (message: string, ...rest: unknown[]) => {
    log.warningMessages.push(message);
    return warnings.length > 0 ? pickActionFromArgs(warnings.shift(), rest) : undefined;
  };

  mutWindow.showErrorMessage = async (message: string, ...rest: unknown[]) => {
    log.errorMessages.push(message);
    return errors.length > 0 ? pickActionFromArgs(errors.shift(), rest) : undefined;
  };

  mutWindow.showOpenDialog = async (options?: vscode.OpenDialogOptions) => {
    log.openDialogOptions.push(options);
    return openDialogs.length > 0 ? openDialogs.shift() : undefined;
  };

  mutWindow.showSaveDialog = async (options?: vscode.SaveDialogOptions) => {
    log.saveDialogOptions.push(options);
    return saveDialogs.length > 0 ? saveDialogs.shift() : undefined;
  };

  let restored = false;
  const stubs: UiStubs = {
    log,
    queueInput(...values) {
      inputs.push(...values);
      return stubs;
    },
    queuePick(...selectors) {
      picks.push(...selectors);
      return stubs;
    },
    queueInfo(...selectors) {
      infos.push(...selectors);
      return stubs;
    },
    queueWarning(...selectors) {
      warnings.push(...selectors);
      return stubs;
    },
    queueError(...selectors) {
      errors.push(...selectors);
      return stubs;
    },
    queueOpenDialog(...results) {
      openDialogs.push(...results);
      return stubs;
    },
    queueSaveDialog(...results) {
      saveDialogs.push(...results);
      return stubs;
    },
    restore() {
      if (restored) return;
      restored = true;
      Object.assign(mutWindow, original);
    },
  };
  return stubs;
}
