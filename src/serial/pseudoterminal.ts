import * as vscode from 'vscode';
import { FormatSettings, PortConnection, TrafficEvent } from './connectionManager';
import {
  appendHexInputChar,
  asciiStringToBytes,
  concatBytes,
  formatBytes,
  formatBytesForTerminal,
  formatTrafficHeader,
  hexStringToBytes,
  isHexDigitChar,
  splitTrailingEscape,
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
/** DECSCUSR cursor-shape escapes (`CSI Ps SP q`, supported by VS Code's xterm.js-based terminal
 * renderer): a thin steady bar for insert mode (matches the vim/readline convention that a bar
 * cursor means "typing inserts"), a steady block for overwrite mode (typing replaces the character
 * under the cursor) — toggled by the Insert key. */
const CURSOR_STYLE_INSERT = '\x1b[6 q';
const CURSOR_STYLE_OVERWRITE = '\x1b[2 q';

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

/** User-configurable TX/RX terminal colors (hex, e.g. "#00cccc"), shared by reference from
 * `SerialPanelProvider` so a color change in Default Settings applies live to every already-open
 * terminal without needing to reopen the port. */
export interface TerminalColors {
  tx: string;
  rx: string;
}

/**
 * Creates an interactive terminal for one session, identified by `path`. The terminal exists
 * independent of whether the port is currently open — it starts (or falls back to) a disconnected
 * state with input blocked, and `attach`/`detach` bind/unbind it to a live `PortConnection` as the
 * port opens and closes, without ever recreating the underlying `vscode.Terminal`. This is what
 * lets a session's terminal (and its scrollback) survive a close/reopen cycle.
 *
 * While attached, every TX/RX event is rendered live (colored by direction, formatted per the
 * connection's hex/ascii toggles, optionally timestamped) and whatever the user types is sent on
 * Enter. TX is rendered from the connection's `onDidTraffic` event, the same source the file log
 * reads from, so a template send (or any other write) shows up here too — not just terminal-typed
 * input. While "hex send" is on, non-hex-digit keystrokes are rejected as they're typed, and a
 * space is auto-inserted between each typed byte pair (see `appendHexInputChar`) so the user never
 * has to type the separating spaces themselves.
 *
 * The input line is pinned to the terminal's actual bottom row via an ANSI scroll region
 * (DECSTBM, `\x1b[<top>;<bottom>r`) confined to rows 1..rows-1 — the same mechanism tmux's status
 * line and htop's header use. Incoming/echoed text is written into that confined region (so it
 * scrolls independently), while the last row sits outside the region and is only ever redrawn in
 * place, never scrolled — that's what keeps it pinned even when there isn't much content yet.
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
  /** Bytes held back from the previous RX event because they looked like an incomplete ANSI CSI
   * (color) sequence at the very end of the chunk — prepended to the next RX event before
   * formatting, so a sequence split across two `serialport` `'data'` reads still renders as one
   * color escape instead of garbling as two half-sequences. Ascii mode only; hex mode and TX never
   * carry anything over. Reset on every (re)attach since a new connection starts a new byte stream. */
  let pendingRx: Uint8Array = new Uint8Array(0);

  let connection: PortConnection | undefined;
  let connected = false;
  let opened = false;
  /** Set before we call `terminal.dispose()` ourselves, so the resulting `pty.close()` callback
   * (VS Code calls it either way) can tell "I disposed this" apart from a real user terminal-kill
   * and skip firing `onDidUserClose` for the former. */
  let disposing = false;

  let trafficSub: vscode.Disposable | undefined;
  let updateSub: vscode.Disposable | undefined;
  let connectionCloseSub: vscode.Disposable | undefined;

  const setScrollRegion = (): void => {
    writeEmitter.fire(`\x1b[1;${rows - 1}r`);
  };

  /** Redraws the pinned input row: prompt + the input line clipped to a horizontally-scrolling
   * window that always keeps the cursor visible and never exceeds the terminal's actual width.
   * This clipping is what prevents the input line from ever wrapping onto a second physical row —
   * previously, a line long enough to overflow the terminal's width (with no `columns` tracking at
   * all) would wrap, and the redraw/erase logic only ever touched the single pinned row, leaving
   * stale wrapped characters behind and corrupting the display on the next redraw. The window
   * (`offset`) is recomputed fresh from `cursorPos` on every call rather than persisted, so moving
   * the cursor in either direction naturally scrolls the window to follow it. Also positions the
   * real terminal cursor at its on-screen column and sets its DECSCUSR shape per `insertMode`. */
  const redrawInputLine = (): void => {
    const prompt = promptFor();
    const displayLine = connected ? line : '';
    const displayCursorPos = connected ? cursorPos : 0;
    const available = Math.max(1, columns - prompt.length);
    const offset = displayLine.length > available ? Math.max(0, displayCursorPos - available + 1) : 0;
    const clipped = displayLine.slice(offset, offset + available);
    const cursorCol = prompt.length + (displayCursorPos - offset) + 1;
    const cursorStyle = insertMode ? CURSOR_STYLE_INSERT : CURSOR_STYLE_OVERWRITE;
    writeEmitter.fire(`\x1b[${rows};1H\x1b[2K${prompt}${clipped}\x1b[${rows};${cursorCol}H${cursorStyle}`);
  };

  /** Writes text (must end `\r\n`) into the scroll region, then restores the pinned input line.
   * Erases the row before writing it (`\x1b[2K`, the same defensive clear `redrawInputLine` and
   * `setDimensions` already apply to their own rows) so a shorter new line can never leave a
   * longer previous line's trailing characters dangling on screen — e.g. a stale hex-formatted
   * tail surviving past a shorter ASCII-decoded line, previously observed when this row's content
   * didn't get fully overwritten by the next write. */
  const printAboveInput = (text: string): void => {
    writeEmitter.fire(`\x1b[${rows - 1};1H\x1b[2K${text}`);
    redrawInputLine();
  };

  function promptFor(): string {
    if (!connected || !connection) {
      return '(disconnected) ';
    }
    return connection.hexSend ? 'hex> ' : '> ';
  }

  function subscribeToConnection(conn: PortConnection): void {
    trafficSub = conn.onDidTraffic((event) => {
      try {
        if (event.direction === 'RX' && !event.hex) {
          const merged = pendingRx.length > 0 ? concatBytes(pendingRx, event.bytes) : event.bytes;
          const { complete, pending } = splitTrailingEscape(merged);
          pendingRx = pending;
          printAboveInput(formatTrafficLine(conn, event, colors, formatSettings, complete));
          return;
        }
        pendingRx = new Uint8Array(0);
        printAboveInput(formatTrafficLine(conn, event, colors, formatSettings));
      } catch {
        // Defensive backstop: a malformed/unexpected event should never leave the terminal in a
        // corrupted or stuck state (e.g. a partially-written scroll-region escape) — degrade to a
        // plain hex dump instead of breaking the whole session's display.
        pendingRx = new Uint8Array(0);
        printAboveInput(`${DIM}[render error]${RESET} ${formatBytes(event.bytes, true)}\r\n`);
      }
    });
    updateSub = conn.onDidUpdate(() => redrawInputLine());
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
    pendingRx = new Uint8Array(0);
    subscribeToConnection(conn);
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
    updateSub?.dispose();
    connectionCloseSub?.dispose();
    trafficSub = undefined;
    updateSub = undefined;
    connectionCloseSub = undefined;
    connection = undefined;
    line = '';
    cursorPos = 0;
    historyIndex = -1;
    escapeBuffer = '';
    pendingRx = new Uint8Array(0);
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
      setScrollRegion();
      printAboveInput(
        connected
          ? `Connected to ${path}. Type data and press Enter to send. Ctrl+L clears the screen.\r\n`
          : `Port ${path} is closed. Open it in the Sessions panel to send/receive.\r\n`,
      );
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
      updateSub?.dispose();
      connectionCloseSub?.dispose();
      writeEmitter.dispose();
      closeEmitter.dispose();
      userCloseEmitter.dispose();
      terminal.dispose();
    },
  };
}

