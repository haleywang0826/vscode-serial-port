import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { ConnectionManager, DEFAULT_PORT_CONFIG, PortConfig } from '../serial/connectionManager';
import { asciiStringToBytes, hexStringToBytes } from '../serial/format';
import { createSerialTerminal, SerialTerminal, TerminalColors } from '../serial/pseudoterminal';
import { SendFormat, TemplateStore } from '../templates/templateStore';

const REFRESH_DEBOUNCE_MS = 150;
const LOG_FOLDER_KEY = 'serialPort.logFolder';
const TX_COLOR_KEY = 'serialPort.txColor';
const RX_COLOR_KEY = 'serialPort.rxColor';
const DEFAULT_TX_COLOR = '#00cccc';
const DEFAULT_RX_COLOR = '#33cc33';

type SettingField = 'baudRate' | 'dataBits' | 'parity' | 'stopBits';
type SessionCheckbox = 'hexSend' | 'hexRecv' | 'record' | 'showTimestamp' | 'rts' | 'dtr';
type DefaultCheckbox = 'hexSend' | 'hexRecv';
type TerminalColorKey = 'tx' | 'rx';

type ClientMessage =
  | { type: 'ready' }
  | { type: 'refreshPorts' }
  | { type: 'selectPort'; path: string }
  | { type: 'addPort' }
  | { type: 'togglePort'; path: string }
  | { type: 'removeSession'; path: string }
  | { type: 'updateDefaultSetting'; field: SettingField; value: string }
  | { type: 'updateDefaultCheckbox'; checkbox: DefaultCheckbox; value: boolean }
  | { type: 'updateTerminalColor'; which: TerminalColorKey; value: string }
  | { type: 'updateSessionBaudRate'; path: string; baudRate: number }
  | { type: 'setCheckbox'; path: string; checkbox: SessionCheckbox; value: boolean }
  | { type: 'addTemplate'; name: string; format: SendFormat; data: string }
  | { type: 'updateTemplate'; id: string; name: string; format: SendFormat; data: string }
  | { type: 'deleteTemplate'; id: string }
  | { type: 'sendTemplate'; id: string; path?: string }
  | { type: 'browseLogFolder' }
  | { type: 'clearLogFolder' }
  | { type: 'openLogFile'; path: string };

/** Snapshot of a session's settings taken the moment its port closes (by any cause), so a
 * session card can survive the close and be reopened without losing its configuration. */
interface StoredSessionMeta {
  config: PortConfig;
  hexSend: boolean;
  hexRecv: boolean;
  showTimestamp: boolean;
  rts: boolean;
  dtr: boolean;
  logFilePath: string | undefined;
  stats: { bytesSent: number; bytesReceived: number };
}

interface PanelSession {
  path: string;
  connected: boolean;
  config: PortConfig;
  hexSend: boolean;
  hexRecv: boolean;
  recording: boolean;
  showTimestamp: boolean;
  rts: boolean;
  dtr: boolean;
  logFilePath: string | undefined;
  stats: { bytesSent: number; bytesReceived: number };
}

