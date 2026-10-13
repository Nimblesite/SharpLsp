import * as vscode from 'vscode';

/** Record the external viewer handoff without launching the user's browser. */
export function recordExternalUrls(captured: vscode.Uri[] = []): {
  readonly captured: vscode.Uri[];
  restore(): void;
} {
  const original = Object.getOwnPropertyDescriptor(vscode.env, 'openExternal');
  Object.defineProperty(vscode.env, 'openExternal', {
    value: async (uri: vscode.Uri): Promise<boolean> => {
      captured.push(uri);
      return true;
    },
    configurable: true,
    writable: true,
  });
  return {
    captured,
    restore() {
      if (original !== undefined) Object.defineProperty(vscode.env, 'openExternal', original);
    },
  };
}
