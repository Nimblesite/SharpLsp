import {
  languages,
  workspace,
  type CancellationToken,
  type DocumentSelector,
  type TextDocument,
} from 'vscode';
import { State, type MessageSignature, type Middleware } from 'vscode-languageclient/node';
import { Signal } from './signals.js';
import { delay, isRecord } from './utils.js';

/**
 * The longest a request waits for its document's `didOpen`. A safety valve only:
 * a document the client syncs settles in milliseconds, so this bounds nothing
 * but a document it never syncs, which then fails exactly as it would unheld.
 */
const OPEN_WAIT_LIMIT_MS = 10_000;

/** Which server is current, and which documents it has been sent. */
interface SyncState {
  readonly session: number;
  readonly synced: ReadonlySet<string>;
}

/** The request hold, and the hook that resets it for each fresh server. */
export interface OpenSync {
  readonly middleware: Pick<Middleware, 'didOpen' | 'didClose' | 'sendRequest'>;
  /** Forget every synced document once the client leaves `Running`. */
  observe(clientState: State): void;
}

/**
 * Hold each request about a document until the server has that document.
 * Implements [DIST-FAILURE-UX] rule 6: a restarted server must serve the
 * documents the user already has open.
 *
 * vscode-languageclient 10 opens only the documents shown in a tab when a
 * server starts. Every other open document is queued, the first outgoing
 * message flushes that queue one awaited write at a time, and a tab's own
 * `didOpen` waits behind the whole flush. A request VS Code sends in the
 * meantime - breadcrumbs, inlay hints, a symbol query - reaches the server
 * ahead of its document and fails, and VS Code caches that empty answer until
 * the document next changes.
 */
export function createOpenSync(selector: DocumentSelector): OpenSync {
  const state = new Signal<SyncState>({ session: 0, synced: new Set() });
  const record = (document: TextDocument, isSynced: boolean): void => {
    state.value = {
      session: state.value.session,
      synced: toggled(state.value.synced, document.uri.toString(), isSynced),
    };
  };
  const awaitsOpen = (uri: string): boolean =>
    !state.value.synced.has(uri) && isOpenIn(selector, uri);
  const opened = async (uri: string): Promise<void> => {
    const { session } = state.value;
    await settled(state, () => state.value.session !== session || !awaitsOpen(uri));
  };

  return {
    middleware: {
      // Only a didOpen the CURRENT server received counts. One that failed (its
      // connection closed under it) or that went to the server a restart has since
      // replaced would let a request through ahead of the re-open.
      didOpen: async (document, next) => {
        const { session } = state.value;
        await next(document);
        if (state.value.session === session) record(document, true);
      },
      didClose: async (document, next) => {
        record(document, false);
        await next(document);
      },
      async sendRequest<P, R>(
        type: string | MessageSignature,
        param: P | undefined,
        token: CancellationToken | undefined,
        next: (type: string | MessageSignature, param?: P, token?: CancellationToken) => Promise<R>,
      ): Promise<R> {
        const uri = requestDocumentUri(param);
        if (uri !== undefined && awaitsOpen(uri)) await opened(uri);
        return await next(type, param, token);
      },
    },
    observe: (clientState) => {
      if (clientState === State.Running) return;
      state.value = { session: state.value.session + 1, synced: new Set() };
    },
  };
}

/** `uris` with `uri` added or removed. */
function toggled(uris: ReadonlySet<string>, uri: string, present: boolean): ReadonlySet<string> {
  const next = new Set(uris);
  if (present) next.add(uri);
  else next.delete(uri);
  return next;
}

/** Whether VS Code has `uri` open as a document this client syncs. */
function isOpenIn(selector: DocumentSelector, uri: string): boolean {
  const document = workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri);
  return document !== undefined && languages.match(selector, document) > 0;
}

/** The document a request is about - its `textDocument.uri` - if it names one. */
function requestDocumentUri(param: unknown): string | undefined {
  const document = isRecord(param) ? param.textDocument : undefined;
  return isRecord(document) && typeof document.uri === 'string' ? document.uri : undefined;
}

/** Resolves once `done()` holds - re-checked on every change of `state` - or at the limit. */
async function settled(state: Signal<SyncState>, done: () => boolean): Promise<void> {
  const subscriptions: (() => void)[] = [];
  await Promise.race([
    new Promise<void>((resolve) => {
      subscriptions.push(
        state.subscribe(() => {
          if (done()) resolve();
        }),
      );
    }),
    delay(OPEN_WAIT_LIMIT_MS),
  ]);
  for (const unsubscribe of subscriptions) unsubscribe();
}
