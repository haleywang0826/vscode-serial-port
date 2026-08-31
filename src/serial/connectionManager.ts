import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { concatBytes, formatBytes, formatTrafficHeader, splitTrailingIncompleteUtf8 } from './format';

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

/** User-configurable format/timing settings, shared by reference into every open `PortConnection`
 * (and, for `compactTimestamps`, into every open terminal too) — same shared-mutable-object
 * pattern `TerminalColors` already uses in `pseudoterminal.ts`, so a live Default Settings change
 * applies to already-open sessions without reopening the port. Every read happens at format/flush
 * time (never captured onto the event itself), so a change only ever affects lines rendered/logged
 * from that point on, never retroactively. */
export interface FormatSettings {
  compactTimestamps: boolean;
  /** How long (ms) of quiet on the wire delimits one "message" from the next — incoming bytes are
   * buffered and coalesced into a single `TrafficEvent` until this much time passes with nothing
   * new arriving. Also the window during which a multi-byte UTF-8 character split across two
   * `serialport` `'data'` reads is held back rather than decoded prematurely. See `handleIncoming`. */
  messageGapMs: number;
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

  /** Raw bytes accumulated since the last RX flush — see `handleIncoming`/`flushRxBuffer`. */
  private rxBuffer: Uint8Array = new Uint8Array(0);
  private rxFlushTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onDidTrafficEmitter = new vscode.EventEmitter<TrafficEvent>();
  /** Fires for every TX (typed or template-sent) and RX event, so any live view always sees
   * everything that touches the wire, not just what it happened to write itself. */
  readonly onDidTraffic = this.onDidTrafficEmitter.event;

  private readonly onDidCloseEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.onDidCloseEmitter.event;

  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
  /** Fires on stats/config/checkbox changes so the tree can refresh this session's node. */
  readonly onDidUpdate = this.onDidUpdateEmitter.event;

