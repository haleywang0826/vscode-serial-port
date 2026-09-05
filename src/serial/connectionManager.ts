import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { bytesToHex, concatBytes, formatAnnotatedLine, LineEnding } from './format';
import { LineAssembler, Severity, TrafficRecord } from './lineAssembler';

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

export type { TrafficRecord } from './lineAssembler';

/** How a recorded log file is written. `annotated` is the readable, greppable, editor-highlightable
 * form — one physical line per device line, each carrying a `[timestamp MODE DIR]` header and, when
 * severity detection is on, a normalised level in a fixed-width column after the direction. `raw` is
 * a byte-exact capture of the wire in arrival order with nothing added, stripped or transformed, for
 * when the log has to be diffed against another capture tool or replayed. */
export type LogFormat = 'annotated' | 'raw';

/** User-configurable format/timing settings, shared by reference into every open `PortConnection`
 * (and, for `compactTimestamps`, into every open terminal too) — same shared-mutable-object
 * pattern `TerminalColors` already uses in `pseudoterminal.ts`, so a live Default Settings change
 * applies to already-open sessions without reopening the port. Every read happens at format/flush
 * time (never captured onto the record itself), so a change only ever affects lines rendered/logged
 * from that point on, never retroactively. */
export interface FormatSettings {
  compactTimestamps: boolean;
  /** How long (ms) of quiet on the wire delimits the end of an unterminated line — a device that
   * prints a prompt like `esp32> ` and then waits sends no newline, so after this much silence the
   * partial line is surfaced rather than held indefinitely. Also the coalescing window for hex-mode
   * receive, where the byte stream has no line structure to split on. See `handleIncoming`. */
  messageGapMs: number;
  /** Read once, when recording starts — see `PortConnection.logFormatActive`. */
  logFormat: LogFormat;
  /** Whether to classify each received line's severity, colour its terminal row to match, and write
   * the level into the log header's severity column. Applies to RX only — see
   * `LineAssembler.detectLineSeverity`. */
  detectSeverity: boolean;
}

const LOG_FLUSH_DEBOUNCE_MS = 300;
/** Once a segment file reaches this size, the next flush starts a fresh file instead of
 * continuing to grow the same buffer forever — `vscode.workspace.fs.writeFile` has no append
 * option (it always replaces full file contents), so the alternative is rewriting the *entire*
 * session's log on every flush, an unbounded and ever-growing cost. */
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
/** Cap on the in-memory per-connection traffic buffer (see `PortConnection.history`), kept for
 * every session — open or not yet recording — so that enabling "Record to File" mid-session can
 * back-fill the log with everything shown so far. Bounded the same way log rotation is, so a
 * long-lived, never-recorded session can't grow this without limit. */
const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

/** How long an unterminated annotated log line is held before it is written out anyway — see
 * `PortConnection.startLogPartialTimer`. Far longer than `messageGapMs` (which decides when the
 * *terminal* surfaces a partial, and is tens of milliseconds) because the two are answering
 * different questions: the terminal can redraw a row it already drew, a file cannot revise a line
 * it already wrote, so the file should wait until the line is plainly finished. Short enough that a
 * log tailed live still feels live. */
const LOG_PARTIAL_IDLE_MS = 750;

const encoder = new TextEncoder();

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

type Direction = 'TX' | 'RX';

/** An annotated-mode line the device hasn't finished yet. `timestamp`/`severity` come from the
 * line's *first* segment, so a line that took three idle flushes to complete is still stamped with
 * when the device started it and classified by the level prefix that opened it. */
interface LogPartial {
  timestamp: string;
  severity: Severity | undefined;
  text: string;
}

/** Byte buffer with a hard cap, dropping whole leading chunks once it is exceeded. Every chunk
 * pushed is a self-contained unit (one formatted line, or one raw read), so trimming never cuts a
 * line in half — backfilled content always starts at a boundary a reader can make sense of. */
