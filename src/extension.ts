import * as vscode from 'vscode';
import { ConnectionManager } from './serial/connectionManager';
import { SerialTerminal } from './serial/pseudoterminal';
import { TemplateStore } from './templates/templateStore';
import { SerialPanelProvider } from './webview/serialPanelProvider';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager();
  const templates = new TemplateStore(context.globalState);
  const terminals = new Map<string, SerialTerminal>();
  const panelProvider = new SerialPanelProvider(
    context.extensionUri,
    connections,
    templates,
    terminals,
    context.globalStorageUri,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('serialPortExplorer', panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    panelProvider,
    connections,
    { dispose: () => terminals.forEach((terminal) => terminal.dispose()) },
  );
}

export function deactivate(): void {}
