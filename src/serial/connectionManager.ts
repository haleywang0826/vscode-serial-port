import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { formatBytes } from './format';

export type Parity = 'none' | 'even' | 'odd' | 'mark' | 'space';

export interface PortConfig {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: Parity;
  stopBits: 1 | 1.5 | 2;
}

export const DEFAULT_PORT_CONFIG: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
};

export interface PortStats {
  bytesSent: number;
  bytesReceived: number;
}

/** One TX/RX event: raw bytes plus the single timestamp computed for it, shared by the file log
 * and any live display so the two never disagree or compute it independently. */
export interface TrafficEvent {
  direction: 'TX' | 'RX';
  bytes: Uint8Array;
  timestamp: string;
}

const LOG_FLUSH_DEBOUNCE_MS = 300;
/** Once a segment file reaches this size, the next flush starts a fresh file instead of
 * continuing to grow the same buffer forever — `vscode.workspace.fs.writeFile` has no append
 * option (it always replaces full file contents), so the alternative is rewriting the *entire*
 * session's log on every flush, an unbounded and ever-growing cost. */
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ISO-8601 formatted in the system's local timezone with its offset (unlike
 * `Date.prototype.toISOString()`, which always renders UTC), e.g. "2026-08-29T14:23:01.123+08:00". */
function toLocalIsoString(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset}`
  );
}

/** Live handle to one open serial port: I/O, config, format toggles, counters, and optional recording. */
export class PortConnection {
  readonly path: string;
  config: PortConfig;
  hexSend = false;
  hexRecv = false;
  recording = false;
  showTimestamp = false;
  /** Both default deasserted (unchecked). RTS/DTR are electrically AC-coupled to many boards'
   * reset lines (the classic Arduino/ESP auto-reset circuit), so what resets the board is the
   * *transition*, not the level — checking then unchecking one of these is what pulses reset,
   * not merely having it checked. See `SerialPanelProvider.openPath`, which explicitly asserts
   * this deasserted state on every open rather than trusting the OS/driver's own default, so a
   * freshly-opened port always starts from a known, truly-deasserted baseline. */
  rts = false;
  dtr = false;
  readonly stats: PortStats = { bytesSent: 0, bytesReceived: 0 };

  private readonly port: SerialPort;
  private logFileUri: vscode.Uri | undefined;
  private logFolderUri: vscode.Uri | undefined;
  private logBuffer = '';
  private logFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private logFlushChain: Promise<void> = Promise.resolve();
  private logDirReady: Promise<void> = Promise.resolve();
  private controlLineChain: Promise<void> = Promise.resolve();

  private readonly onDidTrafficEmitter = new vscode.EventEmitter<TrafficEvent>();
  /** Fires for every TX (typed or template-sent) and RX event, so any live view always sees
   * everything that touches the wire, not just what it happened to write itself. */
  readonly onDidTraffic = this.onDidTrafficEmitter.event;

  private readonly onDidCloseEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.onDidCloseEmitter.event;

  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
  /** Fires on stats/config/checkbox changes so the tree can refresh this session's node. */
  readonly onDidUpdate = this.onDidUpdateEmitter.event;

  constructor(path: string, config: PortConfig) {
    this.path = path;
    this.config = config;
    this.port = new SerialPort({
      path,
      baudRate: config.baudRate,
      dataBits: config.dataBits,
      parity: config.parity,
      stopBits: config.stopBits,
      autoOpen: false,
    });

    this.port.on('data', (chunk: Buffer) => this.handleIncoming(chunk));
    this.port.on('close', () => this.onDidCloseEmitter.fire());
    this.port.on('error', (err) => {
      vscode.window.showErrorMessage(`Serial port ${path}: ${err.message}`);
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port.isOpen) {
        resolve();
        return;
      }
      this.port.close((err) => (err ? reject(err) : resolve()));
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.write(Buffer.from(bytes), (err) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const timestamp = toLocalIsoString(new Date());
        this.stats.bytesSent += bytes.length;
        this.appendLog('TX', bytes, timestamp);
        this.onDidTrafficEmitter.fire({ direction: 'TX', bytes, timestamp });
        this.onDidUpdateEmitter.fire();
        resolve();
      });
    });
  }

  /** Applies a new baud rate to the already-open port; other config fields require a reopen. */
  updateBaudRate(baudRate: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.update({ baudRate }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        this.config = { ...this.config, baudRate };
        this.onDidUpdateEmitter.fire();
        resolve();
      });
    });
  }

  setHexSend(value: boolean): void {
    this.hexSend = value;
    this.onDidUpdateEmitter.fire();
  }

  setHexRecv(value: boolean): void {
    this.hexRecv = value;
    this.onDidUpdateEmitter.fire();
  }

  setRecording(value: boolean, logFolderUri?: vscode.Uri): void {
    this.recording = value;
    if (value && logFolderUri) {
      this.logFolderUri = logFolderUri;
      this.logDirReady = (async () => {
        try {
          await vscode.workspace.fs.createDirectory(logFolderUri);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to create log folder: ${errorMessage(err)}`);
        }
      })();
      this.logFileUri = vscode.Uri.joinPath(logFolderUri, buildLogFileName(this.path));
      this.logBuffer = '';
    } else if (!value) {
      this.flushLogFile();
    }
    this.onDidUpdateEmitter.fire();
  }

  setShowTimestamp(value: boolean): void {
    this.showTimestamp = value;
    this.onDidUpdateEmitter.fire();
  }

  /** `SerialPort#set()` applies its own defaults to any flag not passed in a given call (not the
   * port's current state), so RTS and DTR must always be set together or one silently resets.
   * Calls are chained onto `controlLineChain` so two concurrent `setRTS`/`setDTR` calls can't each
   * read a stale snapshot of the other pin and race — the same serialization pattern `logFlushChain`
   * already uses below. */
  setRTS(value: boolean): Promise<void> {
    return this.queueControlLines({ rts: value });
  }

  setDTR(value: boolean): Promise<void> {
    return this.queueControlLines({ dtr: value });
  }

  private queueControlLines(patch: { rts?: boolean; dtr?: boolean }): Promise<void> {
    const next = this.controlLineChain.then(() => {
      const flags = { rts: patch.rts ?? this.rts, dtr: patch.dtr ?? this.dtr };
      return this.setControlLines(flags).then(() => {
        this.rts = flags.rts;
        this.dtr = flags.dtr;
      });
    });
    this.controlLineChain = next.catch(() => {});
    return next;
  }

  private setControlLines(flags: { rts: boolean; dtr: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.set(flags, (err) => {
        if (err) {
          reject(err);
          return;
        }
        this.onDidUpdateEmitter.fire();
        resolve();
      });
    });
  }

  get isOpen(): boolean {
    return this.port.isOpen;
  }

  get logFilePath(): string | undefined {
    return this.logFileUri?.fsPath;
  }

  dispose(): void {
    this.flushLogFile();
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
    }
    if (this.port.isOpen) {
      this.port.close(() => {
        /* best-effort native handle release on teardown */
      });
    }
    this.onDidTrafficEmitter.dispose();
    this.onDidCloseEmitter.dispose();
    this.onDidUpdateEmitter.dispose();
  }

  private handleIncoming(chunk: Buffer): void {
    const bytes = new Uint8Array(chunk);
    const timestamp = toLocalIsoString(new Date());
    this.stats.bytesReceived += bytes.length;
    this.appendLog('RX', bytes, timestamp);
    this.onDidTrafficEmitter.fire({ direction: 'RX', bytes, timestamp });
    this.onDidUpdateEmitter.fire();
  }

  private appendLog(direction: 'TX' | 'RX', bytes: Uint8Array, timestamp: string): void {
    if (!this.recording) {
      return;
    }
    const formatted = formatBytes(bytes, direction === 'TX' ? this.hexSend : this.hexRecv);
    const line = `[${timestamp}] ${direction}: ${formatted}`;
    if (this.logFileUri) {
      this.logBuffer += line + '\n';
      this.scheduleLogFlush();
    }
  }

  private scheduleLogFlush(): void {
    if (this.logFlushTimer) {
      return;
    }
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = undefined;
      this.flushLogFile();
    }, LOG_FLUSH_DEBOUNCE_MS);
  }

  private flushLogFile(): void {
    if (!this.logFileUri || this.logBuffer.length === 0) {
      return;
    }
    const uri = this.logFileUri;
    const content = Buffer.from(this.logBuffer, 'utf8');
    this.logFlushChain = this.logFlushChain
      .then(() => this.logDirReady)
      .then(() => vscode.workspace.fs.writeFile(uri, content))
      .catch((err) => {
        vscode.window.showErrorMessage(`Failed to write serial log file: ${errorMessage(err)}`);
      });
    if (content.byteLength >= LOG_ROTATE_BYTES && this.logFolderUri) {
      // Start a fresh segment so future flushes don't need to resend everything written so far.
      this.logFileUri = vscode.Uri.joinPath(this.logFolderUri, buildLogFileName(this.path));
      this.logBuffer = '';
    }
  }
}