class ByteRing {
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get isEmpty(): boolean {
    return this.bytes === 0;
  }

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  toBytes(): Uint8Array {
    return joinBytes(this.chunks);
  }
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
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
  /** Appended to every ASCII send (never to a hex send) — see `LineEnding`. */
  lineEnding: LineEnding = 'crlf';
  /** "Device Console": when on, the terminal stops being a line editor and hands the screen to the
   * device — every keystroke goes straight to it and every byte it sends is written straight to the
   * screen. Owned here rather than in the terminal so it survives a detach/reattach and is
   * visible to the panel alongside the other per-session toggles. */
  deviceConsole = false;
  readonly stats: PortStats = { bytesSent: 0, bytesReceived: 0 };

  private readonly port: SerialPort;
  private logFileUriInternal: vscode.Uri | undefined;
  private logFolderUri: vscode.Uri | undefined;
  /** Pending log content as byte chunks rather than one growing string: `raw` mode has to preserve
   * bytes that are not valid text at all, and even in `annotated` mode the rotation threshold and
   * the reused-file read-back are byte quantities, so keeping the buffer in bytes end-to-end means
   * no encode/decode round-trip can change what gets written. */
  private logChunks: Uint8Array[] = [];
  private logBytes = 0;
  private logFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private logFlushChain: Promise<void> = Promise.resolve();
  private logDirReady: Promise<void> = Promise.resolve();
  private controlLineChain: Promise<void> = Promise.resolve();
  /** The log format captured when recording started. Read once rather than live, so that changing
   * the setting mid-recording can't leave one file holding a mix of annotated lines and raw bytes;
   * the new format takes effect the next time recording starts. */
  private logFormatActive: LogFormat = 'annotated';
  /** Annotated-mode partial lines per direction, held back until the device finishes the line so
   * the file only ever contains whole lines. Flushed on close, on recording off, on dispose, and —
   * see `LOG_PARTIAL_IDLE_MS` — once the line has gone quiet for long enough that it is plainly
   * never going to be finished. */
  private readonly logPartials: Record<Direction, LogPartial | undefined> = { TX: undefined, RX: undefined };
  private readonly logPartialTimers: Record<Direction, ReturnType<typeof setTimeout> | undefined> = {
    TX: undefined,
    RX: undefined,
  };

  /** Everything this connection instance has produced so far, in the same form it would have been
   * logged in, capped to `HISTORY_MAX_BYTES` and trimmed at whole-chunk (i.e. whole-line for
   * annotated) boundaries. Populated unconditionally, not just while recording, so turning "Record
   * to File" on mid-session can back-fill the log with everything already shown — see
   * `setRecording`. Both forms are kept because the format is only chosen when recording starts.
   * Scoped to this connection *instance*, so a fresh reopen naturally starts empty and a later RF
   * enable only ever backfills that reopen's own traffic, never a prior open's. */
  private readonly annotatedHistory = new ByteRing(HISTORY_MAX_BYTES);
  private readonly rawHistory = new ByteRing(HISTORY_MAX_BYTES);

  /** Raw bytes accumulated since the last hex-mode RX flush — see `handleIncoming`/`flushRx`. */
  private rxBuffer: Uint8Array = new Uint8Array(0);
  private rxFlushTimer: ReturnType<typeof setTimeout> | undefined;

  /** One assembler per direction; each owns that direction's UTF-8, escape and SGR state. */
  private readonly assemblers: Record<Direction, LineAssembler>;

  private readonly onDidRecordEmitter = new vscode.EventEmitter<TrafficRecord>();
  /** Fires for every TX (typed or template-sent) and RX record, so any live view always sees
   * everything that touches the wire, not just what it happened to write itself. */
  readonly onDidRecord = this.onDidRecordEmitter.event;

