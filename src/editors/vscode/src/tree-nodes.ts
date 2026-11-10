/** The Solution Explorer's tree items and their icons. Implements [SE-TREE]. */
import { ThemeColor, ThemeIcon, TreeItem, type TreeItemCollapsibleState } from 'vscode';
import type { LspPosition, LspRange } from './state.js';

// ── Tree item types ──────────────────────────────────────────────

export const enum NodeType {
  Solution = 'solution',
  Project = 'project',
  Namespace = 'namespace',
  Symbol = 'symbol',
  DependencyFolder = 'dependencyFolder',
  NuGetPackage = 'nugetPackage',
  ProjectRef = 'projectRef',
  SolutionChoice = 'solutionChoice',
  Feedback = 'feedback',
}

/** A node in the solution explorer tree. */
export class ExplorerNode extends TreeItem {
  public readonly nodeType: NodeType;
  public children: ExplorerNode[] = [];
  public sortName = '';
  public access?: string | undefined;
  public projectFilePath?: string;
  public referenceName?: string;
  public symbolUri?: string;
  public symbolPosition?: LspPosition;
  public symbolKind?: string;
  public symbolRange?: LspRange;
  public parent?: ExplorerNode;

  constructor(label: string, nodeType: NodeType, collapsible: TreeItemCollapsibleState) {
    super(label, collapsible);
    this.nodeType = nodeType;
  }
}

// ── Icon mapping ─────────────────────────────────────────────────

type IconDef = readonly [icon: string, color: string];

const SYMBOL_ICONS: Record<string, IconDef> = {
  Class: ['symbol-class', 'symbolIcon.classForeground'],
  Struct: ['symbol-struct', 'symbolIcon.structForeground'],
  Interface: ['symbol-interface', 'symbolIcon.interfaceForeground'],
  Enum: ['symbol-enum', 'symbolIcon.enumeratorForeground'],
  EnumMember: ['symbol-enum-member', 'symbolIcon.enumeratorMemberForeground'],
  Method: ['symbol-method', 'symbolIcon.methodForeground'],
  Constructor: ['symbol-constructor', 'symbolIcon.constructorForeground'],
  Property: ['symbol-property', 'symbolIcon.propertyForeground'],
  Field: ['symbol-field', 'symbolIcon.fieldForeground'],
  Event: ['symbol-event', 'symbolIcon.eventForeground'],
  Namespace: ['symbol-namespace', 'symbolIcon.namespaceForeground'],
  Function: ['symbol-method', 'symbolIcon.functionForeground'],
  Constant: ['symbol-constant', 'symbolIcon.constantForeground'],
};

export function iconForKind(kind: string): ThemeIcon {
  const def = SYMBOL_ICONS[kind];
  if (def !== undefined) {
    return new ThemeIcon(def[0], new ThemeColor(def[1]));
  }
  return new ThemeIcon('symbol-misc');
}
