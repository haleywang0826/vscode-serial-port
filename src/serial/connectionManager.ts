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
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
};

export interface PortStats {
  bytesSent: number;
  bytesReceived: number;
}

/** Live handle to one open serial port: I/O, config, format toggles, counters, and optional recording. */
export class PortConnection {
  readonly path: string;
  config: PortConfig;
  hexSend = true;
  hexRecv = true;
  recording = false;
  readonly stats: PortStats = { bytesSent: 0, bytesReceived: 0 };

  private readonly port: SerialPort;
  private outputChannel: vscode.OutputChannel | undefined;

  private readonly onDidReceiveDataEmitter = new vscode.EventEmitter<Uint8Array>();
  readonly onDidReceiveData = this.onDidReceiveDataEmitter.event;

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
        this.stats.bytesSent += bytes.length;
        this.appendLog('TX', bytes);
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

  setRecording(value: boolean): void {
    this.recording = value;
    if (value) {
      this.getOutputChannel().show(true);
    }
    this.onDidUpdateEmitter.fire();
  }

  get isOpen(): boolean {
    return this.port.isOpen;
  }

  dispose(): void {
    this.outputChannel?.dispose();
    this.onDidReceiveDataEmitter.dispose();
    this.onDidCloseEmitter.dispose();
    this.onDidUpdateEmitter.dispose();
  }

  private handleIncoming(chunk: Buffer): void {
    const bytes = new Uint8Array(chunk);
    this.stats.bytesReceived += bytes.length;
    this.appendLog('RX', bytes);
    this.onDidReceiveDataEmitter.fire(bytes);
    this.onDidUpdateEmitter.fire();
  }

  private appendLog(direction: 'TX' | 'RX', bytes: Uint8Array): void {
    if (!this.recording) {
      return;
    }
    const timestamp = new Date().toISOString().slice(11, 23);
    const formatted = formatBytes(bytes, direction === 'TX' ? this.hexSend : this.hexRecv);
    this.getOutputChannel().appendLine(`[${timestamp}] ${direction}: ${formatted}`);
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel(`Serial: ${this.path}`);
    }
    return this.outputChannel;
  }
}

/** Registry of currently-open ports, keyed by device path. */
export class ConnectionManager {
  private readonly connections = new Map<string, PortConnection>();

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
    const connection = new PortConnection(path, config);
    await connection.open();
    connection.onDidUpdate(() => this.onDidChangeEmitter.fire());
    connection.onDidClose(() => {
      this.connections.delete(path);
      connection.dispose();
      this.onDidChangeEmitter.fire();
    });
    this.connections.set(path, connection);
    this.onDidChangeEmitter.fire();
    return connection;
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
