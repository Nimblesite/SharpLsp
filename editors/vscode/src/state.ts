import { State, type LanguageClient } from "vscode-languageclient/node";
import { Signal } from "./signals.js";
import * as log from "./log.js";
import { getErrorMessage } from "./utils.js";

// ── Sort order ──────────────────────────────────────────────────

export enum SortOrder {
  Natural = "natural",
  Alphabetical = "alphabetical",
  Accessibility = "accessibility",
}

export const SORT_CYCLE: Record<SortOrder, SortOrder> = {
  [SortOrder.Natural]: SortOrder.Alphabetical,
  [SortOrder.Alphabetical]: SortOrder.Accessibility,
  [SortOrder.Accessibility]: SortOrder.Natural,
};

// ── LSP response types ──────────────────────────────────────────

export interface WorkspaceSymbolsResponse {
  readonly projects: ProjectNode[];
}

export interface ProjectNode {
  readonly name: string;
  readonly path: string;
  readonly symbols: FileSymbol[];
}

export interface FileSymbol {
  readonly file: string;
  readonly symbols: SymbolNode[];
}

export interface SymbolNode {
  readonly name: string;
  readonly kind: string;
  readonly detail: string | null;
  readonly access: string | null;
  readonly range: LspRange;
  readonly children: SymbolNode[];
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

// ── Symbols state (discriminated union) ─────────────────────────

export type SymbolsState =
  | { readonly kind: "empty" }
  | { readonly kind: "loaded"; readonly response: WorkspaceSymbolsResponse }
  | { readonly kind: "error"; readonly message: string };

// ── Centralized reactive state ──────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

/** The active LSP language client. */
export const client = new Signal<LanguageClient | undefined>(undefined);

/** Path to the currently loaded .sln file. */
export const solutionPath = new Signal<string | undefined>(undefined);

/** Current sort order for the solution explorer tree. */
export const sortOrder = new Signal<SortOrder>(SortOrder.Natural);

/** Workspace symbols — empty, loaded, or error. */
export const symbolsState = new Signal<SymbolsState>({ kind: "empty" });

// ── Actions ─────────────────────────────────────────────────────

/** Cycle: natural -> alphabetical -> accessibility -> natural. */
export function cycleSortOrder(): void {
  const next = SORT_CYCLE[sortOrder.value];
  log.traceInfo(`Sort order: ${sortOrder.value} -> ${next}`);
  sortOrder.value = next;
}

/** Load a solution path and fetch workspace symbols. */
export async function loadSolution(slnPath: string): Promise<void> {
  log.traceInfo(`Loading solution into state: ${slnPath}`);
  solutionPath.value = slnPath;
  await refresh();
}

/** Clear all solution state. */
export function clear(): void {
  log.traceInfo("Clearing solution state");
  solutionPath.value = undefined;
  symbolsState.value = { kind: "empty" };
}

/** Refresh workspace symbols from the LSP server. */
export async function refresh(): Promise<void> {
  const lsp = client.value;
  const solution = solutionPath.value;
  if (lsp === undefined || solution === undefined) {
    log.traceInfo("Refresh skipped: no client or solution");
    symbolsState.value = { kind: "empty" };
    return;
  }

  log.traceInfo(`Refreshing workspace symbols for ${solution}`);
  await fetchWithRetry(lsp, solution);
}

// ── Internal ────────────────────────────────────────────────────

async function fetchWithRetry(
  lsp: LanguageClient,
  solution: string,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (await tryFetch(lsp, solution, attempt)) return;
    if (attempt < MAX_RETRIES) await delay(RETRY_DELAY_MS);
  }
  log.info("All workspace symbol retries exhausted");
  symbolsState.value = { kind: "error", message: "All retries exhausted" };
}

async function tryFetch(
  lsp: LanguageClient,
  solution: string,
  attempt: number,
): Promise<boolean> {
  if (lsp.state !== State.Running) {
    log.traceInfo(
      `LSP not running (state=${String(lsp.state)}), ` +
        `attempt ${String(attempt + 1)}/${String(MAX_RETRIES)}`,
    );
    return false;
  }

  try {
    const response = await lsp.sendRequest<WorkspaceSymbolsResponse>(
      "forge/workspaceSymbols", { solution },
    );
    logSymbolCounts(response);
    symbolsState.value = { kind: "loaded", response };
    return true;
  } catch (err: unknown) {
    return handleFetchError(err, attempt);
  }
}

function handleFetchError(err: unknown, attempt: number): boolean {
  const msg = getErrorMessage(err);
  if (isTransient(msg) && attempt < MAX_RETRIES) {
    log.traceInfo(
      `Transient failure (${String(attempt + 1)}/${String(MAX_RETRIES)}): ${msg}`,
    );
    return false;
  }
  log.info(`Failed to load workspace symbols: ${msg}`);
  symbolsState.value = { kind: "error", message: msg };
  return true;
}

function isTransient(message: string): boolean {
  return message.includes("disposed") || message.includes("connection");
}

function logSymbolCounts(response: WorkspaceSymbolsResponse): void {
  let count = 0;
  for (const project of response.projects) {
    for (const file of project.symbols) {
      count += file.symbols.length;
    }
  }
  log.traceInfo(
    `Symbols loaded: ${String(response.projects.length)} projects, ` +
      `${String(count)} top-level symbols`,
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
