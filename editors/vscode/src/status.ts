import {
  type Disposable,
  StatusBarAlignment,
  type StatusBarItem,
  ThemeColor,
  window,
} from 'vscode';
import { EXTENSION_NAME, CMD_RESTART_SERVER } from './constants.js';

export const enum ServerState {
  Starting = 'starting',
  Running = 'running',
  Stopped = 'stopped',
  Error = 'error',
}

const ICONS: Record<ServerState, string> = {
  [ServerState.Starting]: '$(loading~spin)',
  [ServerState.Running]: '$(flame)',
  [ServerState.Stopped]: '$(circle-outline)',
  [ServerState.Error]: '$(error)',
};

const TOOLTIPS: Record<ServerState, string> = {
  [ServerState.Starting]: `${EXTENSION_NAME}: Starting…`,
  [ServerState.Running]: `${EXTENSION_NAME}: Running — click to restart`,
  [ServerState.Stopped]: `${EXTENSION_NAME}: Stopped`,
  [ServerState.Error]: `${EXTENSION_NAME}: Error — click to restart`,
};

const COLORS: Record<ServerState, ThemeColor | undefined> = {
  [ServerState.Starting]: new ThemeColor('statusBarItem.warningForeground'),
  [ServerState.Running]: undefined,
  [ServerState.Stopped]: new ThemeColor('disabledForeground'),
  [ServerState.Error]: new ThemeColor('statusBarItem.errorForeground'),
};

export class ForgeStatusBar implements Disposable {
  private readonly item: StatusBarItem;

  constructor() {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 100);
    this.item.command = CMD_RESTART_SERVER;
    this.setState(ServerState.Starting);
    this.item.show();
  }

  public setState(state: ServerState): void {
    this.item.text = `${ICONS[state]} ${EXTENSION_NAME}`;
    this.item.tooltip = TOOLTIPS[state];
    this.item.color = COLORS[state];
  }

  public dispose(): void {
    this.item.dispose();
  }
}
