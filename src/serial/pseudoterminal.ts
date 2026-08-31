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

const DEFAULT_ROWS = 24;

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
  let rows = DEFAULT_ROWS;
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

  const redrawInputLine = (): void => {
    writeEmitter.fire(`\x1b[${rows};1H\x1b[2K${promptFor()}${connected ? line : ''}`);
  };

  /** Writes text (must end `\r\n`) into the scroll region, then restores the pinned input line. */
  const printAboveInput = (text: string): void => {
    writeEmitter.fire(`\x1b[${rows - 1};1H${text}`);
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
      if (dimensions.rows === rows) {
        return; // width-only change; the pinned row's position didn't move
      }
      writeEmitter.fire(`\x1b[${rows};1H\x1b[2K`); // clear old input row before it moves
      rows = dimensions.rows;
      setScrollRegion();
      redrawInputLine();
    },
    handleInput: (data: string) => {
      if (!connected || !connection) {
        return; // input is blocked while disconnected
      }
      const activeConnection = connection;
      for (const ch of data) {
        if (ch === ENTER) {
          const sent = line;
          line = '';
          redrawInputLine();
          void sendLine(activeConnection, sent, printAboveInput);
          continue;
        }
        if (ch === BACKSPACE) {
          if (line.length > 0) {
            line = line.slice(0, -1);
            redrawInputLine();
          }
          continue;
        }
        if (ch === CTRL_C) {
          line = '';
          redrawInputLine();
          continue;
        }
        if (ch === CTRL_L) {
          writeEmitter.fire('\x1b[2J\x1b[3J\x1b[H');
          redrawInputLine();
          continue;
        }
        if (ch < ' ') {
          continue; // drop other control chars / escape sequences
        }
        if (activeConnection.hexSend && !isHexDigitChar(ch)) {
          continue; // reject non-hex keystrokes silently; spaces between byte pairs are auto-inserted
        }
        line = activeConnection.hexSend ? appendHexInputChar(line, ch) : line + ch;
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
    const bytes = connection.hexSend ? hexStringToBytes(line) : asciiStringToBytes(line);
    await connection.write(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printAboveInput(`${ERROR_COLOR}${message}${RESET}\r\n`);
  }
}
