// Implements [TUTORIAL-PANEL]: one webview beside the editor, a live projection of progress.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { effect, Signal } from '../signals.js';
import { isRecord } from '../utils.js';
import { type PanelView, panelView } from './panel-view.js';
import { progress } from './progress.js';
import { FILM_ORIGIN, type LanguageKind, LANGUAGES } from './steps.js';

const VIEW_TYPE = 'sharplsp.tutorial';
const TITLE = 'SharpLsp Tutorial';

/** The panel's handle, and the test seam onto what it shows. */
export interface TutorialPanel {
  open(language: LanguageKind): void;
  /** What the panel shows now, or `undefined` while it is closed. */
  view(): PanelView | undefined;
  /** The panel's HTML, or `undefined` while it is closed. */
  html(): string | undefined;
}

function shellHtml(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString();
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `media-src ${FILM_ORIGIN}`,
    `img-src ${FILM_ORIGIN}`,
  ].join('; ');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}"><title>${TITLE}</title></head>
<body><nav id="languages"></nav><h1 id="title"></h1><p id="instruction"></p>
<button id="open-file" hidden>Open one for me</button>
<div id="film"></div><p id="offline" hidden>The film could not load. Follow the instruction above.</p>
<ol id="steps"></ol><script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function languageOf(message: Record<string, unknown>): LanguageKind | undefined {
  return LANGUAGES.find((kind) => kind === message.language);
}

/** The panel, created on first `open` and recreated after the user closes it. */
class TutorialPanelHost implements TutorialPanel {
  private readonly language = new Signal<LanguageKind>('FSharp');
  private readonly media: vscode.Uri;
  private panel: vscode.WebviewPanel | undefined;
  private shown: PanelView | undefined;

  constructor(
    extensionUri: vscode.Uri,
    private readonly openFile: (language: LanguageKind) => void,
  ) {
    this.media = vscode.Uri.joinPath(extensionUri, 'media', 'tutorial');
  }

  public open(language: LanguageKind): void {
    this.language.value = language;
    this.panel ??= this.create();
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  public view(): PanelView | undefined {
    return this.shown;
  }

  public html(): string | undefined {
    return this.panel?.webview.html;
  }

  private create(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      TITLE,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.media] },
    );
    panel.webview.html = shellHtml(panel.webview, this.media);
    const stop = effect(() => {
      this.post(panel, panelView(progress.value, this.language.value));
    });
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => {
      this.onMessage(message);
    });
    panel.onDidDispose(() => {
      stop();
      listener.dispose();
      this.panel = undefined;
      this.shown = undefined;
    });
    return panel;
  }

  private post(panel: vscode.WebviewPanel, view: PanelView): void {
    this.shown = view;
    void panel.webview.postMessage({ type: 'view', view });
  }

  private onMessage(message: unknown): void {
    if (!isRecord(message)) return;
    if (message.type === 'ready' && this.panel !== undefined && this.shown !== undefined) {
      this.post(this.panel, this.shown);
    }
    if (message.type === 'language')
      this.language.value = languageOf(message) ?? this.language.value;
    if (message.type === 'openFile') this.openFile(this.language.value);
  }
}

export function createTutorialPanel(
  context: vscode.ExtensionContext,
  openFile: (language: LanguageKind) => void,
): TutorialPanel {
  return new TutorialPanelHost(context.extensionUri, openFile);
}
