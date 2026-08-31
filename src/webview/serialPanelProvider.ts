import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { ConnectionManager, DEFAULT_PORT_CONFIG, PortConfig } from '../serial/connectionManager';
import { asciiStringToBytes, hexStringToBytes } from '../serial/format';
import { createSerialTerminal, SerialTerminal, TerminalColors } from '../serial/pseudoterminal';
import { SendFormat, TemplateStore } from '../templates/templateStore';

const REFRESH_DEBOUNCE_MS = 150;
const DEFAULT_TX_COLOR = '#00cccc';
const DEFAULT_RX_COLOR = '#33cc33';
const WORKSPACE_FOLDER_TOKEN = '${workspaceFolder}';
const DEFAULT_SAVE_LOG_AT = `${WORKSPACE_FOLDER_TOKEN}/serial_logs`;
/** `context.globalState` keys — global (not workspace) scope because physical device paths are
 * machine-specific, not tied to any one workspace; local-only by default (no `setKeysForSync`
 * call), so this introduces no new sync/cloud exposure of session data. */
const SESSION_ORDER_KEY = 'serialPort.sessionOrder';
const CLOSED_META_KEY = 'serialPort.closedMeta';

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
  | { type: 'updateSessionSetting'; path: string; field: 'dataBits' | 'parity' | 'stopBits'; value: string }
  | { type: 'setCheckbox'; path: string; checkbox: SessionCheckbox; value: boolean }
  | { type: 'addTemplate'; name: string; format: SendFormat; data: string }
  | { type: 'updateTemplate'; id: string; name: string; format: SendFormat; data: string }
  | { type: 'deleteTemplate'; id: string }
  | { type: 'sendTemplate'; id: string; path?: string }
  | { type: 'browseLogFolder' }
  | { type: 'clearLogFolder' }
  | { type: 'openLogFile'; uri: string | undefined };

/** Snapshot of a session's settings taken the moment its port closes (by any cause), so a
 * session card can survive the close and be reopened without losing its configuration. */
