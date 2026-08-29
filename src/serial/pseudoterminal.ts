import * as vscode from 'vscode';
import { PortConnection } from './connectionManager';
import { asciiStringToBytes, formatBytes, hexStringToBytes, isHexInputChar } from './format';

const ENTER = '\r';
const BACKSPACE = '\x7f';
const CTRL_C = '\x03';

export interface SerialTerminal {
  terminal: vscode.Terminal;
  dispose(): void;
}

/**
 * Creates an interactive terminal for one open port: renders incoming data live (formatted per
 * the connection's hex/ascii toggle) and sends whatever the user types on Enter. While "hex send"
 * is on, keystrokes that aren't hex digits/spaces are rejected as they're typed.
 *
 * Incoming data is never written straight to the cursor position, since that would land in the
 * middle of whatever the user is currently typing. Instead every write clears the in-progress
 * input line, prints the new output above it, then redraws the prompt + typed-so-far text — so
 * the input line always stays pinned as the last line of the terminal.
 */
export function createSerialTerminal(connection: PortConnection): SerialTerminal {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<void>();
  let line = '';

  const printAboveInput = (text: string): void => {
    writeEmitter.fire('\r\x1b[2K' + text + promptFor(connection) + line);
  };

  const dataSub = connection.onDidReceiveData((bytes) => {
    printAboveInput(formatBytes(bytes, connection.hexRecv) + '\r\n');
  });

  const connectionCloseSub = connection.onDidClose(() => closeEmitter.fire());

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      writeEmitter.fire(`Connected to ${connection.path}. Type data and press Enter to send.\r\n`);
      writeEmitter.fire(promptFor(connection));
    },
    close: () => {
      void connection.close();
    },
    handleInput: (data: string) => {
      for (const ch of data) {
        if (ch === ENTER) {
          void sendLine(connection, line, printAboveInput);
          line = '';
          writeEmitter.fire('\r\n' + promptFor(connection));
          continue;
        }
        if (ch === BACKSPACE) {
          if (line.length > 0) {
            line = line.slice(0, -1);
            writeEmitter.fire('\b \b');
          }
          continue;
        }
        if (ch === CTRL_C) {
          line = '';
          writeEmitter.fire('\r\n' + promptFor(connection));
          continue;
        }
        if (ch < ' ') {
          continue; // drop other control chars / escape sequences
        }
        if (connection.hexSend && !isHexInputChar(ch)) {
          continue; // reject non-hex keystrokes silently while in hex-send mode
        }
        line += ch;
        writeEmitter.fire(ch);
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
