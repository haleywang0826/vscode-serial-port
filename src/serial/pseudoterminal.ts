import * as vscode from 'vscode';
import { FormatSettings, PortConnection, TrafficRecord } from './connectionManager';
import type { SeverityColors } from '../severityColors';
import {
  appendHexInputChar,
  asciiStringToBytes,
  bytesToHex,
  concatBytes,
  formatTrafficHeader,
  hexStringToBytes,
  isHexDigitChar,
  LINE_ENDING_BYTES,
} from './format';

const ENTER = '\r';
const BACKSPACE = '\x7f';
const CTRL_C = '\x03';
const CTRL_L = '\x0c';
const ESC = '\x1b';

const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 80;
/** Cap on recalled input lines (Up/Down history) — a generous bound for interactive serial
 * debugging without letting the array grow unbounded over a long session. */
const HISTORY_LIMIT = 100;
/** Cap on output buffered while the pty is not yet open (see `pendingOutput`). Generous enough to
 * hold a long pre-reveal session, bounded so a terminal that is never revealed can't grow forever;
 * trimming always drops whole lines off the front, never splitting an escape sequence. */
const PENDING_OUTPUT_MAX_CHARS = 64 * 1024;
/** Quiet period after the last `setDimensions` call before the terminal repaints itself once more
 * (see `scheduleResizeSettle`). Long enough to coalesce a drag's worth of resize events and let
 * xterm.js finish reflowing, short enough that the corrected frame lands while the user is still
 * looking at the result of their drag. */
const RESIZE_SETTLE_MS = 80;
/** DECSCUSR cursor-shape escapes (`CSI Ps SP q`, supported by VS Code's xterm.js-based terminal
 * renderer): a thin steady bar for insert mode (matches the vim/readline convention that a bar
 * cursor means "typing inserts"), a steady block for overwrite mode (typing replaces the character
 * under the cursor) — toggled by the Insert key. */
const CURSOR_STYLE_INSERT = '\x1b[6 q';
const CURSOR_STYLE_OVERWRITE = '\x1b[2 q';

/** DECSC/DECRC. Used to re-find the end of a row that an idle-flushed partial line left open, so
 * the rest of that device line lands on the same row instead of starting a new one with a second,
 * duplicate header. Saving after the write means a line long enough to wrap has already scrolled by
 * then, so the restored position is still the true end of the text. */
const SAVE_CURSOR = '\x1b7';
const RESTORE_CURSOR = '\x1b8';

const RESET = '\x1b[0m';
const DIM = '\x1b[90m';
const ERROR_COLOR = '\x1b[31m';

export interface SerialTerminal {
  terminal: vscode.Terminal;
  /** (Re)binds this terminal to a live connection: subscribes to its traffic/update/close events,
   * unblocks input, and prints a "Connected" banner. No-op if already attached to a live
   * connection. */
  attach(connection: PortConnection): void;
  /** Unbinds from the current connection (if any): unsubscribes, blocks input, and prints a
   * "disconnected" banner. Does NOT close the terminal itself — the session (and its terminal)
   * stay present so the port can be reopened into this same terminal later. No-op if already
   * detached. */
  detach(): void;
  /** Fires when the pty's `close` callback runs because VS Code is tearing down the terminal for a
   * genuine user action (clicking its kill icon, "Terminal: Kill") — NOT when our own `dispose()`
   * caused it (see the `disposing` guard below). This is the one signal that should actually remove
   * the session from the panel. */
  onDidUserClose: vscode.Event<void>;
  dispose(): void;
}

/** User-configurable terminal colors (hex, e.g. "#00cccc"), shared by reference from
 * `SerialPanelProvider` so a color change in Default Settings applies live to every already-open
 * terminal without needing to reopen the port. */
export interface TerminalColors {
  tx: string;
  rx: string;
  /** Per-severity row colour, from `serialPort.severityColors`. An empty string for a level means
   * "no override" — a row detected at that level keeps the ordinary TX/RX colour. Mutated in place
   * by the provider, never reassigned, for the same live-update reason as `tx`/`rx` above. */
  severity: SeverityColors;
}