/** Registry of currently-open ports, keyed by device path. */
export class ConnectionManager {
  private readonly connections = new Map<string, PortConnection>();
  /** In-flight `open()` calls per path — lets a second concurrent `open(path, ...)` call converge
   * onto the same connection instead of racing to construct/open a duplicate native `SerialPort`
   * for the same device (both callers would otherwise see `isOpen(path) === false` until the
   * first one's `await connection.open()` resolves and registers it). */
  private readonly opening = new Map<string, Promise<PortConnection>>();

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  list(): PortConnection[] {
    return [...this.connections.values()];
  }

  get(path: string): PortConnection | undefined {
    return this.connections.get(path);
  }

  isOpen(path: string): boolean {
    return this.connections.has(path);
  }

  async open(path: string, config: PortConfig): Promise<PortConnection> {
    const existing = this.connections.get(path);
    if (existing) {
      return existing;
    }
    const inFlight = this.opening.get(path);
    if (inFlight) {
      return inFlight;
    }
    const openPromise = (async () => {
      const connection = new PortConnection(path, config);
      try {
        await connection.open();
      } finally {
        this.opening.delete(path);
      }
      connection.onDidUpdate(() => this.onDidChangeEmitter.fire());
      connection.onDidClose(() => {
        this.connections.delete(path);
        connection.dispose();
        this.onDidChangeEmitter.fire();
      });
      this.connections.set(path, connection);
      this.onDidChangeEmitter.fire();
      return connection;
    })();
    this.opening.set(path, openPromise);
    return openPromise;
  }

  async close(path: string): Promise<void> {
    const connection = this.connections.get(path);
    if (!connection) {
      return;
    }
    await connection.close();
  }

  dispose(): void {
    for (const connection of this.connections.values()) {
      connection.dispose();
    }
    this.connections.clear();
    this.onDidChangeEmitter.dispose();
  }
}

function buildLogFileName(portPath: string): string {
  const sanitizedPath = portPath.replace(/[\\/:*?"<>|]/g, '_');
  const timestamp = toLocalIsoString(new Date()).replace(/[:.]/g, '-');
  return `${sanitizedPath}_${timestamp}.log`;
}