/** Renders one TX/RX event for the terminal: colored by direction using the user-configured
 * `colors`, optionally prefixed with the shared header built from the event's own captured
 * timestamp and mode (the same values written to the file log, never recomputed — see
 * `formatTrafficHeader`), rendered compact per the live `formatSettings.compactTimestamps` (read at
 * format time, so a later setting change never retroactively alters an already-printed line).
 * `bytesOverride`, when given, replaces `event.bytes` — used for RX-ascii-mode events whose bytes
 * were merged/split against a carried-over ANSI escape fragment (see `pendingRx` above). */
function formatTrafficLine(
  connection: PortConnection,
  event: TrafficEvent,
  colors: TerminalColors,
  formatSettings: FormatSettings,
  bytesOverride?: Uint8Array,
): string {
  const color = ansiTruecolor(event.direction === 'TX' ? colors.tx : colors.rx);
  const prefix = connection.showTimestamp
    ? `${DIM}${formatTrafficHeader(event.timestamp, event.direction, event.hex, formatSettings.compactTimestamps)}${RESET} `
    : '';
  return `${prefix}${color}${formatBytesForTerminal(bytesOverride ?? event.bytes, event.hex)}${RESET}\r\n`;
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

async function sendLine(
  connection: PortConnection,
  line: string,
  printAboveInput: (text: string) => void,
): Promise<void> {
  if (line.trim().length === 0) {
    return;
  }
  try {
    const hex = connection.hexSend;
    const bytes = hex ? hexStringToBytes(line) : asciiStringToBytes(line);
    await connection.write(bytes, hex);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printAboveInput(`${ERROR_COLOR}${message}${RESET}\r\n`);
  }
}