/**
 * Creates an interactive terminal for one session, identified by `path`. The terminal exists
 * independent of whether the port is currently open — it starts (or falls back to) a disconnected
 * state with input blocked, and `attach`/`detach` bind/unbind it to a live `PortConnection` as the
 * port opens and closes, without ever recreating the underlying `vscode.Terminal`. This is what
 * lets a session's terminal (and its scrollback) survive a close/reopen cycle.
 *
 * While attached, every TX/RX record is rendered live — one terminal row per device line, each
 * carrying its own timestamp (when "Show timestamp" is on), coloured by the device's own ANSI
 * colours if it set any, otherwise by detected severity, otherwise by the configured TX/RX colour.
 * Whatever the user types is sent on Enter, followed by the session's configured line ending. TX is
 * rendered from the connection's `onDidRecord` event, the same source the file log reads from, so a
 * template send (or any other write) shows up here too — not just terminal-typed input. While "hex
 * send" is on, non-hex-digit keystrokes are rejected as they're typed, and a space is auto-inserted
 * between each typed byte pair (see `appendHexInputChar`) so the user never has to type the
 * separating spaces themselves.
 *
 * The input line is pinned to the terminal's actual bottom row via an ANSI scroll region
 * (DECSTBM, `\x1b[<top>;<bottom>r`) confined to rows 1..rows-1 — the same mechanism tmux's status
 * line and htop's header use. Incoming/echoed text is written into that confined region (so it
 * scrolls independently), while the last row sits outside the region and is only ever redrawn in
 * place, never scrolled — that's what keeps it pinned even when there isn't much content yet.
 *
 * **Device Console mode** (the session's "Device Console" toggle) turns all of that off and hands
 * the terminal over to the device instead: the scroll region is released, the pinned row
 * disappears, incoming bytes are written through untouched (cursor movement, erase, full-screen
 * redraws and all), and every keystroke — Ctrl+C, Ctrl+D, arrow keys — goes straight to the device.
 * That is what a MicroPython REPL, a Zephyr shell or an ESP-IDF console needs, and none of it is
 * possible while a pinned row owns the bottom of the screen. Line editing, local history and Ctrl+L
 * are line-mode features and are unavailable while it is on. Logging is unaffected: the connection
 * keeps assembling and recording lines from the same bytes either way.
 *
 * Ctrl+L clears the screen, matching the same convention used by bash/zsh's readline
 * clear-screen binding, tmux, and other terminal-based tools, so it works the way anyone coming
 * from a terminal would expect without needing a separate extension command.
 *
 * Up/Down recall previously-sent lines (shell-style history, capped at `HISTORY_LIMIT`, persists
 * across attach/detach); Left/Right move the cursor within the current line for mid-word editing;
 * typing at the cursor inserts by default (shifting the rest of the line right) or overwrites when
 * the Insert key has toggled overwrite mode, shown via a DECSCUSR cursor-shape change (thin bar vs
 * block) rather than a status line, since there's nowhere else in this narrow bottom row to put an
 * indicator. Hex-send mode ignores cursor position/insert-overwrite entirely and always edits at
 * the end of the line, since `appendHexInputChar`'s auto-space-per-byte-pair logic only makes sense
 * appended to the end. `redrawInputLine` clips the displayed line to a horizontally-scrolling
 * window sized to the terminal's actual width (tracked via `columns`, previously never captured at
 * all) so a line longer than the terminal is wide can never wrap onto a second physical row — that
 * wrap, with only the single pinned row ever being erased/redrawn, was the source of a rare display
 * corruption where a long typed line's leftover wrapped remnant survived past the next redraw.
 */
