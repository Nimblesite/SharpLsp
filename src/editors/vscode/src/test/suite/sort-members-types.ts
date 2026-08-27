// Shared live explorer contracts for [SE-CONTEXT-SORT-IMPLEMENTATION].
import type * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface TreeNode extends vscode.TreeItem {
  readonly nodeType: string;
  readonly children: TreeNode[];
  readonly sortName: string;
  readonly symbolKind?: string;
  readonly symbolUri?: string;
  readonly symbolRange?: LspRange;
  readonly parent?: TreeNode;
}

export interface ExplorerProvider {
  refresh(): Promise<void>;
  getChildren(element?: TreeNode): TreeNode[] | undefined;
}

export interface ExtensionApi {
  readonly explorerProvider: ExplorerProvider;
  readonly getLspClient: () => LanguageClient | undefined;
}

export interface SavedSettings {
  readonly hierarchy: string[] | undefined;
  readonly accessibilityOrder: string[] | undefined;
  readonly categoryOrder: string[] | undefined;
}

export interface SortPolicy {
  readonly hierarchy: readonly string[];
  readonly accessibilityOrder: readonly string[];
  readonly categoryOrder: readonly string[];
}

export interface SortOutcome {
  readonly beforeText: string;
  readonly beforeVersion: number;
  readonly afterText: string;
  readonly afterVersion: number;
}

export interface SurfaceCase {
  readonly typeName: string;
  readonly kinds: readonly string[];
  readonly contexts: readonly string[];
  readonly initial: readonly string[];
  readonly expected: readonly string[];
  readonly anchors: Readonly<Record<string, string>>;
  readonly validateSorted?: (text: string) => void;
}
