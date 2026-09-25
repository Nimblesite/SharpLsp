/**
 * The active target framework of the focused document's project: a status-bar
 * item naming it, the `sharplsp.selectTargetFramework` pick that switches the
 * whole project, and a live view of both for the extension API. The server
 * owns the choice; this view re-reads it whenever the focused document changes,
 * the server announces a switch, or a read failed because the workspace was
 * still loading. Implements [NETFX-CONTEXT].
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { CMD_SELECT_TARGET_FRAMEWORK } from './constants.js';
import * as log from './log.js';
import { Signal, effect } from './signals.js';
import { getErrorMessage, isRecord } from './utils.js';

/** The server's announcement that a project's framework changed. */
const CHANGED = 'sharplsp/targetFrameworkChanged';

/** Languages whose projects can target several frameworks. */
const LANGUAGES: ReadonlySet<string> = new Set(['csharp', 'fsharp']);

/** Delays between reads while the workspace has not loaded the document yet. */
const RETRY_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];

/** What both `sharplsp/*TargetFramework` requests answer. */
interface FrameworkContext {
  readonly active: string | undefined;
  readonly available: readonly string[];
  readonly project: string | undefined;
}

/** The framework context of the focused document. */
interface Shown extends FrameworkContext {
  readonly uri: vscode.Uri;
}

/** The context of a document whose project targets several frameworks. */
type MultiTargeted = Shown & { readonly active: string };

/** What the extension wires: the API's live view, and the client hook-up. */
export interface TargetFrameworkUi {
  readonly status: TargetFrameworkStatus;
  /** Re-read on the server's announcement of a switch, and now the client is up. */
  readonly attach: (client: LanguageClient) => void;
}

/** The live view the extension API exposes. */
export interface TargetFrameworkStatus {
  readonly item: vscode.StatusBarItem;
  readonly visible: boolean;
  readonly active: string | undefined;
  readonly available: readonly string[];
}

/** Parse a reply; anything malformed reads as "nothing to choose between". */
function contextOf(reply: unknown): FrameworkContext {
  const record = isRecord(reply) ? reply : {};
  const available = Array.isArray(record.available) ? record.available : [];
  return {
    active: typeof record.active === 'string' ? record.active : undefined,
    available: available.filter((tfm): tfm is string => typeof tfm === 'string'),
    project: typeof record.project === 'string' ? record.project : undefined,
  };
}

/** A multi-targeted project shows the item; a single-target one hides it. */
function isVisible(shown: Shown | undefined): shown is MultiTargeted {
  return shown?.active !== undefined && shown.available.length > 0;
}

/** The pick's rows: every framework, in declared order, the active one marked. */
function pickItems(shown: MultiTargeted): vscode.QuickPickItem[] {
  return shown.available.map((tfm) =>
    tfm === shown.active ? { label: tfm, description: 'active', picked: true } : { label: tfm },
  );
}

/** The project's display name: its file name without the extension. */
function projectName(shown: Shown): string {
  return shown.project === undefined ? shown.uri.fsPath : path.parse(shown.project).name;
}

/** The focused document, when its language can be multi-targeted. */
function focusedDocument(): vscode.Uri | undefined {
  const document = vscode.window.activeTextEditor?.document;
  return document !== undefined && LANGUAGES.has(document.languageId) ? document.uri : undefined;
}

/** Keeps the status view in step with the server. */
class FrameworkView {
  private readonly shown = new Signal<Shown | undefined>(undefined);
  private generation = 0;
  private retry: NodeJS.Timeout | undefined;

  constructor(
    public readonly item: vscode.StatusBarItem,
    private readonly client: () => LanguageClient | undefined,
  ) {}

  public status(): TargetFrameworkStatus {
    const shown = this.shown;
    return {
      item: this.item,
      get visible() {
        return isVisible(shown.value);
      },
      get active() {
        return isVisible(shown.value) ? shown.value.active : undefined;
      },
      get available() {
        return isVisible(shown.value) ? shown.value.available : [];
      },
    };
  }