export function createSerialTerminal(
  path: string,
  colors: TerminalColors,
  formatSettings: FormatSettings,
): SerialTerminal {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<void>();
  const userCloseEmitter = new vscode.EventEmitter<void>();
  let line = '';
  let cursorPos = 0;
  let rows = DEFAULT_ROWS;
  let columns = DEFAULT_COLUMNS;
  /** True = typing inserts at the cursor and shifts the rest of the line right (the default, and
   * what every text editor/readline does); false = typing overwrites the character under the
   * cursor. Toggled by the Insert key (`CSI 2 ~`); rendered via the DECSCUSR cursor-shape escapes
   * above so the user can see which mode is active without a status line. Hex-send mode ignores
   * this entirely — see the hex branch in `handleInput`. */
  let insertMode = true;
  /** Previously-sent lines, most-recent-last, recalled with Up/Down like shell history. Persists
   * across attach/detach (a close/reopen doesn't lose it), unlike the transient per-session state
   * below, since it's conceptually scrollback for what the user has typed, not session state. */
  const history: string[] = [];
  /** -1 = editing a fresh line (not currently browsing history); otherwise an index counting back
   * from the end of `history` (0 = most recent). Reset whenever the line is edited by any means
   * other than Up/Down, so e.g. typing after recalling a history entry starts a new fresh line the
   * next time Up is pressed, rather than resuming from the middle of history. */
  let historyIndex = -1;
  /** Accumulates bytes of an in-progress CSI escape sequence (arrow keys, Insert) across possibly
   * multiple `handleInput` calls, since VS Code's pty doesn't guarantee a multi-byte sequence
   * arrives in a single call. Reset to '' once a sequence resolves (recognized or discarded). */
  let escapeBuffer = '';
  /** The direction whose idle-flushed partial line left a row open at the bottom of the scroll
   * region, if any. The next record for that same direction is appended to that row rather than
   * starting a new one; anything else closes it first, so the saved cursor position can never be
   * invalidated by an intervening scroll. */
  let openRow: 'TX' | 'RX' | undefined;
  /** Decodes device-console bytes across reads so a multi-byte character split between two reads
   * doesn't render as two replacement characters. Only used while Device Console is on; line mode
   * gets its text already decoded, from the connection's assembler. */
  let consoleDecoder = new TextDecoder('utf-8', { fatal: false });
  /** Mirrors the connection's `deviceConsole` flag. Kept separately so the transition can be
   * detected in `syncDeviceConsole` — entering and leaving each need one-time screen surgery
   * (releasing and re-establishing the scroll region), not just a different rendering path. */
  let consoleActive = false;

  let connection: PortConnection | undefined;
  let connected = false;
  let opened = false;
  /** Traffic/banner text produced before VS Code has called `pty.open()`, replayed in order once it
   * does. VS Code only subscribes to `onDidWrite` at open time, and only calls `open()` when the
   * terminal is first actually rendered — so anything fired into `writeEmitter` before then is
   * silently discarded. A session whose port is opened (and starts sending/receiving) while its
   * terminal has never been revealed would therefore lose that traffic from the terminal entirely,
   * even though the file log — reading the very same `TrafficEvent`s — recorded all of it. That
   * mismatch is what "the log file is correct, but the terminal is not" was. Only the raw text is
   * buffered, never the cursor-positioning escapes around it: `rows` isn't known until `open()`
   * either, so the positioning has to be computed at replay time, not at print time. */
  let pendingOutput = '';
  /** Set before we call `terminal.dispose()` ourselves, so the resulting `pty.close()` callback
   * (VS Code calls it either way) can tell "I disposed this" apart from a real user terminal-kill
   * and skip firing `onDidUserClose` for the former. */
  let disposing = false;

  let trafficSub: vscode.Disposable | undefined;
  let rawSub: vscode.Disposable | undefined;
  let updateSub: vscode.Disposable | undefined;
  let connectionCloseSub: vscode.Disposable | undefined;

  const scrollRegionSequence = (): string => `\x1b[1;${rows - 1}r`;

  const setScrollRegion = (): void => {
    writeEmitter.fire(scrollRegionSequence());
  };

  /** Redraws the pinned input row: prompt + the input line clipped to a horizontally-scrolling
   * window that always keeps the cursor visible and never exceeds the terminal's actual width.
   * This clipping is what prevents the input line from ever wrapping onto a second physical row —
   * previously, a line long enough to overflow the terminal's width (with no `columns` tracking at
   * all) would wrap, and the redraw/erase logic only ever touched the single pinned row, leaving
   * stale wrapped characters behind and corrupting the display on the next redraw. The window
   * (`offset`) is recomputed fresh from `cursorPos` on every call rather than persisted, so moving
   * the cursor in either direction naturally scrolls the window to follow it. Also positions the
   * real terminal cursor at its on-screen column and sets its DECSCUSR shape per `insertMode`.
   * A no-op in Device Console mode, which has no pinned row to draw. */
  const redrawInputLine = (): void => {
    if (consoleActive) {
      return;
    }
    const prompt = promptFor();
    const displayLine = connected ? line : '';
    const displayCursorPos = connected ? cursorPos : 0;
    const available = Math.max(1, columns - prompt.length);
    const offset = displayLine.length > available ? Math.max(0, displayCursorPos - available + 1) : 0;
    const clipped = displayLine.slice(offset, offset + available);
    const cursorCol = prompt.length + (displayCursorPos - offset) + 1;
    const cursorStyle = insertMode ? CURSOR_STYLE_INSERT : CURSOR_STYLE_OVERWRITE;
    // Re-assert scroll region on every write (xterm.js resets it on buffer resize, including
    // the internal resize VS Code does right after pty.open(), so we need to restore it each time)
    writeEmitter.fire(`${scrollRegionSequence()}\x1b[${rows};1H\x1b[2K${prompt}${clipped}\x1b[${rows};${cursorCol}H${cursorStyle}`);
  };

  /** Writes text (must end `\r\n`) into the scroll region, then restores the pinned input line. */
  const printAboveInput = (text: string): void => {
    if (!opened) {
      pendingOutput += text;
      if (pendingOutput.length > PENDING_OUTPUT_MAX_CHARS) {
        // Drop whole lines off the front, never a partial one — slicing mid-escape-sequence would
        // replay a truncated escape and corrupt the display.
        const cut = pendingOutput.indexOf('\n', pendingOutput.length - PENDING_OUTPUT_MAX_CHARS);
        pendingOutput = cut === -1 ? '' : pendingOutput.slice(cut + 1);
      }
      return; // `rows`/`columns` aren't known yet; `open()` draws everything once they are
    }
    closeOpenRow();
    writeEmitter.fire(`\x1b[${rows - 1};1H${text}`);
    redrawInputLine();
  };

  /** Terminates a row an earlier partial line left open, so whatever prints next starts cleanly on
   * its own row. The device may still finish that line later; it simply gets its own row and header
   * at that point, which is the honest rendering — the alternative is re-anchoring to a saved cursor
   * position that an intervening scroll has already invalidated. */
  function closeOpenRow(): void {
    if (!openRow) {
      return;
    }
    openRow = undefined;
    writeEmitter.fire(`${RESTORE_CURSOR}${RESET}\r\n`);
  }

  function promptFor(): string {
    if (!connected || !connection) {
      return '(disconnected) ';
    }
    return connection.hexSend ? 'hex> ' : '> ';
  }

  /**
   * Renders one record as a terminal row.
   *
   * Colour precedence is **device → severity → configured**: if the device coloured the line
   * itself, that is left strictly alone (overriding it would defeat the entire point of ANSI
   * support); otherwise a detected severity colours the row; otherwise the user's configured TX/RX
   * colour applies. The `[timestamp MODE DIR]` header is always dim, so it never competes with the
   * payload for attention.
   */
  function printRecord(conn: PortConnection, record: TrafficRecord): void {
    if (record.kind === 'hex') {
      const color = ansiTruecolor(record.direction === 'TX' ? colors.tx : colors.rx);
      printAboveInput(
        `${headerFor(conn, record.timestamp, record.direction, true)}${color}${bytesToHex(record.bytes)}${RESET}\r\n`,
      );
      return;
    }
    const appending = record.continued && openRow === record.direction;
    if (!appending) {
      closeOpenRow();
    }
    const deviceColored = record.render.includes(ESC);
    // `||`, not `??`: an empty severity colour means "no override", so it has to fall through to
    // the configured direction colour rather than winning as a valid-but-empty value.
    const severityColor = record.severity ? ansiTruecolor(colors.severity[record.severity]) : '';
    const color = deviceColored ? '' : severityColor || ansiTruecolor(record.direction === 'TX' ? colors.tx : colors.rx);
    const header = appending ? '' : headerFor(conn, record.timestamp, record.direction, false);
    const position = appending ? RESTORE_CURSOR : `\x1b[${rows - 1};1H`;
    const body = `${header}${color}${record.render}${RESET}`;
    if (record.continues) {
      // The device hasn't finished this line. Show what it has said so far and remember where the
      // row ends, so the rest of the line lands on this row rather than a new one.
      openRow = record.direction;
      writeEmitter.fire(`${position}${body}${SAVE_CURSOR}`);
    } else {
      openRow = undefined;
      writeEmitter.fire(`${position}${body}\r\n`);
    }
    redrawInputLine();
  }

  function headerFor(conn: PortConnection, timestamp: string, direction: 'TX' | 'RX', hex: boolean): string {
    if (!conn.showTimestamp) {
      return '';
    }
    return `${DIM}${formatTrafficHeader(timestamp, direction, hex, formatSettings.compactTimestamps)}${RESET} `;
  }

  /** Applies the connection's current Device Console setting, doing the one-time screen surgery
   * each transition needs. Turning it on releases the scroll region and erases the pinned row so
   * the device owns the whole screen; turning it off re-establishes both. */
  function syncDeviceConsole(): void {
    const want = connected && connection ? connection.deviceConsole : false;
    if (want === consoleActive) {
      return;
    }
    if (want) {
      closeOpenRow();
      consoleActive = true;
      consoleDecoder = new TextDecoder('utf-8', { fatal: false });
      // Erase the pinned row before releasing the region, or its text is left stranded on screen
      // with nothing that will ever redraw over it.
      writeEmitter.fire(`\x1b[${rows};1H\x1b[2K\x1b[r\x1b[${rows};1H`);
    } else {
      consoleActive = false;
      writeEmitter.fire(`${RESET}\r\n`);
      redrawInputLine();
    }
  }

  function subscribeToConnection(conn: PortConnection): void {
    trafficSub = conn.onDidRecord((record) => {
      if (consoleActive) {
        return; // Device Console renders from `onDidRawData` instead; records still drive the log
      }
      try {
        printRecord(conn, record);
      } catch {
        // Defensive backstop: a malformed/unexpected record should never leave the terminal in a
        // corrupted or stuck state (e.g. a partially-written scroll-region escape) — degrade to a
        // plain marker instead of breaking the whole session's display.
        openRow = undefined;
        printAboveInput(`${DIM}[render error]${RESET}\r\n`);
      }
    });
    rawSub = conn.onDidRawData((bytes) => {
      if (!consoleActive) {
        return;
      }
      // Verbatim: escape sequences, cursor movement and all. A device sending bare LF will
      // stair-step here exactly as it would under any other raw terminal — translating it would
      // make this mode something other than raw.
      writeEmitter.fire(consoleDecoder.decode(bytes, { stream: true }));
    });
    updateSub = conn.onDidUpdate(() => {
      syncDeviceConsole();
      redrawInputLine();
    });
    connectionCloseSub = conn.onDidClose(() => detach());
  }

  const attach = (conn: PortConnection): void => {
    if (connected && connection === conn) {
      return;
    }
    connection = conn;
    connected = true;
    line = '';
    cursorPos = 0;
    historyIndex = -1;
    escapeBuffer = '';
    insertMode = true;
    openRow = undefined;
    subscribeToConnection(conn);
    syncDeviceConsole();
    if (opened) {
      printAboveInput(`Connected to ${path}. Type data and press Enter to send. Ctrl+L clears the screen.\r\n`);
    }
  };

  const detach = (): void => {
    if (!connected) {
      return;
    }
    connected = false;
    trafficSub?.dispose();
    rawSub?.dispose();
    updateSub?.dispose();
    connectionCloseSub?.dispose();
    trafficSub = undefined;
    rawSub = undefined;
    updateSub = undefined;
    connectionCloseSub = undefined;
    connection = undefined;
    line = '';
    cursorPos = 0;
    historyIndex = -1;
    escapeBuffer = '';
    openRow = undefined;
    // The port is gone, so there is nothing left to type at: restore the pinned row unconditionally
    // rather than leaving the user in a device console with no device behind it.
    if (consoleActive) {
      consoleActive = false;
      setScrollRegion();
    }
    if (opened) {
      printAboveInput('Port disconnected. Reopen to resume.\r\n');
    }
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: (initialDimensions) => {
      if (initialDimensions) {
        rows = initialDimensions.rows;
        columns = initialDimensions.columns;
      }
      opened = true;
      if (pendingOutput.length === 0) {
        // Genuinely nothing happened before this terminal was first revealed, so state the current
        // state. If anything *did* happen, `pendingOutput` already opens with the matching banner
        // (attach's "Connected" or detach's "disconnected") from when it actually happened —
        // printing a state banner here too would contradict it.
        pendingOutput = connected
          ? `Connected to ${path}. Type data and press Enter to send. Ctrl+L clears the screen.\r\n`
          : `Port ${path} is closed. Open it in the Sessions panel to send/receive.\r\n`;
      }
      // Replay all buffered output as one write with scroll region re-asserted
      const replay = pendingOutput;
      pendingOutput = '';
      consoleActive = false;
      writeEmitter.fire(`${scrollRegionSequence()}${replay}`);
      redrawInputLine();
      syncDeviceConsole();
    },
    close: () => {
      writeEmitter.fire('\x1b[r');
      if (!disposing) {
        userCloseEmitter.fire();
      }
    },
    setDimensions: (dimensions) => {
      if (dimensions.rows === rows && dimensions.columns === columns) {
        return; // nothing changed that affects the pinned row
      }
      if (consoleActive) {
        // No scroll region and no pinned row to reposition — the device owns the screen and will
        // redraw it however it wants to.
        rows = dimensions.rows;
        columns = dimensions.columns;
        return;
      }
      if (dimensions.rows !== rows) {
        writeEmitter.fire(`\x1b[${rows};1H\x1b[2K`); // clear old input row before it moves
        rows = dimensions.rows;
        setScrollRegion();
      }
      columns = dimensions.columns;
      redrawInputLine();
    },
    handleInput: (data: string) => {
      if (!connected || !connection) {
        return; // input is blocked while disconnected
      }
      const activeConnection = connection;

      if (consoleActive) {
        // Transparent console: every byte goes to the device untouched, which is the whole point —
        // Ctrl+C interrupts a MicroPython loop, Ctrl+D soft-reboots it, and arrow keys reach the
        // device's own line editor instead of ours. Enter is the one substitution, since what a
        // device accepts as "end of line" is the session's configured choice, not whatever byte VS
        // Code happens to send for the Enter key.
        void sendKeystrokes(activeConnection, data, printAboveInput);
        return;
      }

      const recallHistory = (direction: -1 | 1): void => {
        if (history.length === 0) {
          return;
        }
        if (direction === -1) {
          // Up: older
          if (historyIndex < history.length - 1) {
            historyIndex++;
            line = history[history.length - 1 - historyIndex];
            cursorPos = line.length;
            redrawInputLine();
          }
          return;
        }
        // Down: newer
        if (historyIndex > 0) {
          historyIndex--;
          line = history[history.length - 1 - historyIndex];
          cursorPos = line.length;
          redrawInputLine();
        } else if (historyIndex === 0) {
          historyIndex = -1;
          line = '';
          cursorPos = 0;
          redrawInputLine();
        }
      };

      const moveCursor = (delta: -1 | 1): void => {
        if (activeConnection.hexSend) {
          return; // hex-mode input always tracks the end of the line; see the hex branch below
        }
        const next = cursorPos + delta;
        if (next < 0 || next > line.length) {
          return;
        }
        cursorPos = next;
        redrawInputLine();
      };

      for (const ch of data) {
        // Escape sequences (arrow keys, Insert) can arrive split across multiple handleInput
        // calls, so escapeBuffer is accumulated at closure scope rather than per-call.
        if (escapeBuffer.length > 0) {
          escapeBuffer += ch;
          if (escapeBuffer === '\x1b[A') {
            recallHistory(-1);
            escapeBuffer = '';
            continue;
          }
          if (escapeBuffer === '\x1b[B') {
            recallHistory(1);
            escapeBuffer = '';
            continue;
          }
          if (escapeBuffer === '\x1b[C') {
            moveCursor(1);
            escapeBuffer = '';
            continue;
          }
          if (escapeBuffer === '\x1b[D') {
            moveCursor(-1);
            escapeBuffer = '';
            continue;
          }
          if (escapeBuffer === '\x1b[2~') {
            insertMode = !insertMode;
            redrawInputLine();
            escapeBuffer = '';
            continue;
          }
          if (escapeBuffer === '\x1b[2' || escapeBuffer === '\x1b[' || escapeBuffer === '\x1b') {
            continue; // valid prefix of a known sequence; wait for more bytes
          }
          escapeBuffer = ''; // unrecognized sequence; discard silently
          continue;
        }
        if (ch === ESC) {
          escapeBuffer = ch;
          continue;
        }
        if (ch === ENTER) {
          const sent = line;
          if (sent.trim().length > 0 && history[history.length - 1] !== sent) {
            history.push(sent);
            if (history.length > HISTORY_LIMIT) {
              history.shift();
            }
          }
          line = '';
          cursorPos = 0;
          historyIndex = -1;
          redrawInputLine();
          void sendLine(activeConnection, sent, printAboveInput);
          continue;
        }
        if (ch === BACKSPACE) {
          if (activeConnection.hexSend) {
            if (line.length > 0) {
              line = line.slice(0, -1);
              cursorPos = line.length;
              historyIndex = -1;
              redrawInputLine();
            }
          } else if (cursorPos > 0) {
            line = line.slice(0, cursorPos - 1) + line.slice(cursorPos);
            cursorPos--;
            historyIndex = -1;
            redrawInputLine();
          }
          continue;
        }
        if (ch === CTRL_C) {
          line = '';
          cursorPos = 0;
          historyIndex = -1;
          redrawInputLine();
          continue;
        }
        if (ch === CTRL_L) {
          writeEmitter.fire('\x1b[2J\x1b[3J\x1b[H');
          redrawInputLine();
          continue;
        }
        if (ch < ' ') {
          continue; // drop other control chars
        }
        if (activeConnection.hexSend && !isHexDigitChar(ch)) {
          continue; // reject non-hex keystrokes silently; spaces between byte pairs are auto-inserted
        }
        if (activeConnection.hexSend) {
          line = appendHexInputChar(line, ch);
          cursorPos = line.length;
        } else if (insertMode) {
          line = line.slice(0, cursorPos) + ch + line.slice(cursorPos);
          cursorPos++;
        } else {
          line = line.slice(0, cursorPos) + ch + line.slice(cursorPos + 1);
          cursorPos++;
        }
        historyIndex = -1;
        redrawInputLine();
      }
    },
  };

  const terminal = vscode.window.createTerminal({ name: `Serial: ${path}`, pty });

  return {
    terminal,
    attach,
    detach,
    onDidUserClose: userCloseEmitter.event,
    dispose: () => {
      disposing = true;
      trafficSub?.dispose();
      rawSub?.dispose();
      updateSub?.dispose();
      connectionCloseSub?.dispose();
      writeEmitter.dispose();
      closeEmitter.dispose();
      userCloseEmitter.dispose();
      terminal.dispose();
    },
  };
}

