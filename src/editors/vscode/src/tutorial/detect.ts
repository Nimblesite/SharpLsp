// Implements [TUTORIAL-DETECT-LSP]: a step ticks only on SharpLsp's real, meaningful answer.
import { workspace, type CancellationToken } from 'vscode';
import type { MessageSignature, Middleware } from 'vscode-languageclient/node';
import * as log from '../log.js';
import { requestDocumentUri } from '../open-sync.js';
import { getErrorMessage, isRecord } from '../utils.js';
import type { TutorialStep } from './model.generated.js';
import { record } from './progress.js';
import { type ActionKind, actionOfMethod, languageOfId, stepOf } from './steps.js';

/** The `sendRequest` middleware shape the client installs. */
export type SendRequest = NonNullable<Middleware['sendRequest']>;

/** Hover content that shows something: a non-empty string, value or list. */
function hasContent(contents: unknown): boolean {
  if (typeof contents === 'string') return contents.trim() !== '';
  if (Array.isArray(contents)) return contents.some(hasContent);
  return isRecord(contents) && hasContent(contents.value);
}

/** One location or a non-empty list of them. */
function hasLocations(result: unknown): boolean {
  return Array.isArray(result) ? result.length > 0 : isRecord(result);
}

function hasItems(result: unknown): boolean {
  if (Array.isArray(result)) return result.length > 0;
  return isRecord(result) && Array.isArray(result.items) && result.items.length > 0;
}

/** Whether `result` is an answer that shows the user something for `action`. */
export function isMeaningful(action: ActionKind, result: unknown): boolean {
  switch (action) {
    case 'Hover':
      return isRecord(result) && hasContent(result.contents);
    case 'Completion':
      return hasItems(result);
    case 'Definition':
    case 'References':
      return hasLocations(result);
    case 'OpenFile':
    case 'SolutionExplorer':
      return false;
  }
}

/** The step a response ticks, if any: a tracked method, a taught language, a meaningful answer. */
export function stepForResponse(
  method: string,
  languageId: string | undefined,
  result: unknown,
): TutorialStep | undefined {
  const action = actionOfMethod(method);
  const language = languageId === undefined ? undefined : languageOfId(languageId);
  if (action === undefined || language === undefined) return undefined;
  return isMeaningful(action, result) ? stepOf(language, action) : undefined;
}

function languageIdOf(param: unknown): string | undefined {
  const uri = requestDocumentUri(param);
  return workspace.textDocuments.find((document) => document.uri.toString() === uri)?.languageId;
}

/** Record the step a response ticks. Never throws: the response is the user's, not ours. */
function note(type: string | MessageSignature, param: unknown, result: unknown): void {
  try {
    const method = typeof type === 'string' ? type : type.method;
    const step = stepForResponse(method, languageIdOf(param), result);
    if (step !== undefined) record(step);
  } catch (error: unknown) {
    log.warn(`Tutorial could not observe a response: ${getErrorMessage(error)}`);
  }
}

/** `inner` (or the bare request), observing each response and returning it unchanged. */
export function observeResponses(inner?: SendRequest): SendRequest {
  return async <P, R>(
    type: string | MessageSignature,
    param: P | undefined,
    token: CancellationToken | undefined,
    next: (type: string | MessageSignature, param?: P, token?: CancellationToken) => Promise<R>,
  ): Promise<R> => {
    const result = await (inner === undefined
      ? next(type, param, token)
      : inner(type, param, token, next));
    note(type, param, result);
    return result;
  };
}
