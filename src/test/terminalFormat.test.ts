import * as assert from 'assert';
import * as vscode from 'vscode';
import { DEFAULT_PORT_CONFIG, PortConnection, TrafficEvent } from '../serial/connectionManager';
import { formatBytes, formatBytesForTerminal } from '../serial/format';
import { createSerialTerminal } from '../serial/pseudoterminal';
import { RxTerminalFormatter, SgrState } from '../serial/terminalFormat';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

suite('Serial terminal ANSI formatting', () => {
  test('preserves ESP-IDF colors across reads without coloring empty rows', () => {
    const formatter = new RxTerminalFormatter();
    assert.strictEqual(formatter.format(bytes('\x1b[0;31m')), '');
    assert.strictEqual(
      formatter.format(bytes('E (42) app: error')),
      '\x1b[0m\x1b[31mE (42) app: error',
    );
    assert.strictEqual(formatter.format(bytes(' continued')), '\x1b[0m\x1b[31m continued');
    assert.strictEqual(formatter.format(bytes('\x1b[0m')), '');
    assert.strictEqual(formatter.format(bytes('plain')), '\x1b[0mplain');
  });

  test('handles every split boundary of basic, indexed, and truecolor sequences', () => {
    for (const escape of [
      '\x1b[31m',
      '\x1b[38;5;196m',
      '\x1b[38;2;255;64;0m',
      '\x1b[38:2::255:64:0m',
      '\x1b[1;3;4;38;2;255;255;255;48;2;128;128;128m',
    ]) {
      for (let split = 1; split < escape.length; split++) {
        const formatter = new RxTerminalFormatter();
        assert.strictEqual(formatter.format(bytes(escape.slice(0, split))), '');
        assert.strictEqual(
          formatter.format(bytes(escape.slice(split) + 'error')),
          escape + 'error',
        );
        assert.strictEqual(formatter.format(bytes('next')), escape + 'next');
      }
    }
  });

  test('preserves an escape fragment following visible text', () => {
    const formatter = new RxTerminalFormatter();
    assert.strictEqual(formatter.format(bytes('before\x1b[3')), 'before');
    assert.strictEqual(formatter.format(bytes('2mafter')), '\x1b[32mafter');
    assert.strictEqual(formatter.format(bytes('next')), '\x1b[32mnext');
  });

  test('tracks selective resets, default colors, and independent bold/dim attributes', () => {
    const state = new SgrState();
    state.update('\x1b[1;2;3;4;7;31;44m');
    state.update('\x1b[22;23;24;27;39;49m');
    assert.strictEqual(state.sequence, '\x1b[39;49m');
    state.update('\x1b[1;2m\x1b[m');
    assert.strictEqual(state.sequence, '\x1b[0m');
  });

  test('does not interpret RGB components as SGR attributes', () => {
    const state = new SgrState();
    state.update('\x1b[1;38;2;0;4;7;48;5;22;58;2;1;2;3m');
    assert.strictEqual(state.sequence, '\x1b[1;38;2;0;4;7;48;5;22;58;2;1;2;3m');
    state.update('\x1b[59m');
    assert.strictEqual(state.sequence, '\x1b[1;38;2;0;4;7;48;5;22m');
  });

  test('keeps style state bounded during long sessions', () => {
    const state = new SgrState();
    for (let i = 0; i < 10000; i++) {
      state.update(`\x1b[38;5;${i % 256}m`);
    }
    assert.strictEqual(state.sequence, '\x1b[38;5;15m');
  });

  test('keeps independent streams independent and drops cursor-control CSI', () => {
    const first = new RxTerminalFormatter();
    const second = new RxTerminalFormatter();
    first.format(bytes('\x1b[31m'));
    assert.strictEqual(second.format(bytes('plain')), 'plain');
    assert.strictEqual(first.format(bytes('\x1b[2Jerror\x1b[1;1H')), '\x1b[31merror');
  });

  test('preserves legacy traffic, TX passthrough, and hex representations', () => {
    const data = bytes('\x1b[31mE\r\n');
    assert.strictEqual(formatBytes(data, false), '\x1b[31mE\n');
    assert.strictEqual(formatBytesForTerminal(data, false), '\x1b[31mE\r\n');
    assert.strictEqual(formatBytesForTerminal(data, true), '1B 5B 33 31 6D 45 0D 0A');
  });

  test('retains upstream UTF-8 text and line-ending rendering', () => {
    const formatter = new RxTerminalFormatter();
    assert.strictEqual(formatter.format(bytes('\x1b[32m\u4f60\u597d\r\n')), '\x1b[32m\u4f60\u597d\r\n');
    assert.strictEqual(formatter.format(bytes('next\tline\n')), '\x1b[32mnext\tline\r\n');
  });

  test('PTY preserves RX fragments and colors across TX, and resets them on hex toggles', () => {
    const settings = { compactTimestamps: false, messageGapMs: 0 };
    const connection = new PortConnection('ANSI test (no hardware)', DEFAULT_PORT_CONFIG, settings);
    connection.setShowTimestamp(true);
    // Inject captured events without opening a hardware port.
    const internals = connection as unknown as { onDidTrafficEmitter: vscode.EventEmitter<TrafficEvent> };
    const serial = createSerialTerminal(connection.path, { tx: '#00cccc', rx: '#33cc33' }, settings);
    serial.attach(connection);
    const options = serial.terminal.creationOptions;
    assert.ok('pty' in options);
    const writes: string[] = [];
    const subscription = options.pty.onDidWrite((text) => writes.push(text));
    const send = (direction: 'TX' | 'RX', text: string): void => {
      internals.onDidTrafficEmitter.fire({
        direction, bytes: bytes(text), timestamp: '2026-09-05T16:20:32.280+08:00',
        hex: direction === 'RX' ? connection.hexRecv : connection.hexSend,
      });
    };
    try {
      send('RX', '\x1b[3');
      assert.deepStrictEqual(writes, []);
      send('TX', 'command');
      writes.length = 0;
      send('RX', '1merror');
      assert.ok(writes.join('').includes('\x1b[31merror\x1b[0m\r\n'));
      send('TX', 'another command');
      writes.length = 0;
      send('RX', 'continued');
      assert.ok(writes.join('').includes('\x1b[31mcontinued\x1b[0m\r\n'));
      assert.ok(writes.join('').includes('[2026-09-05T16:20:32.280+08:00 ASCII RX]\x1b[0m'));

      writes.length = 0;
      internals.onDidTrafficEmitter.fire({
        direction: 'TX', bytes: bytes('A'), timestamp: '2026-09-05T16:20:32.280+08:00', hex: true,
      });
      assert.ok(writes.join('').includes('HEX   TX]'));
      assert.ok(writes.join('').includes('41\x1b[0m'));

      connection.setHexRecv(true);
      writes.length = 0;
      send('RX', '\x1b[32m');
      assert.ok(writes.join('').includes('1B 5B 33 32 6D'));
      connection.setHexRecv(false);
      writes.length = 0;
      send('RX', 'plain');
      assert.ok(writes.join('').includes('\x1b[38;2;51;204;51mplain\x1b[0m'));
      assert.ok(!writes.join('').includes('\x1b[31m'));
      options.pty.handleInput?.('abc\x1b[DX');
      assert.ok(writes.join('').includes('> abXc'));

      send('RX', '\x1b[31m');
      serial.detach();
      writes.length = 0;
      options.pty.handleInput?.('blocked');
      assert.deepStrictEqual(writes, []);
      serial.attach(connection);
      writes.length = 0;
      send('RX', 'reconnected');
      assert.ok(writes.join('').includes('\x1b[38;2;51;204;51mreconnected\x1b[0m'));
      assert.ok(!writes.join('').includes('\x1b[31m'));
    } finally {
      subscription.dispose();
      serial.dispose();
      connection.dispose();
    }
  });
});