interface PanelState {
  ports: { path: string; description: string }[];
  selectedPort: string | undefined;
  defaultConfig: PortConfig;
  defaultHexSend: boolean;
  defaultHexRecv: boolean;
  txColor: string;
  rxColor: string;
  logFolder: string;
  logFolderIsCustom: boolean;
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
  private defaultHexSend = false;
  private defaultHexRecv = false;
  /** User-configurable TX/RX terminal colors, passed by reference into every open terminal so a
   * change here is visible live without reopening the port — see `TerminalColors`. */
  private readonly terminalColors: TerminalColors = { tx: DEFAULT_TX_COLOR, rx: DEFAULT_RX_COLOR };
  private logFolderUri: vscode.Uri | undefined;
  private ports: { path: string; description: string }[] = [];
  /** Paths ever added via the "+" button, in add-order. A session card renders for every entry
   * here regardless of whether its port is currently open — see `closedMeta` below. */
  private sessionOrder: string[] = [];
  /** Settings snapshot for a session whose port is currently closed, so the card can still show
   * (and reopen with) its last-known config/hex/log state. */
  private readonly closedMeta = new Map<string, StoredSessionMeta>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connections: ConnectionManager,
    private readonly templates: TemplateStore,
    private readonly terminals: Map<string, SerialTerminal>,
    private readonly globalState: vscode.Memento,
    private readonly defaultStorageUri: vscode.Uri,
  ) {
    this.subscriptions.push(connections.onDidChange(() => this.scheduleStateRefresh()));
    this.subscriptions.push(connections.onDidChange(() => this.pruneClosedTerminals()));
    const storedLogFolder = globalState.get<string>(LOG_FOLDER_KEY);
    if (storedLogFolder) {
      this.logFolderUri = vscode.Uri.parse(storedLogFolder);
    }
    this.terminalColors.tx = globalState.get<string>(TX_COLOR_KEY) ?? DEFAULT_TX_COLOR;
    this.terminalColors.rx = globalState.get<string>(RX_COLOR_KEY) ?? DEFAULT_RX_COLOR;
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
      case 'addPort':
        void this.addPort();
        break;
      case 'togglePort':
        void this.togglePort(message.path);
        break;
      case 'removeSession':
        void this.removeSession(message.path);
        break;
      case 'updateDefaultSetting':
        this.defaultConfig = applySetting(this.defaultConfig, message.field, message.value);
        this.postState();
        break;
      case 'updateDefaultCheckbox':
        if (message.checkbox === 'hexSend') {
          this.defaultHexSend = message.value;
        } else {
          this.defaultHexRecv = message.value;
        }
        this.postState();
        break;
      case 'updateTerminalColor':
        this.terminalColors[message.which] = message.value;
        void this.globalState.update(message.which === 'tx' ? TX_COLOR_KEY : RX_COLOR_KEY, message.value);
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
      case 'browseLogFolder':
        void this.browseLogFolder();
        break;
      case 'clearLogFolder':
        this.logFolderUri = undefined;
        void this.globalState.update(LOG_FOLDER_KEY, undefined);
        this.postState();
        break;
      case 'openLogFile':
        void vscode.window.showTextDocument(vscode.Uri.file(message.path));
        break;
    }
  }

  private async refreshPorts(): Promise<void> {
    const list = await SerialPort.list();
    this.ports = list.map((port) => ({ path: port.path, description: port.manufacturer ?? port.pnpId ?? '' }));
    if (!this.ports.some((port) => port.path === this.selectedPort)) {
      this.selectedPort = this.ports[0]?.path;
    }
    this.postState();
  }

  private async addPort(): Promise<void> {
    const path = this.selectedPort;
    if (!path) {
      vscode.window.showInformationMessage('Select a port first.');
      return;
    }
    if (!this.sessionOrder.includes(path)) {
      this.sessionOrder.push(path);
    }
    if (this.connections.isOpen(path)) {
      vscode.window.showInformationMessage(`${path} is already open.`);
      this.postState();
      return;
    }
    await this.openPath(path);
  }

  private async togglePort(path: string): Promise<void> {
    if (this.connections.isOpen(path)) {
      await this.connections.close(path);
      this.postState();
    } else {
      await this.openPath(path);
    }
  }

  private async removeSession(path: string): Promise<void> {
    if (this.connections.isOpen(path)) {
      await this.connections.close(path);
    }
    this.sessionOrder = this.sessionOrder.filter((p) => p !== path);
    this.closedMeta.delete(path);
    this.postState();
  }

  /** Opens (or reopens) a port, restoring its last-known config/hex settings if it was
   * previously added and closed, then attaches the terminal and a listener that snapshots
   * the session's state into `closedMeta` whenever it closes again, for any reason. */
  private async openPath(path: string): Promise<void> {
    const meta = this.closedMeta.get(path);
    const config = meta?.config ?? this.defaultConfig;
    try {
      const connection = await this.connections.open(path, config);
      connection.setHexSend(meta?.hexSend ?? this.defaultHexSend);
      connection.setHexRecv(meta?.hexRecv ?? this.defaultHexRecv);
      connection.setShowTimestamp(meta?.showTimestamp ?? false);
      if (meta && (meta.rts !== connection.rts || meta.dtr !== connection.dtr)) {
        await Promise.all([connection.setRTS(meta.rts), connection.setDTR(meta.dtr)]).catch((err) => {
          vscode.window.showErrorMessage(`Failed to restore RTS/DTR for ${path}: ${errorMessage(err)}`);
        });
      }
      connection.onDidClose(() => {
        this.closedMeta.set(path, {
          config: connection.config,
          hexSend: connection.hexSend,
          hexRecv: connection.hexRecv,
          showTimestamp: connection.showTimestamp,
          rts: connection.rts,
          dtr: connection.dtr,
          logFilePath: connection.logFilePath,
          stats: { ...connection.stats },
        });
      });
      this.closedMeta.delete(path);
      const terminal = createSerialTerminal(connection, this.terminalColors);
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

  private async browseLogFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select Log Folder',
    });
    if (!picked || picked.length === 0) {
      return;
    }
    this.logFolderUri = picked[0];
    await this.globalState.update(LOG_FOLDER_KEY, this.logFolderUri.toString());
    this.postState();
  }

  private resolveLogFolderUri(): vscode.Uri {
    if (this.logFolderUri) {
      return this.logFolderUri;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.defaultStorageUri;
    return vscode.Uri.joinPath(workspaceRoot, 'serial logs');
  }

  private setCheckbox(path: string, checkbox: SessionCheckbox, value: boolean): void {
    const connection = this.connections.get(path);
    if (connection) {
      switch (checkbox) {
        case 'hexSend':
          connection.setHexSend(value);
          break;
        case 'hexRecv':
          connection.setHexRecv(value);
          break;
        case 'record':
          connection.setRecording(value, this.resolveLogFolderUri());
          break;
        case 'showTimestamp':
          connection.setShowTimestamp(value);
          break;
        case 'rts':
          void connection.setRTS(value).catch((err) => {
            vscode.window.showErrorMessage(`Failed to set RTS for ${path}: ${errorMessage(err)}`);
          });
          break;
        case 'dtr':
          void connection.setDTR(value).catch((err) => {
            vscode.window.showErrorMessage(`Failed to set DTR for ${path}: ${errorMessage(err)}`);
          });
          break;
      }
      return;
    }
    // No live connection: remember the setting on the closed session so a later reopen
    // picks it up. Recording only makes sense while connected, so it's ignored here.
    const meta = this.closedMeta.get(path);
    if (meta && checkbox !== 'record') {
      meta[checkbox] = value;
      this.postState();
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

  /** Tears down the terminal for any session whose connection is no longer open, whether it was
   * closed via the panel or the device was physically unplugged. */
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
      defaultHexSend: this.defaultHexSend,
      defaultHexRecv: this.defaultHexRecv,
      txColor: this.terminalColors.tx,
      rxColor: this.terminalColors.rx,
      logFolder: this.resolveLogFolderUri().fsPath,
      logFolderIsCustom: this.logFolderUri !== undefined,
      sessions: this.sessionOrder.map((path) => {
        const connection = this.connections.get(path);
        if (connection) {
          return {
            path,
            connected: true,
            config: connection.config,
            hexSend: connection.hexSend,
            hexRecv: connection.hexRecv,
            recording: connection.recording,
            showTimestamp: connection.showTimestamp,
            rts: connection.rts,
            dtr: connection.dtr,
            logFilePath: connection.logFilePath,
            stats: connection.stats,
          };
        }
        const meta = this.closedMeta.get(path);
        return {
          path,
          connected: false,
          config: meta?.config ?? this.defaultConfig,
          hexSend: meta?.hexSend ?? this.defaultHexSend,
          hexRecv: meta?.hexRecv ?? this.defaultHexRecv,
          recording: false,
          showTimestamp: meta?.showTimestamp ?? false,
          rts: meta?.rts ?? true,
          dtr: meta?.dtr ?? true,
          logFilePath: meta?.logFilePath,
          stats: meta?.stats ?? { bytesSent: 0, bytesReceived: 0 },
        };
      }),
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