/** Converts a "#rrggbb" hex color into a 24-bit ANSI SGR foreground-color escape sequence.
 * Returns an empty string (no color override) for anything that doesn't parse as one. */
function ansiTruecolor(hex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) {
    return '';
  }
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Sends one typed line, appending the session's configured line ending. Without it an embedded
 * console never sees a completed command — an ESP-IDF console, a Zephyr shell and an AT-command
 * modem all wait for a terminator before acting on anything. Hex sends never get one: the user
 * spelled out the exact bytes they wanted on the wire.
 */
async function sendLine(
  connection: PortConnection,
  line: string,
  printAboveInput: (text: string) => void,
): Promise<void> {
  if (line.trim().length === 0) {
    return;
  }
  try {
    const bytes = connection.hexSend
      ? hexStringToBytes(line)
      : concatBytes(asciiStringToBytes(line), LINE_ENDING_BYTES[connection.lineEnding]);
    await connection.write(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printAboveInput(`${ERROR_COLOR}${message}${RESET}\r\n`);
  }
}

/** Device Console keystroke passthrough: the typed bytes go to the device as-is, except that the
 * Enter key's CR is replaced by the session's configured line ending. */
async function sendKeystrokes(
  connection: PortConnection,
  data: string,
  printAboveInput: (text: string) => void,
): Promise<void> {
  try {
    const ending = LINE_ENDING_BYTES[connection.lineEnding];
    let bytes: Uint8Array = new Uint8Array(0);
    for (const ch of data) {
      bytes = concatBytes(bytes, ch === ENTER ? ending : asciiStringToBytes(ch));
    }
    if (bytes.length > 0) {
      await connection.write(bytes);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printAboveInput(`${ERROR_COLOR}${message}${RESET}\r\n`);
  }
}