  private readonly onDidRawDataEmitter = new vscode.EventEmitter<Uint8Array>();
  /** Fires with each incoming read exactly as it came off the wire, before any line assembly. Only
   * raw-input mode consumes this: a full-screen device UI needs the cursor-movement and erase
   * sequences that the assembler deliberately drops to protect the pinned input row. Line assembly
   * and annotated logging keep running off the same bytes regardless, so a recording made in raw
   * input mode is still a normal annotated log. */
  readonly onDidRawData = this.onDidRawDataEmitter.event;

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
    const callbacks = {
      emit: (record: TrafficRecord) => this.handleRecord(record),
      detectSeverity: () => this.formatSettings.detectSeverity,
    };
    this.assemblers = {
      TX: new LineAssembler('TX', callbacks),
      RX: new LineAssembler('RX', callbacks),
    };
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
      // Surface anything still buffered *before* the handle goes away: an unterminated final line
      // and a held-back UTF-8 tail are both real traffic the user saw, and dropping them would make
      // the log disagree with the terminal.
      this.finishStreams();
      this.port.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Sends bytes verbatim. The caller is responsible for any line ending (see `LINE_ENDING_BYTES`)
   * — appending one here would corrupt a hex send and would turn every raw-mode keystroke into a
   * line of its own.
   *
   * The TX record is produced *before* the bytes are handed to the driver, not from the write's
   * completion callback. A device that echoes (or answers immediately) can have its reply delivered
   * to the `'data'` handler before node-serialport gets around to invoking that callback, which put
   * the RX line ahead of the TX line that caused it — in the terminal and in the log, with an RX
   * timestamp earlier than the TX one. Stamping the send at the moment we send it makes the
   * ordering causal by construction rather than dependent on callback scheduling. `bytesSent` still
   * only counts bytes the driver actually accepted, so a failed write is not counted as sent.
   */
  write(bytes: Uint8Array): Promise<void> {
    const timestamp = toLocalIsoString(new Date());
    this.captureRaw(bytes);
    if (this.hexSend) {
      this.handleRecord({ kind: 'hex', direction: 'TX', timestamp, bytes });
    } else {
      // A send is a self-contained unit — whatever it ends with is the end of it — so the assembler
      // is flushed immediately rather than waiting for an idle timeout that would only delay
      // showing something the user just typed.
      this.assemblers.TX.write(bytes, timestamp);
      this.assemblers.TX.flush();
    }
    return new Promise((resolve, reject) => {
      this.port.write(Buffer.from(bytes), (err) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        this.stats.bytesSent += bytes.length;
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
    if (value !== this.hexSend) {
      // The same bytes mean something completely different in the other mode, so anything the
      // assembler is still holding belongs to the old mode: emit it now rather than letting it
      // reappear glued to the front of the first line of the new one.
      this.assemblers.TX.flush();
    }
    this.hexSend = value;
    this.onDidUpdateEmitter.fire();
  }

  setHexRecv(value: boolean): void {
    if (value !== this.hexRecv) {
      this.flushRx(true);
      this.assemblers.RX.flush();
    }
    this.hexRecv = value;
    this.onDidUpdateEmitter.fire();
  }

  setLineEnding(value: LineEnding): void {
    this.lineEnding = value;
    this.onDidUpdateEmitter.fire();
  }

  setDeviceConsole(value: boolean): void {
    this.deviceConsole = value;
    this.onDidUpdateEmitter.fire();
  }

  /**
   * Turns recording on/off. `reuseFileUri`, when given, points at an already-known log file (the
   * same session's file from before it was last closed) instead of starting a new one — this is
   * what lets a close/reopen with RF already checked keep appending to the SAME file rather than
   * fragmenting into a new one each time. Omitting it (the default — used when the user flips the
   * checkbox on live, whether the port is open or not) starts a fresh file and backfills it with
   * this connection instance's own history so far, covering the whole communication period already
   * shown. Backfilled lines now carry their full `[timestamp MODE DIR]` header: each record knows
   * when it happened and which way it went, so there is nothing left to guess — a deliberate change
   * from the header-less backfill this code used to do, which was only ever a workaround for
   * chunk-shaped events that couldn't attribute a header per line. Since the history is scoped to
   * this connection instance, a reopened connection's empty buffer means turning RF on after a
   * reopen only ever backfills that reopen's own traffic.
   *
   * `reuseFileUri` only reuses the *filename* — this is a fresh `PortConnection` instance (a
   * reopen), so its own log buffer/history know nothing about whatever that file already holds on
   * disk from before the last close. `vscode.workspace.fs.writeFile` has no append mode (every
   * flush rewrites the *entire* file from the buffer), so without reading that existing content
   * back in first, the next flush would silently replace it with only the traffic recorded since
   * this reopen. The read is chained onto `logDirReady` — which `flushLogFile` already awaits, and
   * (see there) now also defers capturing the buffer until after that await resolves — so a flush
   * can never race ahead of this and write a truncated file.
   */
  setRecording(value: boolean, logFolderUri?: vscode.Uri, reuseFileUri?: vscode.Uri): void {
    if (!value && this.recording) {
      // Whole lines only: anything half-written is completed into the file before it is closed off.
      this.flushLogPartials();
      this.writeSessionBanner('recording stopped');
    }
    this.recording = value;
    if (value && logFolderUri) {
      this.logFolderUri = logFolderUri;
      this.logChunks = [];
      this.logBytes = 0;
      this.logFormatActive = this.formatSettings.logFormat;
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
            this.logChunks.unshift(new Uint8Array(existing));
            this.logBytes += existing.byteLength;
          } catch {
            // Nothing on disk yet (RF was checked but no traffic was ever flushed before the port
            // closed) — nothing to preserve, continue with an empty buffer.
          }
        })();
        // Write start banner for this new session, even though we're reusing the file
        this.writeSessionBanner('recording started');
      } else {
        this.logDirReady = ensureFolder();
        this.logFileUriInternal = vscode.Uri.joinPath(
          logFolderUri,
          buildLogFileName(this.path, this.logFormatActive),
        );
        const backfill = this.logFormatActive === 'raw' ? this.rawHistory : this.annotatedHistory;
        if (!backfill.isEmpty) {
          this.appendLogBytes(backfill.toBytes());
        }
        this.writeSessionBanner('recording started');
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

  /** Writes a `# --- COM8 recording started <ts> · 115200 8N1 ---` banner, so an archived log says
   * for itself which port and line settings produced it. Comment-shaped so the editor grammar dims
   * it, and skipped entirely in `raw` mode, whose whole contract is that nothing is added. */
  private writeSessionBanner(event: string): void {
    if (this.logFormatActive !== 'annotated' || !this.logFileUriInternal) {
      return;
    }
    const { baudRate, dataBits, parity, stopBits } = this.config;
    const frame = `${dataBits}${parity.charAt(0).toUpperCase()}${stopBits}`;
    const timestamp = toLocalIsoString(new Date());
    this.appendLogBytes(encoder.encode(`# --- ${this.path} ${event} ${timestamp} · ${baudRate} ${frame} ---\n`));
    this.scheduleLogFlush();
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
    this.finishStreams();
    this.flushLogPartials();
    // Write stop banner before closing log if recording is active
    if (this.recording) {
      this.writeSessionBanner('recording stopped');
    }
    this.flushLogFile();
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
    }
    if (this.port.isOpen) {
      this.port.close(() => {
        /* best-effort native handle release on teardown */
      });
    }
    this.onDidRecordEmitter.dispose();
    this.onDidRawDataEmitter.dispose();
    this.onDidCloseEmitter.dispose();
    this.onDidUpdateEmitter.dispose();
  }

  /** Emits everything still buffered in either direction as final records. Called when the port is
   * going away, where holding bytes back for a completion that can never arrive would simply lose
   * them. Safe to call twice — a flushed assembler has nothing left to emit. */
  private finishStreams(): void {
    this.flushRx(true);
    this.assemblers.RX.flush();
    this.assemblers.TX.flush();
  }

  /**
   * Feeds incoming bytes to the RX assembler, which splits them into device lines. Byte counters
   * and `onDidUpdate` fire immediately on raw arrival so the stats display stays live.
   *
   * The `messageGapMs` timer no longer decides when a *message* ends — line breaks do that, and
   * they do it correctly for a device that emits five lines in one read or one line across three.
   * What the timer still decides is when to give up waiting for a line break that may never come:
   * a device that prints `esp32> ` and waits for input has finished as far as the user is
   * concerned, so after that much quiet the partial line is surfaced. Hex mode keeps the original
   * coalescing behaviour, since a hex dump has no line structure to split on.
   */
  private handleIncoming(chunk: Buffer): void {
    const bytes = new Uint8Array(chunk);
    this.stats.bytesReceived += bytes.length;
    this.captureRaw(bytes);
    this.onDidRawDataEmitter.fire(bytes);
    this.onDidUpdateEmitter.fire();
    if (this.hexRecv) {
      this.rxBuffer = concatBytes(this.rxBuffer, bytes);
    } else {
      this.assemblers.RX.write(bytes, toLocalIsoString(new Date()));
    }
    if (this.rxFlushTimer) {
      clearTimeout(this.rxFlushTimer);
    }
    this.rxFlushTimer = setTimeout(() => {
      this.rxFlushTimer = undefined;
      this.flushRx();
    }, this.formatSettings.messageGapMs);
  }

  /** Idle-timer handler: emits the accumulated hex chunk, or surfaces the ASCII assembler's
   * unterminated line as a partial. `force` (used on close/dispose and on a hex-mode toggle) also
   * emits a hex chunk that would otherwise still be waiting for its timer. */
  private flushRx(force = false): void {
    if (this.rxBuffer.length > 0 && (this.hexRecv || force)) {
      const bytes = this.rxBuffer;
      this.rxBuffer = new Uint8Array(0);
      this.handleRecord({ kind: 'hex', direction: 'RX', timestamp: toLocalIsoString(new Date()), bytes });
      return;
    }
    if (!this.hexRecv && !force) {
      this.assemblers.RX.flushPartial();
    }
  }

  /** The single point every record passes through: log it, remember it for a later backfill, and
   * publish it. Called synchronously from inside the assemblers' emit callback, so a consumer sees
   * records in exactly the order the device produced them. */
  private handleRecord(record: TrafficRecord): void {
    this.appendLog(record);
    this.onDidRecordEmitter.fire(record);
  }

  /** Keeps a byte-exact copy of everything that crosses the wire, in arrival order, for `raw`-mode
   * recording and its backfill. Both directions share one stream because that is what `raw` means:
   * the wire as it actually looked, not a per-direction reconstruction of it. */
  private captureRaw(bytes: Uint8Array): void {
    this.rawHistory.push(bytes);
    if (this.recording && this.logFormatActive === 'raw' && this.logFileUriInternal) {
      this.appendLogBytes(bytes);
      this.scheduleLogFlush();
    }
  }

  /** Turns one record into its annotated log line, appending it both to the backfill history and —
   * if recording is on in annotated mode — to the pending log buffer. A partial line is held until
   * the device completes it, so the file never contains a half-line that later gets a second,
   * duplicate header. `raw` mode does none of this; `captureRaw` already wrote the bytes. */
  private appendLog(record: TrafficRecord): void {
    if (record.kind === 'hex') {
      this.emitLogLine(this.formatLine(record.timestamp, record.direction, true, undefined, bytesToHex(record.bytes)));
      return;
    }
    this.clearLogPartialTimer(record.direction);
    const previous = this.logPartials[record.direction];
    const timestamp = previous?.timestamp ?? record.timestamp;
    const severity = previous?.severity ?? record.severity;
    const text = (previous?.text ?? '') + record.plain;
    if (record.continues) {
      this.logPartials[record.direction] = { timestamp, severity, text };
      this.startLogPartialTimer(record.direction);
      return;
    }
    this.logPartials[record.direction] = undefined;
    this.emitLogLine(this.formatLine(timestamp, record.direction, false, severity, text));
  }

  /**
   * Writes a held partial out once its line has gone quiet, so a line the device never terminates
   * still reaches the file while the session is running.
   *
   * Holding partials is what keeps the file free of half-lines that later gain a second header, but
   * held *unconditionally* it meant a line with no newline coming — a `esp32> ` prompt, or a device
   * echoing a hex send back as control bytes — only landed in the file when the port closed. The
   * terminal showed it immediately (that is what `flushPartial` is for), so the log looked broken by
   * comparison. This is the deadline on that wait.
   *
   * If the device does eventually continue the line, the continuation is written as its own
   * complete line rather than being spliced into the one already on disk: an append-only file can't
   * revise a line it has written, and two honest lines beat one line that silently went missing.
   * The window is generous enough that an ordinary line, emitted in milliseconds, never splits.
   */
  private startLogPartialTimer(direction: Direction): void {
    const delay = Math.max(LOG_PARTIAL_IDLE_MS, this.formatSettings.messageGapMs * 2);
    this.logPartialTimers[direction] = setTimeout(() => {
      this.logPartialTimers[direction] = undefined;
      const partial = this.logPartials[direction];
      if (!partial) {
        return;
      }
      this.logPartials[direction] = undefined;
      this.emitLogLine(this.formatLine(partial.timestamp, direction, false, partial.severity, partial.text));
    }, delay);
  }

  private clearLogPartialTimer(direction: Direction): void {
    const timer = this.logPartialTimers[direction];
    if (timer) {
      clearTimeout(timer);
      this.logPartialTimers[direction] = undefined;
    }
  }

  /** Completes and writes out any line still being accumulated, so a shutdown or a format boundary
   * never leaves the last line of a session stranded in memory. */
  private flushLogPartials(): void {
    for (const direction of ['RX', 'TX'] as const) {
      this.clearLogPartialTimer(direction);
      const partial = this.logPartials[direction];
      if (!partial) {
        continue;
      }
      this.logPartials[direction] = undefined;
      this.emitLogLine(this.formatLine(partial.timestamp, direction, false, partial.severity, partial.text));
    }
  }

  private formatLine(
    timestamp: string,
    direction: Direction,
    hex: boolean,
    severity: Severity | undefined,
    text: string,
  ): string {
    return formatAnnotatedLine(timestamp, direction, hex, this.formatSettings.compactTimestamps, severity, text);
  }

  /** Appends one complete annotated line (a trailing newline is added here, so no caller can leave
   * one off or add a second) to the backfill history and, when recording, to the log buffer. */
  private emitLogLine(line: string): void {
    const bytes = encoder.encode(line + '\n');
    this.annotatedHistory.push(bytes);
    if (this.recording && this.logFormatActive === 'annotated' && this.logFileUriInternal) {
      this.appendLogBytes(bytes);
      this.scheduleLogFlush();
    }
  }

  private appendLogBytes(bytes: Uint8Array): void {
    this.logChunks.push(bytes);
    this.logBytes += bytes.length;
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
    if (!this.logFileUriInternal || (this.logBytes === 0 && !force)) {
      return;
    }
    const uri = this.logFileUriInternal;
    this.logFlushChain = this.logFlushChain
      .then(() => this.logDirReady)
      .then(() => {
        // The buffer is read only now, after `logDirReady` resolves, rather than captured
        // synchronously above — `logDirReady` may still be prepending a reused file's on-disk
        // content onto it (see `setRecording`), and reading it any earlier could win that race and
        // write a truncated file.
        const content = joinBytes(this.logChunks);
        if (content.byteLength >= LOG_ROTATE_BYTES && this.logFolderUri) {
          // Start a fresh segment so future flushes don't need to resend everything written so far.
          this.logFileUriInternal = vscode.Uri.joinPath(
            this.logFolderUri,
            buildLogFileName(this.path, this.logFormatActive),
          );
          this.logChunks = [];
          this.logBytes = 0;
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

/** Annotated logs are named `*.serial.log` so VS Code resolves them to this extension's `serial-log`
 * language (a `filenamePatterns` match outranks the built-in `log` language's `.log` extension
 * claim) and colours the header, direction and severity columns. Raw captures get `*.raw.log`,
 * which stays plain `Log` — there is nothing structural in them to highlight. */
function buildLogFileName(portPath: string, format: LogFormat): string {
  const sanitizedPath = portPath.replace(/[\\/:*?"<>|]/g, '_');
  const timestamp = toLocalIsoString(new Date()).replace(/[:.]/g, '-');
  return `${sanitizedPath}_${timestamp}.${format === 'raw' ? 'raw' : 'serial'}.log`;
}