  constructor(
    path: string,
    config: PortConfig,
    private readonly formatSettings: FormatSettings,
  ) {
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
   *
   * `reuseFileUri` only reuses the *filename* — this is a fresh `PortConnection` instance (a
   * reopen), so its own `logBuffer`/`historyText` know nothing about whatever that file already
   * holds on disk from before the last close. `vscode.workspace.fs.writeFile` has no append mode
   * (every flush rewrites the *entire* file from `logBuffer`), so without reading that existing
   * content back in first, the next flush would silently replace it with only the traffic
   * recorded since this reopen. The read is chained onto `logDirReady` — which `flushLogFile`
   * already awaits, and (see there) now also defers capturing `logBuffer` until after that await
   * resolves — so a flush can never race ahead of this and write a truncated file.
   */
  setRecording(value: boolean, logFolderUri?: vscode.Uri, reuseFileUri?: vscode.Uri): void {
    this.recording = value;
    if (value && logFolderUri) {
      this.logFolderUri = logFolderUri;
      this.logBuffer = '';
      const ensureFolder = async (): Promise<void> => {
        try {
          await vscode.workspace.fs.createDirectory(logFolderUri);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to create log folder: ${errorMessage(err)}`);
        }
      };
      if (reuseFileUri) {
        this.logFileUriInternal = reuseFileUri;
        this.logDirReady = (async () => {
          await ensureFolder();
          try {
            const existing = await vscode.workspace.fs.readFile(reuseFileUri);
            this.logBuffer = Buffer.from(existing).toString('utf8') + this.logBuffer;
          } catch {
            // Nothing on disk yet (RF was checked but no traffic was ever flushed before the port
            // closed) — nothing to preserve, continue with an empty buffer.
          }
        })();
      } else {
        this.logDirReady = ensureFolder();
        this.logFileUriInternal = vscode.Uri.joinPath(logFolderUri, buildLogFileName(this.path));
        if (this.historyText) {
          this.logBuffer += this.historyText;
        }
        // Force an immediate (non-debounced) flush so the file is physically created the moment
        // RF is checked + the port is open, rather than waiting for the first byte of traffic —
        // `flushLogFile`'s empty-buffer guard is bypassed via `force` for exactly this case.
        this.scheduleLogFlush(true);
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
    if (this.rxFlushTimer) {
      clearTimeout(this.rxFlushTimer);
      this.rxFlushTimer = undefined;
    }
    this.flushRxBuffer(true);
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

  /** Coalesces raw `serialport` `'data'` chunks over `formatSettings.messageGapMs` of quiet before
   * turning them into a `TrafficEvent` — this is what lets a single logical "message" that arrives
   * as several OS-level reads (and, more importantly, a multi-byte UTF-8 character split across
   * two reads — see `splitTrailingIncompleteUtf8`) render as one coherent line instead of several
   * garbled fragments. Byte counters and `onDidUpdate` still fire immediately on raw arrival (each
   * new chunk resets the debounce timer), so the stats display stays live even while a message is
   * still being assembled. */
  private handleIncoming(chunk: Buffer): void {
    const bytes = new Uint8Array(chunk);
    this.stats.bytesReceived += bytes.length;
    this.onDidUpdateEmitter.fire();
    this.rxBuffer = concatBytes(this.rxBuffer, bytes);
    if (this.rxFlushTimer) {
      clearTimeout(this.rxFlushTimer);
    }
    this.rxFlushTimer = setTimeout(() => {
      this.rxFlushTimer = undefined;
      this.flushRxBuffer();
    }, this.formatSettings.messageGapMs);
  }

  /** Turns the accumulated `rxBuffer` into one `TrafficEvent`. Normally holds back a trailing
   * incomplete UTF-8 sequence (see `splitTrailingIncompleteUtf8`) until it's complete; `force`
   * (used on dispose/port-close) flushes everything immediately instead, so buffered trailing
   * bytes are never silently dropped when the connection is going away. */
  private flushRxBuffer(force = false): void {
    if (this.rxBuffer.length === 0) {
      return;
    }
    const { complete, pending } = force
      ? { complete: this.rxBuffer, pending: new Uint8Array(0) }
      : splitTrailingIncompleteUtf8(this.rxBuffer);
    this.rxBuffer = pending;
    if (complete.length === 0) {
      return;
    }
    const timestamp = toLocalIsoString(new Date());
    const hex = this.hexRecv;
    const event: TrafficEvent = { direction: 'RX', bytes: complete, timestamp, hex };
    this.appendLog(event);
    this.appendHistory(complete, hex);
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
    const line = `${formatTrafficHeader(timestamp, direction, hex, this.formatSettings.compactTimestamps)} ${formatted}`;
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

  /** Debounces a log write; `force` (used to eagerly create the log file the instant RF is
   * checked + the port opens, even with nothing buffered yet) bypasses the debounce and flushes
   * immediately instead of waiting `LOG_FLUSH_DEBOUNCE_MS`. */
  private scheduleLogFlush(force = false): void {
    if (force) {
      if (this.logFlushTimer) {
        clearTimeout(this.logFlushTimer);
        this.logFlushTimer = undefined;
      }
      this.flushLogFile(true);
      return;
    }
    if (this.logFlushTimer) {
      return;
    }
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = undefined;
      this.flushLogFile();
    }, LOG_FLUSH_DEBOUNCE_MS);
  }

  /** `force` bypasses the empty-buffer guard so a log file can be created on disk the moment
   * recording starts, even before any traffic has occurred yet. */
  private flushLogFile(force = false): void {
    if (!this.logFileUriInternal || (this.logBuffer.length === 0 && !force)) {
      return;
    }
    const uri = this.logFileUriInternal;
    this.logFlushChain = this.logFlushChain
      .then(() => this.logDirReady)
      .then(() => {
        // `this.logBuffer` is read only now, after `logDirReady` resolves, rather than captured
        // synchronously above — `logDirReady` may still be prepending a reused file's on-disk
        // content onto it (see `setRecording`), and reading it any earlier could win that race and
        // write a truncated file.
        const content = Buffer.from(this.logBuffer, 'utf8');
        if (content.byteLength >= LOG_ROTATE_BYTES && this.logFolderUri) {
          // Start a fresh segment so future flushes don't need to resend everything written so far.
          this.logFileUriInternal = vscode.Uri.joinPath(this.logFolderUri, buildLogFileName(this.path));
          this.logBuffer = '';
        }
        return vscode.workspace.fs.writeFile(uri, content);
      })
      .catch((err) => {
        vscode.window.showErrorMessage(`Failed to write serial log file: ${errorMessage(err)}`);
      });
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

  async open(path: string, config: PortConfig, formatSettings: FormatSettings): Promise<PortConnection> {
    const existing = this.connections.get(path);
    if (existing) {
      return existing;
    }
    const inFlight = this.opening.get(path);
    if (inFlight) {
      return inFlight;
    }
    const openPromise = (async () => {
      const connection = new PortConnection(path, config, formatSettings);
      try {
        await connection.open();
      } finally {
        this.opening.delete(path);
      }
      connection.onDidUpdate(() => this.onDidChangeEmitter.fire());
      connection.onDidClose(() => {
        this.connections.delete(path);
        this.onDidChangeEmitter.fire();
        // Deferred: disposing the connection's own emitters synchronously from within one of
        // their own fire() callbacks risks cutting off any other onDidClose listener (the panel's
        // closed-session snapshot capture, the terminal's auto-detach) registered after this one
        // that hasn't been invoked yet.
        queueMicrotask(() => connection.dispose());
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