  /** Render the item from the current context, whenever it changes. */
  public render(): () => void {
    return effect(() => {
      const shown = this.shown.value;
      if (!isVisible(shown)) {
        this.item.hide();
        return;
      }
      this.item.text = `$(versions) ${shown.active}`;
      this.item.tooltip = `Target framework of ${projectName(shown)}: click to switch`;
      this.item.show();
    });
  }

  /** Re-read the focused document's context, retrying while the workspace loads. */
  public refresh(attempt = 0): void {
    clearTimeout(this.retry);
    const generation = ++this.generation;
    const uri = focusedDocument();
    if (uri === undefined) {
      this.shown.value = undefined;
      return;
    }
    void this.read(uri).then((context) => {
      if (generation !== this.generation) return;
      this.shown.value = context === undefined ? undefined : { ...context, uri };
      // No project compiles it YET while the workspace loads: read again.
      const delay = RETRY_MS[attempt];
      if (context?.project === undefined && delay !== undefined) {
        this.retry = setTimeout(() => {
          this.refresh(attempt + 1);
        }, delay);
      }
    });
  }

  /** Switch the focused document's project: to `tfm`, or to what the user picks. */
  public async select(tfm?: string): Promise<void> {
    const shown = await this.focused();
    if (!isVisible(shown)) {
      void vscode.window.showInformationMessage('This file belongs to a single-target project.');
      return;
    }
    const chosen = tfm ?? (await this.pick(shown));
    if (chosen === undefined) return;
    const switched = await this.send('sharplsp/setTargetFramework', shown.uri, chosen);
    if (switched !== undefined && this.shown.value?.uri.toString() === shown.uri.toString()) {
      this.shown.value = { ...switched, uri: shown.uri };
    }
  }

  /**
   * The focused document's context, read NOW: the item's last read may still
   * describe the editor focused before this one.
   */
  private async focused(): Promise<Shown | undefined> {
    const uri = focusedDocument();
    const context = uri === undefined ? undefined : await this.read(uri);
    const shown = uri === undefined || context === undefined ? undefined : { ...context, uri };
    this.shown.value = shown;
    return shown;
  }

  public dispose(): void {
    clearTimeout(this.retry);
  }

  private async pick(shown: MultiTargeted): Promise<string | undefined> {
    const placeHolder = `Target framework for ${projectName(shown)}`;
    return (await vscode.window.showQuickPick(pickItems(shown), { placeHolder }))?.label;
  }

  private async read(uri: vscode.Uri): Promise<FrameworkContext | undefined> {
    return await this.send('sharplsp/targetFramework', uri);
  }

  private async send(
    method: string,
    uri: vscode.Uri,
    targetFramework?: string,
  ): Promise<FrameworkContext | undefined> {
    const client = this.client();
    if (client?.isRunning() !== true) return undefined;
    const textDocument = { uri: client.code2ProtocolConverter.asUri(uri) };
    const params =
      targetFramework === undefined ? { textDocument } : { textDocument, targetFramework };
    try {
      return contextOf(await client.sendRequest(method, params));
    } catch (err: unknown) {
      log.traceInfo(`${method} ${uri.toString()}: ${getErrorMessage(err)}`);
      return undefined;
    }
  }
}

/**
 * Register the status item and the pick command, and return the live view the
 * extension API exposes plus the hook that wires the server's announcement.
 */
export function registerTargetFramework(
  context: vscode.ExtensionContext,
  client: () => LanguageClient | undefined,
): TargetFrameworkUi {
  const item = vscode.window.createStatusBarItem(
    'sharplsp.targetFramework',
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.name = 'SharpLsp Target Framework';
  item.command = CMD_SELECT_TARGET_FRAMEWORK;
  const view = new FrameworkView(item, client);
  const stopRendering = view.render();
  context.subscriptions.push(
    item,
    view,
    { dispose: stopRendering },
    vscode.commands.registerCommand(CMD_SELECT_TARGET_FRAMEWORK, async (tfm?: unknown) => {
      await view.select(typeof tfm === 'string' ? tfm : undefined);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      view.refresh();
    }),
  );
  const attach = (lsp: LanguageClient): void => {
    lsp.onNotification(CHANGED, () => {
      view.refresh();
    });
    view.refresh();
  };
  return { status: view.status(), attach };
}