interface StoredSessionMeta {
  config: PortConfig;
  hexSend: boolean;
  hexRecv: boolean;
  showTimestamp: boolean;
  rts: boolean;
  dtr: boolean;
  /** Whether "Record to File" was checked — kept independent of `connected` so it can be set (and
   * shown checked) while the port is closed; only takes effect once the port is opened again. */
  recording: boolean;
  logFilePath: string | undefined;
  /** Full `Uri.toString()` of the log file (scheme + authority preserved), used to reopen the
   * SAME file on a reopen with recording already on, and to open it losslessly on a remote
   * workspace — see `logFilePath`, which is display-only and lossy for that purpose. */
  logFileUri: string | undefined;
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
  logFileUri: string | undefined;
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
  saveLogAt: string;
  saveLogAtIsCustom: boolean;
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
  /** User-configurable TX/RX terminal colors, passed by reference into every open terminal so a
   * change here is visible live without reopening the port — see `TerminalColors`. Populated from
   * (and kept in sync with) `serialPort.txColor`/`serialPort.rxColor`, but the object itself is
   * never reassigned. */
  private readonly terminalColors: TerminalColors = { tx: DEFAULT_TX_COLOR, rx: DEFAULT_RX_COLOR };
  private ports: { path: string; description: string }[] = [];
  /** Paths ever added via the "+" button, in add-order. A session card renders for every entry
   * here regardless of whether its port is currently open — see `closedMeta` below. */
  private sessionOrder: string[] = [];
  /** Settings snapshot for a session whose port is currently closed, so the card can still show
   * (and reopen with) its last-known config/hex/log state. */
  private readonly closedMeta = new Map<string, StoredSessionMeta>();
  /** Paths currently mid-`openPath` — guards a second `togglePort`/`addPort` message for the same
   * path from re-running the whole open sequence (creating a duplicate terminal, re-asserting
   * RTS/DTR twice) while the first call's `connections.open()` is still in flight. */
  private readonly openingPaths = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connections: ConnectionManager,
    private readonly templates: TemplateStore,
    private readonly terminals: Map<string, SerialTerminal>,
    private readonly defaultStorageUri: vscode.Uri,
    private readonly globalState: vscode.Memento,
  ) {
    this.sessionOrder = this.globalState.get<string[]>(SESSION_ORDER_KEY, []);
    const storedMeta = this.globalState.get<Record<string, StoredSessionMeta>>(CLOSED_META_KEY, {});
    for (const [path, meta] of Object.entries(storedMeta)) {
      this.closedMeta.set(path, meta);
    }
    // Every persisted session gets its terminal recreated immediately on activation — not lazily on
    // first open — so a session that's currently closed still has a terminal present right away.
    for (const path of this.sessionOrder) {
      this.getOrCreateTerminal(path);
    }
    this.subscriptions.push(connections.onDidChange(() => this.scheduleStateRefresh()));
    this.subscriptions.push(connections.onDidChange(() => this.syncTerminalConnections()));
    this.terminalColors.tx = this.config().get<string>('txColor', DEFAULT_TX_COLOR);
    this.terminalColors.rx = this.config().get<string>('rxColor', DEFAULT_RX_COLOR);
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('serialPort')) {
          return;
        }
        this.terminalColors.tx = this.config().get<string>('txColor', DEFAULT_TX_COLOR);
        this.terminalColors.rx = this.config().get<string>('rxColor', DEFAULT_RX_COLOR);
        this.postState();
      }),
    );
  }

  /** Reads the `serialPort.*` configuration section, merged across User/Workspace/Folder scope —
   * VS Code's own Settings UI and `settings.json` are how a user picks which scope to write to;
   * this panel's own controls always write to the User (Global) scope, see the handlers below. */
  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('serialPort');
  }

  private getDefaultConfig(): PortConfig {
    const config = this.config();
    return {
      baudRate: config.get<number>('defaultBaudRate', DEFAULT_PORT_CONFIG.baudRate),
      dataBits: config.get<PortConfig['dataBits']>('defaultDataBits', DEFAULT_PORT_CONFIG.dataBits),
      parity: config.get<PortConfig['parity']>('defaultParity', DEFAULT_PORT_CONFIG.parity),
      stopBits: config.get<PortConfig['stopBits']>('defaultStopBits', DEFAULT_PORT_CONFIG.stopBits),
    };
  }

  private getDefaultHexSend(): boolean {
    return this.config().get<boolean>('defaultHexSend', false);
  }

  private getDefaultHexRecv(): boolean {
    return this.config().get<boolean>('defaultHexRecv', false);
  }

  /** Persists `sessionOrder`/`closedMeta` to `globalState` so both survive an extension-host
   * restart (window reload, VS Code update, crash) instead of being wiped every time. */
  private persistSessions(): void {
    void this.globalState.update(SESSION_ORDER_KEY, this.sessionOrder);
    void this.globalState.update(CLOSED_META_KEY, Object.fromEntries(this.closedMeta));
  }

  /** Builds a `closedMeta` snapshot for a session that has no live connection to read from —
   * either because it just closed (in which case fresh values are passed) or because its very
   * first open attempt failed (in which case `previous`, if any, is reused so a retry doesn't
   * lose settings the user already edited on this card before the failed open). */
  private buildFallbackMeta(config: PortConfig, previous: StoredSessionMeta | undefined): StoredSessionMeta {
    return {
      config,
      hexSend: previous?.hexSend ?? this.getDefaultHexSend(),
      hexRecv: previous?.hexRecv ?? this.getDefaultHexRecv(),
      showTimestamp: previous?.showTimestamp ?? false,
      rts: previous?.rts ?? false,
      dtr: previous?.dtr ?? false,
      recording: previous?.recording ?? false,
      logFilePath: previous?.logFilePath,
      logFileUri: previous?.logFileUri,
      stats: previous?.stats ?? { bytesSent: 0, bytesReceived: 0 },
    };
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
        void this.updateDefaultSetting(message.field, message.value);
        break;
      case 'updateDefaultCheckbox':
        void this.config()
          .update(
            message.checkbox === 'hexSend' ? 'defaultHexSend' : 'defaultHexRecv',
            message.value,
            vscode.ConfigurationTarget.Global,
          )
          .then(
            () => this.postState(),
            (err) => vscode.window.showErrorMessage(`Failed to update setting: ${errorMessage(err)}`),
          );
        break;
      case 'updateTerminalColor':
        void this.config()
          .update(message.which === 'tx' ? 'txColor' : 'rxColor', message.value, vscode.ConfigurationTarget.Global)
          .then(
            () => {
              this.terminalColors[message.which] = message.value;
              this.postState();
            },
            (err) => vscode.window.showErrorMessage(`Failed to update terminal color: ${errorMessage(err)}`),
          );
        break;
      case 'updateSessionBaudRate':
        void this.updateSessionBaudRate(message.path, message.baudRate);
        break;
      case 'updateSessionSetting':
        this.updateSessionSetting(message.path, message.field, message.value);
        break;
      case 'setCheckbox':
        this.setCheckbox(message.path, message.checkbox, message.value);
        break;
      case 'addTemplate':
        void this.templates
          .add({ name: message.name, format: message.format, data: message.data })
          .then(
            () => this.postState(),
            (err) => vscode.window.showErrorMessage(`Failed to save template: ${errorMessage(err)}`),
          );
        break;
      case 'updateTemplate':
        void this.templates
          .update(message.id, { name: message.name, format: message.format, data: message.data })
          .then(
            () => this.postState(),
            (err) => vscode.window.showErrorMessage(`Failed to save template: ${errorMessage(err)}`),
          );
        break;
      case 'deleteTemplate':
        void this.templates
          .remove(message.id)
          .then(
            () => this.postState(),
            (err) => vscode.window.showErrorMessage(`Failed to delete template: ${errorMessage(err)}`),
          );
        break;
      case 'sendTemplate':
        void this.sendTemplate(message.id, message.path);
        break;
      case 'browseLogFolder':
        void this.browseLogFolder();
        break;
      case 'clearLogFolder':
        void this.config()
          .update('saveLogAt', undefined, vscode.ConfigurationTarget.Global)
          .then(
            () => this.postState(),
            (err) => vscode.window.showErrorMessage(`Failed to reset log folder: ${errorMessage(err)}`),
          );
        break;
      case 'openLogFile':
        if (!message.uri) {
          vscode.window.showInformationMessage(
            'The log file has not been created yet — it is created once the port is opened while Record to File is checked.',
          );
          break;
        }
        void vscode.window
          .showTextDocument(vscode.Uri.parse(message.uri))
          .then(undefined, (err) => vscode.window.showErrorMessage(`Failed to open log file: ${errorMessage(err)}`));
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
      this.persistSessions();
    }
    this.getOrCreateTerminal(path);
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

  /** Removes a session for good: closes the port if open, strips its persisted state, and — unless
   * `disposeTerminal` is explicitly false — disposes its terminal too. The "Remove" button in the
   * panel always disposes (the default); `getOrCreateTerminal`'s `onDidUserClose` subscription
   * passes `disposeTerminal: false` since the terminal is already being torn down by VS Code itself
   * (or by our own `dispose()`) at that point — calling `dispose()` again would be redundant. */
  private async removeSession(path: string, opts: { disposeTerminal?: boolean } = {}): Promise<void> {
    const disposeTerminal = opts.disposeTerminal ?? true;
    if (this.connections.isOpen(path)) {
      await this.connections.close(path);
    }
    this.sessionOrder = this.sessionOrder.filter((p) => p !== path);
    this.closedMeta.delete(path);
    this.persistSessions();
    if (disposeTerminal) {
      const terminal = this.terminals.get(path);
      terminal?.dispose();
      this.terminals.delete(path);
    }
    this.postState();
  }

  /** Returns the session's persistent terminal, creating it (in the disconnected state) if this is
   * the first time this path has needed one. A session's terminal survives for as long as the
   * session itself exists in the panel — see the module-level design note in `pseudoterminal.ts`. */
  private getOrCreateTerminal(path: string): SerialTerminal {
    const existing = this.terminals.get(path);
    if (existing) {
      return existing;
    }
    const terminal = createSerialTerminal(path, this.terminalColors);
    terminal.onDidUserClose(() => {
      if (this.sessionOrder.includes(path)) {
        void this.removeSession(path, { disposeTerminal: false });
      }
    });
    this.terminals.set(path, terminal);
    return terminal;
  }

  /** Opens (or reopens) a port, restoring its last-known config/hex settings if it was
   * previously added and closed, then attaches the terminal and a listener that snapshots
   * the session's state into `closedMeta` whenever it closes again, for any reason. */
  private async openPath(path: string): Promise<void> {
    if (this.connections.isOpen(path) || this.openingPaths.has(path)) {
      return;
    }
    this.openingPaths.add(path);
    const meta = this.closedMeta.get(path);
    const config = meta?.config ?? this.getDefaultConfig();
    try {
      const connection = await this.connections.open(path, config);
      connection.setHexSend(meta?.hexSend ?? this.getDefaultHexSend());
      connection.setHexRecv(meta?.hexRecv ?? this.getDefaultHexRecv());
      connection.setShowTimestamp(meta?.showTimestamp ?? false);
      // Always explicitly assert RTS/DTR (rather than only when they differ from the connection's
      // own field defaults) — the OS/driver may leave a freshly-opened port's lines in whatever
      // state it defaults to, which isn't necessarily the deasserted baseline these default to.
      await Promise.all([connection.setRTS(meta?.rts ?? false), connection.setDTR(meta?.dtr ?? false)]).catch(
        (err) => {
          vscode.window.showErrorMessage(`Failed to set RTS/DTR for ${path}: ${errorMessage(err)}`);
        },
      );
      connection.onDidClose(() => {
        this.closedMeta.set(path, {
          config: connection.config,
          hexSend: connection.hexSend,
          hexRecv: connection.hexRecv,
          showTimestamp: connection.showTimestamp,
          rts: connection.rts,
          dtr: connection.dtr,
          recording: connection.recording,
          logFilePath: connection.logFilePath,
          logFileUri: connection.logFileUri?.toString(),
          stats: { ...connection.stats },
        });
        this.persistSessions();
      });
      this.closedMeta.delete(path);
      this.persistSessions();
      if (meta?.recording) {
        // RF was already checked before this open (or survives from a prior open of the same
        // session) — reuse the same file (if one exists yet) rather than starting a new one, so a
        // close/reopen cycle with RF on keeps appending to a single file instead of fragmenting.
        connection.setRecording(
          true,
          this.resolveLogFolderUri(),
          meta.logFileUri ? vscode.Uri.parse(meta.logFileUri) : undefined,
        );
      }
      const terminal = this.getOrCreateTerminal(path);
      terminal.attach(connection);
      terminal.terminal.show(false);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to open ${path}: ${errorMessage(err)}`);
      if (!this.closedMeta.has(path)) {
        this.closedMeta.set(path, this.buildFallbackMeta(config, meta));
        this.persistSessions();
      }
    } finally {
      this.openingPaths.delete(path);
    }
    this.postState();
  }

  private async updateSessionBaudRate(path: string, baudRate: number): Promise<void> {
    const connection = this.connections.get(path);
    if (!connection) {
      const meta = this.closedMeta.get(path);
      if (meta) {
        meta.config = { ...meta.config, baudRate };
        this.persistSessions();
        this.postState();
      }
      return;
    }
    try {
      await connection.updateBaudRate(baudRate);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to change baud rate: ${errorMessage(err)}`);
    }
  }

  private updateSessionSetting(path: string, field: 'dataBits' | 'parity' | 'stopBits', value: string): void {
    const meta = this.closedMeta.get(path);
    if (!meta) {
      return;
    }
    const coerced = field === 'parity' ? (value as PortConfig['parity']) : Number(value);
    meta.config = { ...meta.config, [field]: coerced };
    this.persistSessions();
    this.postState();
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
    try {
      await this.config().update('saveLogAt', picked[0].fsPath, vscode.ConfigurationTarget.Global);
      this.postState();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to update log folder: ${errorMessage(err)}`);
    }
  }

  private async updateDefaultSetting(field: SettingField, value: string): Promise<void> {
    const configKey: Record<SettingField, string> = {
      baudRate: 'defaultBaudRate',
      dataBits: 'defaultDataBits',
      parity: 'defaultParity',
      stopBits: 'defaultStopBits',
    };
    const coerced = field === 'parity' ? value : Number(value);
    try {
      await this.config().update(configKey[field], coerced, vscode.ConfigurationTarget.Global);
      this.postState();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to update setting: ${errorMessage(err)}`);
    }
  }

  private resolveLogFolderUri(): vscode.Uri {
    const raw = this.config().get<string>('saveLogAt', DEFAULT_SAVE_LOG_AT).trim();
    const tokenIndex = raw.indexOf(WORKSPACE_FOLDER_TOKEN);
    if (tokenIndex !== -1) {
      // Uri.joinPath (not a fsPath string round-trip) so a `vscode-remote://wsl+...` workspace
      // folder URI keeps its scheme — this is what keeps the log file inside the WSL filesystem
      // rather than silently reinterpreting it as a local Windows path.
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.defaultStorageUri;
      const remainder = raw
        .slice(tokenIndex + WORKSPACE_FOLDER_TOKEN.length)
        .split(/[/\\]+/)
        .filter(Boolean);
      return vscode.Uri.joinPath(workspaceRoot, ...remainder);
    }
    return vscode.Uri.file(raw);
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
    // No live connection: remember the setting on the closed session so a later reopen (or, for
    // "record", the next actual open) picks it up. `record` maps to the `recording` field name.
    const meta = this.closedMeta.get(path);
    if (!meta) {
      return;
    }
    if (checkbox === 'record') {
      meta.recording = value;
    } else {
      meta[checkbox] = value;
    }
    this.persistSessions();
    this.postState();
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
      vscode.window.showWarningMessage(`${targetPath} is not open.`);
      return;
    }
    try {
      const bytes = template.format === 'hex' ? hexStringToBytes(template.data) : asciiStringToBytes(template.data);
      await connection.write(bytes);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to send template: ${errorMessage(err)}`);
    }
  }

  /** Detaches the terminal for any session whose connection is no longer open — a defensive
   * backstop; `PortConnection`'s own `onDidClose` already triggers the same terminal's internal
   * detach directly (see `pseudoterminal.ts`), so this mainly guards against any path that closed
   * without going through that subscription. Never disposes — the terminal itself survives for as
   * long as the session exists in the panel; see `removeSession` for the only path that disposes it. */
  private syncTerminalConnections(): void {
    for (const [path, terminal] of this.terminals) {
      if (!this.connections.isOpen(path)) {
        terminal.detach();
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
    const defaultConfig = this.getDefaultConfig();
    const defaultHexSend = this.getDefaultHexSend();
    const defaultHexRecv = this.getDefaultHexRecv();
    return {
      ports: this.ports,
      selectedPort: this.selectedPort,
      defaultConfig,
      defaultHexSend,
      defaultHexRecv,
      txColor: this.terminalColors.tx,
      rxColor: this.terminalColors.rx,
      saveLogAt: this.config().get<string>('saveLogAt', DEFAULT_SAVE_LOG_AT),
      saveLogAtIsCustom: this.config().get<string>('saveLogAt', DEFAULT_SAVE_LOG_AT).trim() !== DEFAULT_SAVE_LOG_AT,
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
            logFileUri: connection.logFileUri?.toString(),
            stats: connection.stats,
          };
        }
        const meta = this.closedMeta.get(path);
        return {
          path,
          connected: false,
          config: meta?.config ?? defaultConfig,
          hexSend: meta?.hexSend ?? defaultHexSend,
          hexRecv: meta?.hexRecv ?? defaultHexRecv,
          recording: meta?.recording ?? false,
          showTimestamp: meta?.showTimestamp ?? false,
          rts: meta?.rts ?? false,
          dtr: meta?.dtr ?? false,
          logFilePath: meta?.logFilePath,
          logFileUri: meta?.logFileUri,
          stats: meta?.stats ?? { bytesSent: 0, bytesReceived: 0 },
        };
      }),
      templates: this.templates.list(),
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'style.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'codicon.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'main.js'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${codiconUri}" rel="stylesheet">
<link href="${styleUri}" rel="stylesheet">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
