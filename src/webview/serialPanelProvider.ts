import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { ConnectionManager, DEFAULT_PORT_CONFIG, PortConfig } from '../serial/connectionManager';
import { asciiStringToBytes, hexStringToBytes } from '../serial/format';
import { createSerialTerminal, SerialTerminal } from '../serial/pseudoterminal';
import { SendFormat, TemplateStore } from '../templates/templateStore';

const REFRESH_DEBOUNCE_MS = 150;

type SettingField = 'baudRate' | 'dataBits' | 'parity' | 'stopBits';
type SessionCheckbox = 'hexSend' | 'hexRecv' | 'record';

type ClientMessage =
  | { type: 'ready' }
  | { type: 'refreshPorts' }
  | { type: 'selectPort'; path: string }
  | { type: 'openPort' }
  | { type: 'closePort'; path: string }
  | { type: 'updateDefaultSetting'; field: SettingField; value: string }
  | { type: 'updateSessionBaudRate'; path: string; baudRate: number }
  | { type: 'setCheckbox'; path: string; checkbox: SessionCheckbox; value: boolean }
  | { type: 'addTemplate'; name: string; format: SendFormat; data: string }
  | { type: 'updateTemplate'; id: string; name: string; format: SendFormat; data: string }
  | { type: 'deleteTemplate'; id: string }
  | { type: 'sendTemplate'; id: string; path?: string };

interface PanelSession {
  path: string;
  config: PortConfig;
  hexSend: boolean;
  hexRecv: boolean;
  recording: boolean;
  stats: { bytesSent: number; bytesReceived: number };
}

interface PanelState {
  ports: { path: string; description: string }[];
  selectedPort: string | undefined;
  defaultConfig: PortConfig;
  sessions: PanelSession[];
  templates: ReturnType<TemplateStore['list']>;
}

/**
 * Renders the "Ports" activity bar view as a webview instead of a TreeView: a TreeItem can't
 * anchor a dropdown to its own row (QuickPick always opens as a floating overlay) or keep inline
 * buttons visible outside hover/focus. A webview's real <select>/<button> elements do both for free.
 */
export class SerialPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private selectedPort: string | undefined;
  private defaultConfig: PortConfig = { ...DEFAULT_PORT_CONFIG };
  private ports: { path: string; description: string }[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connections: ConnectionManager,
    private readonly templates: TemplateStore,
    private readonly terminals: Map<string, SerialTerminal>,
  ) {
    this.subscriptions.push(connections.onDidChange(() => this.scheduleStateRefresh()));
    this.subscriptions.push(connections.onDidChange(() => this.pruneClosedTerminals()));
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'webview')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: ClientMessage) => this.handleMessage(message));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshPorts();
      }
    });
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
    void this.refreshPorts();
  }

  private handleMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'ready':
        void this.refreshPorts();
        this.postState();
        break;
      case 'refreshPorts':
        void this.refreshPorts();
        break;
      case 'selectPort':
        this.selectedPort = message.path;
        this.postState();
        break;
      case 'openPort':
        void this.openSelectedPort();
        break;
      case 'closePort':
        void this.connections.close(message.path);
        break;
      case 'updateDefaultSetting':
        this.defaultConfig = applySetting(this.defaultConfig, message.field, message.value);
        this.postState();
        break;
      case 'updateSessionBaudRate':
        void this.updateSessionBaudRate(message.path, message.baudRate);
        break;
      case 'setCheckbox':
        this.setCheckbox(message.path, message.checkbox, message.value);
        break;
      case 'addTemplate':
        void this.templates
          .add({ name: message.name, format: message.format, data: message.data })
          .then(() => this.postState());
        break;
      case 'updateTemplate':
        void this.templates
          .update(message.id, { name: message.name, format: message.format, data: message.data })
          .then(() => this.postState());
        break;
      case 'deleteTemplate':
        void this.templates.remove(message.id).then(() => this.postState());
        break;
      case 'sendTemplate':
        void this.sendTemplate(message.id, message.path);
        break;
    }
  }

  private async refreshPorts(): Promise<void> {
    const list = await SerialPort.list();
    this.ports = list.map((port) => ({ path: port.path, description: port.manufacturer ?? port.pnpId ?? '' }));
    this.postState();
  }

  private async openSelectedPort(): Promise<void> {
    const path = this.selectedPort;
    if (!path) {
      vscode.window.showInformationMessage('Select a port first.');
      return;
    }
    if (this.connections.isOpen(path)) {
      vscode.window.showInformationMessage(`${path} is already open.`);
      return;
    }
    try {
      const connection = await this.connections.open(path, this.defaultConfig);
      const terminal = createSerialTerminal(connection);
      this.terminals.set(path, terminal);
      terminal.terminal.show(false);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to open ${path}: ${errorMessage(err)}`);
    }
    this.postState();
  }

  private async updateSessionBaudRate(path: string, baudRate: number): Promise<void> {
    const connection = this.connections.get(path);
    if (!connection) {
      return;
    }
    try {
      await connection.updateBaudRate(baudRate);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to change baud rate: ${errorMessage(err)}`);
    }
  }

  private setCheckbox(path: string, checkbox: SessionCheckbox, value: boolean): void {
    const connection = this.connections.get(path);
    if (!connection) {
      return;
    }
    switch (checkbox) {
      case 'hexSend':
        connection.setHexSend(value);
        break;
      case 'hexRecv':
        connection.setHexRecv(value);
        break;
      case 'record':
        connection.setRecording(value);
        break;
    }
  }

  private async sendTemplate(id: string, path?: string): Promise<void> {
    const template = this.templates.get(id);
    if (!template) {
      return;
    }
    const open = this.connections.list();
    if (open.length === 0) {
      vscode.window.showWarningMessage('No ports are open.');
      return;
    }
    const targetPath = path ?? open[0].path;
    const connection = this.connections.get(targetPath);
    if (!connection) {
      return;
    }
    try {
      const bytes = template.format === 'hex' ? hexStringToBytes(template.data) : asciiStringToBytes(template.data);
      await connection.write(bytes);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to send template: ${errorMessage(err)}`);
    }
  }

  /** Tears down the terminal for any session that closed without going through a closePort message
   * (e.g. the device was physically unplugged). */
  private pruneClosedTerminals(): void {
    for (const [path, terminal] of this.terminals) {
      if (!this.connections.isOpen(path)) {
        terminal.dispose();
        this.terminals.delete(path);
      }
    }
  }

  /** Coalesces bursts of connection updates (bytes in/out on a busy port) into one state push. */
  private scheduleStateRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.postState();
    }, REFRESH_DEBOUNCE_MS);
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({ type: 'state', state: this.buildState() });
  }

  private buildState(): PanelState {
    return {
      ports: this.ports,
      selectedPort: this.selectedPort,
      defaultConfig: this.defaultConfig,
      sessions: this.connections.list().map((connection) => ({
        path: connection.path,
        config: connection.config,
        hexSend: connection.hexSend,
        hexRecv: connection.hexRecv,
        recording: connection.recording,
        stats: connection.stats,
      })),
      templates: this.templates.list(),
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'main.js'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${styleUri}" rel="stylesheet">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function applySetting(config: PortConfig, field: SettingField, value: string): PortConfig {
  switch (field) {
    case 'baudRate':
      return { ...config, baudRate: Number(value) };
    case 'dataBits':
      return { ...config, dataBits: Number(value) as PortConfig['dataBits'] };
    case 'parity':
      return { ...config, parity: value as PortConfig['parity'] };
    case 'stopBits':
      return { ...config, stopBits: Number(value) as PortConfig['stopBits'] };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
