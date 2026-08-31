import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { formatBytes, formatTrafficHeader } from './format';

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
 * and any live display so the two never disagree or compute it independently. `hex` is the
 * send/recv mode that was active at the moment this event happened (not necessarily the
 * connection's *current* mode, which can change mid-session) — captured per-event so a live
 * terminal/log line always renders the way it actually looked, even after a mode change. */
export interface TrafficEvent {
  direction: 'TX' | 'RX';
  bytes: Uint8Array;
  timestamp: string;
  hex: boolean;
}

const LOG_FLUSH_DEBOUNCE_MS = 300;
/** Once a segment file reaches this size, the next flush starts a fresh file instead of
 * continuing to grow the same buffer forever — `vscode.workspace.fs.writeFile` has no append
 * option (it always replaces full file contents), so the alternative is rewriting the *entire*
 * session's log on every flush, an unbounded and ever-growing cost. */
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
/** Cap on the in-memory per-connection plain-text traffic buffer (see `PortConnection.historyText`),
 * kept for every session — open or not yet recording — so that enabling "Record to File" mid-session
 * can back-fill the log with everything shown so far. Bounded the same way log rotation is, so a
 * long-lived, never-recorded session can't grow this without limit. */
const HISTORY_MAX_CHARS = 4 * 1024 * 1024;

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
  private logFileUriInternal: vscode.Uri | undefined;
  private logFolderUri: vscode.Uri | undefined;
  private logBuffer = '';
  private logFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private logFlushChain: Promise<void> = Promise.resolve();
  private logDirReady: Promise<void> = Promise.resolve();
  private controlLineChain: Promise<void> = Promise.resolve();
  /** Plain-text buffer of every already-formatted line this connection instance has produced so
   * far (content only — no timestamp/direction/mode header), capped to `HISTORY_MAX_CHARS`.
   * Populated unconditionally (not just while recording) so turning "Record to File" on mid-session
   * can back-fill the log with everything already shown — see `setRecording`. Backfilled lines
   * deliberately carry no header: we don't know (and the user doesn't want us guessing) what
   * header, if any, applied when each line originally appeared, so only live-recorded lines going
   * forward get one. Scoped to this connection *instance*, so a fresh reopen naturally starts with
   * an empty buffer and a later RF enable only ever backfills that reopen's own traffic, never a
   * prior open's. */
  private historyText = '';

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
        const hex = this.hexSend;
        this.stats.bytesSent += bytes.length;
        const event: TrafficEvent = { direction: 'TX', bytes, timestamp, hex };
        this.appendLog(event);
        this.appendHistory(bytes, hex);
        this.onDidTrafficEmitter.fire(event);
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

  /**
   * Turns recording on/off. `reuseFileUri`, when given, points at an already-known log file (the
   * same session's file from before it was last closed) instead of starting a new one — this is
   * what lets a close/reopen with RF already checked keep appending to the SAME file rather than
   * fragmenting into a new one each time. Omitting it (the default — used when the user flips the
   * checkbox on live, whether the port is open or not) starts a fresh file and backfills it with
   * this connection instance's own `historyText` so far, covering the whole communication period
   * already shown — pasted in verbatim, with no timestamp header, since we don't know (and were
   * asked not to guess) what header, if any, applied when each backfilled line originally
   * appeared; only lines recorded from this point on get one. Since `historyText` is scoped to
   * this connection instance, a reopened connection's empty buffer means turning RF on after a
   * reopen only ever backfills that reopen's own traffic.
   */
  setRecording(value: boolean, logFolderUri?: vscode.Uri, reuseFileUri?: vscode.Uri): void {
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
      this.logBuffer = '';
      if (reuseFileUri) {
        this.logFileUriInternal = reuseFileUri;
      } else {
        this.logFileUriInternal = vscode.Uri.joinPath(logFolderUri, buildLogFileName(this.path));
        if (this.historyText) {
          this.logBuffer += this.historyText;
          this.scheduleLogFlush();
        }
      }
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
    return this.logFileUriInternal?.fsPath;
  }

  /** The log file's full URI (scheme + authority preserved), for callers that need a lossless
   * round-trip — e.g. reopening it via `vscode.window.showTextDocument` on a remote (WSL/SSH)
   * workspace, where the lossy `.fsPath` string above would silently discard the remote scheme. */
  get logFileUri(): vscode.Uri | undefined {
    return this.logFileUriInternal;
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
    const hex = this.hexRecv;
    this.stats.bytesReceived += bytes.length;
    const event: TrafficEvent = { direction: 'RX', bytes, timestamp, hex };
    this.appendLog(event);
    this.appendHistory(bytes, hex);
    this.onDidTrafficEmitter.fire(event);
    this.onDidUpdateEmitter.fire();
  }

  private appendLog(event: TrafficEvent): void {
    if (!this.recording) {
      return;
    }
    this.writeLogLine(event.direction, event.bytes, event.timestamp, event.hex);
  }

  /** Formats and appends one live event to the log buffer with its full header — used only by
   * `appendLog`. Backfilled history lines skip this entirely (see `setRecording`), since they
   * carry no header. */
  private writeLogLine(direction: 'TX' | 'RX', bytes: Uint8Array, timestamp: string, hex: boolean): void {
    const formatted = formatBytes(bytes, hex);
    const line = `${formatTrafficHeader(timestamp, direction, hex)} ${formatted}`;
    if (this.logFileUriInternal) {
      this.logBuffer += line + '\n';
      this.scheduleLogFlush();
    }
  }

  /** Appends `formatBytes(bytes, hex)` (content only, no header) to the bounded plain-text
   * `historyText` buffer, regardless of whether recording is currently on, so a later "Record to
   * File" enable can backfill it. Trims whole leading lines (never a mid-line cut) once the cap is
   * exceeded, so backfilled content always starts at a line boundary. */
  private appendHistory(bytes: Uint8Array, hex: boolean): void {
    this.historyText += formatBytes(bytes, hex) + '\n';
    while (this.historyText.length > HISTORY_MAX_CHARS) {
      const newlineIndex = this.historyText.indexOf('\n');
      if (newlineIndex === -1) {
        this.historyText = '';
        break;
      }
      this.historyText = this.historyText.slice(newlineIndex + 1);
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
    if (!this.logFileUriInternal || this.logBuffer.length === 0) {
      return;
    }
    const uri = this.logFileUriInternal;
    const content = Buffer.from(this.logBuffer, 'utf8');
    this.logFlushChain = this.logFlushChain
      .then(() => this.logDirReady)
      .then(() => vscode.workspace.fs.writeFile(uri, content))
      .catch((err) => {
        vscode.window.showErrorMessage(`Failed to write serial log file: ${errorMessage(err)}`);
      });
    if (content.byteLength >= LOG_ROTATE_BYTES && this.logFolderUri) {
      // Start a fresh segment so future flushes don't need to resend everything written so far.
      this.logFileUriInternal = vscode.Uri.joinPath(this.logFolderUri, buildLogFileName(this.path));
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
