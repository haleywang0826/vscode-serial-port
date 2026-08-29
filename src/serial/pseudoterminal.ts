import * as vscode from 'vscode';
import { PortConnection, TrafficEvent } from './connectionManager';
import { asciiStringToBytes, formatBytesForTerminal, hexStringToBytes, isHexInputChar } from './format';

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
 * Creates an interactive terminal for one open port: renders every TX/RX event live (colored by
 * direction, formatted per the connection's hex/ascii toggles, optionally timestamped) and sends
 * whatever the user types on Enter. TX is rendered from the connection's `onDidTraffic` event, the
 * same source the file log reads from, so a template send (or any other write) shows up here too —
 * not just terminal-typed input. While "hex send" is on, keystrokes that aren't hex digits/spaces
 * are rejected as they're typed.
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
export function createSerialTerminal(connection: PortConnection, colors: TerminalColors): SerialTerminal {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<void>();
  let line = '';
  let rows = DEFAULT_ROWS;

  const setScrollRegion = (): void => {
    writeEmitter.fire(`\x1b[1;${rows - 1}r`);
  };

  const redrawInputLine = (): void => {
    writeEmitter.fire(`\x1b[${rows};1H\x1b[2K${promptFor(connection)}${line}`);
  };

  /** Writes text (must end `\r\n`) into the scroll region, then restores the pinned input line. */
  const printAboveInput = (text: string): void => {
    writeEmitter.fire(`\x1b[${rows - 1};1H${text}`);
    redrawInputLine();
  };

  const trafficSub = connection.onDidTraffic((event) => {
    printAboveInput(formatTrafficLine(connection, event, colors));
  });

  const updateSub = connection.onDidUpdate(() => redrawInputLine());

  const connectionCloseSub = connection.onDidClose(() => closeEmitter.fire());

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: (initialDimensions) => {
      if (initialDimensions) {
        rows = initialDimensions.rows;
      }
      setScrollRegion();
      printAboveInput(`Connected to ${connection.path}. Type data and press Enter to send. Ctrl+L clears the screen.\r\n`);
    },
    close: () => {
      writeEmitter.fire('\x1b[r');
      void connection.close();
    },
    setDimensions: (dimensions) => {
      rows = dimensions.rows;
      setScrollRegion();
      redrawInputLine();
    },
    handleInput: (data: string) => {
      for (const ch of data) {
        if (ch === ENTER) {
          const sent = line;
          line = '';
          redrawInputLine();
          void sendLine(connection, sent, printAboveInput);
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
        if (connection.hexSend && !isHexInputChar(ch)) {
          continue; // reject non-hex keystrokes silently while in hex-send mode
        }
        line += ch;
        redrawInputLine();
      }
    },
  };

  const terminal = vscode.window.createTerminal({ name: `Serial: ${connection.path}`, pty });

  return {
    terminal,
    dispose: () => {
      trafficSub.dispose();
      updateSub.dispose();
      connectionCloseSub.dispose();
      writeEmitter.dispose();
      closeEmitter.dispose();
      terminal.dispose();
    },
  };
}

function promptFor(connection: PortConnection): string {
  return connection.hexSend ? 'hex> ' : '> ';
}

/** Renders one TX/RX event for the terminal: colored by direction using the user-configured
 * `colors`, optionally prefixed with the shared timestamp from the event (the same value written
 * to the file log, never recomputed). */
function formatTrafficLine(connection: PortConnection, event: TrafficEvent, colors: TerminalColors): string {
  const hex = event.direction === 'TX' ? connection.hexSend : connection.hexRecv;
  const color = ansiTruecolor(event.direction === 'TX' ? colors.tx : colors.rx);
  const prefix = connection.showTimestamp ? `${DIM}[${event.timestamp}] ${event.direction}${RESET} ` : '';
  return `${prefix}${color}${formatBytesForTerminal(event.bytes, hex)}${RESET}\r\n`;
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
