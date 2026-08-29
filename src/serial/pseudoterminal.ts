import * as vscode from 'vscode';
import { PortConnection } from './connectionManager';
import { asciiStringToBytes, formatBytes, hexStringToBytes, isHexInputChar } from './format';

const ENTER = '\r';
const BACKSPACE = '\x7f';
const CTRL_C = '\x03';

const DEFAULT_ROWS = 24;

export interface SerialTerminal {
  terminal: vscode.Terminal;
  dispose(): void;
}

/**
 * Creates an interactive terminal for one open port: renders incoming data live (formatted per
 * the connection's hex/ascii toggle) and sends whatever the user types on Enter. While "hex send"
 * is on, keystrokes that aren't hex digits/spaces are rejected as they're typed.
 *
 * The input line is pinned to the terminal's actual bottom row via an ANSI scroll region
 * (DECSTBM, `\x1b[<top>;<bottom>r`) confined to rows 1..rows-1 — the same mechanism tmux's status
 * line and htop's header use. Incoming/echoed text is written into that confined region (so it
 * scrolls independently), while the last row sits outside the region and is only ever redrawn in
 * place, never scrolled — that's what keeps it pinned even when there isn't much content yet.
 */
export function createSerialTerminal(connection: PortConnection): SerialTerminal {
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

  const dataSub = connection.onDidReceiveData((bytes) => {
    printAboveInput(formatBytes(bytes, connection.hexRecv) + '\r\n');
  });

  const connectionCloseSub = connection.onDidClose(() => closeEmitter.fire());

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: (initialDimensions) => {
      if (initialDimensions) {
        rows = initialDimensions.rows;
      }
      setScrollRegion();
      printAboveInput(`Connected to ${connection.path}. Type data and press Enter to send.\r\n`);
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
          printAboveInput(`${promptFor(connection)}${sent}\r\n`);
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
      dataSub.dispose();
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
    printAboveInput(`\x1b[31m${message}\x1b[0m\r\n`);
  }
}
