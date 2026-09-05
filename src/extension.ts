import * as vscode from 'vscode';
import { SeverityDecorator } from './editor/severityDecorator';
import { ConnectionManager } from './serial/connectionManager';
import { SerialTerminal } from './serial/pseudoterminal';
import { TemplateStore } from './templates/templateStore';
import { SerialPanelProvider } from './webview/serialPanelProvider';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager();
  const templates = new TemplateStore();
  const terminals = new Map<string, SerialTerminal>();
  const panelProvider = new SerialPanelProvider(
    context.extensionUri,
    connections,
    templates,
    terminals,
    context.globalStorageUri,
    context.globalState,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('serialPortExplorer', panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    panelProvider,
    connections,
    // Colours the level token in any open recorded log from serialPort.severityColors. Independent
    // of whether a port is open — the whole point is reading a log after the fact.
    new SeverityDecorator(),
    { dispose: () => terminals.forEach((terminal) => terminal.dispose()) },
  );
}

export function deactivate(): void {}
