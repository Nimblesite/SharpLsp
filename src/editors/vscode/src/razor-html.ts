// Implements [RAZOR-FEATURES-HTML] and [RAZOR-EDITORS]. HTML completion and hover in
// Razor markup come from VS Code's built-in HTML language service, which reads the
// server's HTML projection of the Razor file: the same text with every non-HTML
// character blanked, so a Razor position is the same position in the projection.
// This follows VS Code's request-forwarding pattern for embedded languages:
// https://code.visualstudio.com/api/language-extensions/embedded-languages
import {
  CompletionList,
  Uri,
  commands,
  workspace,
  type CompletionItem,
  type Disposable,
  type Hover,
  type Position,
  type TextDocument,
} from 'vscode';
import { State, type LanguageClient, type Middleware } from 'vscode-languageclient/node';
import * as log from './log.js';
import { getErrorMessage, isRecord } from './utils.js';

/** Razor's language ids: VS Code's built-in `razor`, and the C# extension's own. */
export const RAZOR_LANGUAGES: readonly string[] = ['razor', 'aspnetcorerazor'];

/** The scheme of the projections the HTML service reads. */
const PROJECTION_SCHEME = 'sharplsp-razor-html';

/** The server request that answers a Razor document's HTML projection. */
const PROJECTION_REQUEST = 'sharplsp/razor/htmlProjection';

/** The server's HTML projection of the document at `uri`; undefined when it has none. */
export type ProjectionSource = (uri: string) => Promise<string | undefined>;

/**
 * Projections from the running server. A server that cannot project the document
 * answers null; one that fails is logged and treated the same, so the server's own
 * completion and hover answers still reach the editor.
 */
export function serverProjection(client: () => LanguageClient | undefined): ProjectionSource {
  return async (uri) => {
    const running = client();
    if (running?.state !== State.Running) return undefined;
    try {
      const answer: unknown = await running.sendRequest(PROJECTION_REQUEST, {
        textDocument: { uri },
      });
      return isRecord(answer) && typeof answer.text === 'string' ? answer.text : undefined;
    } catch (error) {
      log.warn(`Razor HTML projection failed for ${uri}: ${getErrorMessage(error)}`);
      return undefined;
    }
  };
}

/** The forwarding middleware, and the provider that serves the projections. */
export interface RazorHtml {
  readonly middleware: Pick<Middleware, 'provideCompletionItem' | 'provideHover'>;
  readonly provider: Disposable;
}

/** What a completion provider answers. */
type Completions = CompletionItem[] | CompletionList | null | undefined;

/**
 * The HTML forwarding for Razor documents. The server answers first; HTML completion
 * items are appended to its own, and an HTML hover answers only when the server has none.
 */
export function createRazorHtml(source: ProjectionSource): RazorHtml {
  // Each Razor document's latest projection, by the projection's address.
  const projections = new Map<string, { readonly address: string; readonly text: string }>();
  const provider = workspace.registerTextDocumentContentProvider(PROJECTION_SCHEME, {
    provideTextDocumentContent: (uri) =>
      [...projections.values()].find((entry) => entry.address === uri.toString())?.text ?? '',
  });
  const project = async (document: TextDocument): Promise<Uri | undefined> => {
    const text = await source(document.uri.toString());
    if (text === undefined) return undefined;
    const uri = projectionUri(document);
    projections.set(document.uri.toString(), { address: uri.toString(), text });
    return uri;
  };
  return { middleware: forwardingMiddleware(project), provider };
}

/** The middleware that adds the HTML service's answers to the server's. */
function forwardingMiddleware(
  project: (document: TextDocument) => Promise<Uri | undefined>,
): RazorHtml['middleware'] {
  return {
    provideCompletionItem: async (document, position, context, token, next) => {
      const own = await next(document, position, context, token);
      if (!isRazor(document)) return own;
      const uri = await project(document);
      return uri === undefined
        ? own
        : appended(own, await htmlCompletions(uri, position, context.triggerCharacter));
    },
    provideHover: async (document, position, token, next) => {
      const own = await next(document, position, token);
      if (own !== null && own !== undefined) return own;
      const uri = isRazor(document) ? await project(document) : undefined;
      return uri === undefined ? own : await htmlHover(uri, position);
    },
  };
}

/** Whether `document` is a Razor file. */
function isRazor(document: TextDocument): boolean {
  return RAZOR_LANGUAGES.includes(document.languageId);
}

/**
 * The projection's address: an `.html` path, so VS Code reads it as HTML, carrying the
 * Razor URI it projects and the version it projects, so no answer reads stale text.
 */
function projectionUri(document: TextDocument): Uri {
  return Uri.from({
    scheme: PROJECTION_SCHEME,
    path: `/${encodeURIComponent(document.uri.toString())}.html`,
    query: `v=${document.version.toString()}`,
  });
}

/** The HTML service's completion items at `position` in the projection. */
async function htmlCompletions(
  uri: Uri,
  position: Position,
  trigger: string | undefined,
): Promise<CompletionItem[]> {
  const list = await commands.executeCommand<CompletionList | undefined>(
    'vscode.executeCompletionItemProvider',
    uri,
    position,
    trigger,
  );
  return list?.items ?? [];
}

/** The HTML service's hover at `position` in the projection, if it has one. */
async function htmlHover(uri: Uri, position: Position): Promise<Hover | undefined> {
  const hovers = await commands.executeCommand<Hover[] | undefined>(
    'vscode.executeHoverProvider',
    uri,
    position,
  );
  return hovers?.[0];
}

/** The server's items first, then `extra`, keeping the server's incompleteness. */
function appended(own: Completions, extra: CompletionItem[]): CompletionList {
  const items = Array.isArray(own) ? own : (own?.items ?? []);
  const incomplete = !Array.isArray(own) && own?.isIncomplete === true;
  return new CompletionList([...items, ...extra], incomplete);
}
