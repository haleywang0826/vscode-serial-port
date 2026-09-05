import * as assert from 'assert';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { READABLE_LOG_LINE_LIMIT, ReadableLog } from '../serial/readableLog';
import { formatTrafficHeader } from '../serial/format';
import type { FormatSettings, PortConnection, TrafficEvent } from '../serial/connectionManager';
import type * as VSCode from 'vscode';

function capture() {
  const lines: string[] = [];
  const settings = { compactTimestamps: false };
  const log = new ReadableLog((line) => lines.push(line), settings);
  const write = (text: string, timestamp = 'first', direction: 'RX' | 'TX' = 'RX') =>
    log.write(direction, Buffer.from(text), timestamp);
  return { lines, log, write, settings };
}

suite('Readable serial log', () => {
  test('uses the shared header and reads compact timestamps when a line completes', () => {
    const { lines, write, settings } = capture();
    const timestamp = '2026-08-29T14:23:01.123+08:00';
    write('first\npending', timestamp);
    settings.compactTimestamps = true;
    write('-tail\n', '2026-08-29T14:24:01.123+08:00');
    assert.deepStrictEqual(lines, [
      `${formatTrafficHeader(timestamp, 'RX', false, false)} first\n`,
      `${formatTrafficHeader(timestamp, 'RX', false, true)} pending-tail\n`,
    ]);
  });

  test('buffers chunks until a logical line completes, using the first timestamp', () => {
    const { lines, write } = capture();
    write('hel');
    assert.deepStrictEqual(lines, []);
    write('lo\nnext\n', 'second');
    assert.deepStrictEqual(lines, ['[first ASCII RX] hello\n', '[second ASCII RX] next\n']);
  });

  test('normalizes CRLF, LF and CR and preserves empty lines', () => {
    const { lines, log, write } = capture();
    write('one\r');
    assert.deepStrictEqual(lines, ['[first ASCII RX] one\n']);
    write('\ntwo\n\rthree\r\r\n', 'second');
    log.flush();
    assert.deepStrictEqual(lines, [
      '[first ASCII RX] one\n', '[second ASCII RX] two\n', '[second ASCII RX] \n',
      '[second ASCII RX] three\n', '[second ASCII RX] \n',
    ]);
  });

  test('does not let a split CRLF give the next line the previous timestamp', () => {
    const { lines, write } = capture();
    write('one\r');
    write('\n', 'second');
    write('two\n', 'third');
    assert.deepStrictEqual(lines, ['[first ASCII RX] one\n', '[third ASCII RX] two\n']);
  });

  test('decodes UTF-8 across every byte boundary in independent directions', () => {
    const { lines, log } = capture();
    const bytes = Buffer.from('\u4f60\u597d \u{1f600}\n');
    for (let i = 0; i < bytes.length; i++) {
      log.write('RX', bytes.subarray(i, i + 1), `rx-${i}`);
      log.write('TX', bytes.subarray(i, i + 1), `tx-${i}`);
    }
    assert.deepStrictEqual(lines, ['[rx-0 ASCII RX] \u4f60\u597d \u{1f600}\n', '[tx-0 ASCII TX] \u4f60\u597d \u{1f600}\n']);
  });

  test('timestamps a split UTF-8 character that starts after a newline', () => {
    const { lines, log } = capture();
    log.write('RX', Buffer.from([0x61, 0x0a, 0xe4]), 'first');
    log.write('RX', Buffer.from([0xbd, 0xa0, 0x0a]), 'second');
    assert.deepStrictEqual(lines, ['[first ASCII RX] a\n', '[first ASCII RX] \u4f60\n']);
  });

  test('keeps unfinished RX and TX lines when directions alternate', () => {
    const { lines, log, write } = capture();
    write('rx-');
    write('tx-', 'second', 'TX');
    write('done\n', 'third', 'TX');
    write('done\n', 'fourth');
    write('rx-tail', 'fifth');
    write('tx-tail', 'sixth', 'TX');
    log.flush();
    assert.deepStrictEqual(lines, [
      '[second ASCII TX] tx-done\n', '[first ASCII RX] rx-done\n',
      '[fifth ASCII RX] rx-tail\n', '[sixth ASCII TX] tx-tail\n',
    ]);
  });

  test('strips split CSI, OSC, DCS, SOS, PM, APC and simple escapes', () => {
    const input = '\x1b[31mE (42) uart: \x1b[0m' +
      '\x1b]0;hidden title\x07a\x1b]8;;hidden link\x1b\\b' +
      '\x1bPprivate\npayload\x1b\\c\x1bXhidden\x1b\\d' +
      '\x1b^hidden\x1b\\e\x1b_hidden\x1b\\f\x1b(0g\x1b7h\n';
    for (let split = 0; split <= input.length; split++) {
      const { lines, write } = capture();
      write(input.slice(0, split));
      write(input.slice(split), split === 0 ? 'first' : 'second');
      assert.deepStrictEqual(lines, ['[first ASCII RX] [ERROR] E (42) uart: abcdefgh\n'], `split ${split}`);
    }
  });

  test('strips ANSI even when every byte is a separate event', () => {
    const { lines, log } = capture();
    const bytes = Buffer.from('\x1b]title\x1b\\\x1b[1;32mI (5) app: ok\x1b[0m\n');
    for (let i = 0; i < bytes.length; i++) {
      log.write('RX', bytes.subarray(i, i + 1), String(i));
    }
    assert.deepStrictEqual(lines, ['[0 ASCII RX] [INFO] I (5) app: ok\n']);
  });

  test('strips UTF-8 encoded C1 sequences and nonprinting controls, retaining tabs', () => {
    const { lines, write } = capture();
    write('\u009b31mhello\u009dtitle\u009c\tworld\u0090hidden\u009c\x00\x07\x7f\n');
    assert.deepStrictEqual(lines, ['[first ASCII RX] hello\tworld\n']);
  });

  test('strips raw eight-bit ANSI controls without damaging UTF-8 continuation bytes', () => {
    const { lines, log } = capture();
    const bytes = Buffer.concat([
      Buffer.from([0x9b]), Buffer.from('31m'),
      Buffer.from([0x9d]), Buffer.from('private'), Buffer.from([0x9c]),
      Buffer.from('\u00db\u261b\u{1f600}\n'),
    ]);
    for (const byte of bytes) {
      log.write('RX', new Uint8Array([byte]), 'first');
    }
    assert.deepStrictEqual(lines, ['[first ASCII RX] \u00db\u261b\u{1f600}\n']);
  });

  test('does not leak an unterminated escape or arbitrarily large control payload', () => {
    for (const escape of ['\x1b', '\x1b[123;', '\x1b]title', '\x1bPpayload', '\x1b^secret']) {
      const { lines, log, write } = capture();
      write('visible' + escape);
      if (escape.startsWith('\x1b]')) {
        write('x'.repeat(READABLE_LOG_LINE_LIMIT * 3));
      }
      log.flush();
      assert.deepStrictEqual(lines, ['[first ASCII RX] visible\n']);
      write('new\n', 'next');
      assert.strictEqual(lines[1], '[next ASCII RX] new\n');
    }
  });

  test('does not let an escape in one direction swallow the other direction', () => {
    const { lines, log, write } = capture();
    write('\x1b]private');
    write('command\n', 'second', 'TX');
    write('\x07reply\n', 'third');
    log.flush();
    assert.deepStrictEqual(lines, ['[second ASCII TX] command\n', '[first ASCII RX] reply\n']);
  });

  test('recognizes exactly the ESP-IDF level/ticks/tag prefix', () => {
    for (const [level, severity] of Object.entries({ E: 'ERROR', W: 'WARN', I: 'INFO', D: 'DEBUG', V: 'TRACE' })) {
      const { lines, write } = capture();
      write(`${level} (123) wifi_init: original payload\n`);
      assert.deepStrictEqual(lines, [`[first ASCII RX] [${severity}] ${level} (123) wifi_init: original payload\n`]);
    }
    for (const text of ['ERROR failure', 'prefix E (1) app: error', ' E (1) app: error',
      'E (abc) app: error', 'E (1) missing-tag', 'E (1) : error', 'e (1) app: error',
      'A (1) app: error', 'message mentions W (2) wifi: warning']) {
      const { lines, write } = capture();
      write(text + '\n');
      assert.deepStrictEqual(lines, [`[first ASCII RX] ${text}\n`]);
    }
  });

  test('flushes unterminated text and truncated UTF-8 once, then resets the decoder', () => {
    const { lines, log } = capture();
    log.write('RX', Buffer.from([0x61, 0xe4, 0xbd]), 'first');
    log.flush();
    log.flush();
    log.write('RX', Buffer.from('next\n'), 'second');
    assert.deepStrictEqual(lines, ['[first ASCII RX] a\uFFFD\n', '[second ASCII RX] next\n']);
  });

  test('flushing a single direction leaves the other pending line intact', () => {
    const { lines, log, write } = capture();
    write('rx');
    write('tx', 'second', 'TX');
    log.flush('RX');
    write('-tail\n', 'third', 'TX');
    write('new\n', 'fourth');
    assert.deepStrictEqual(lines, ['[first ASCII RX] rx\n', '[second ASCII TX] tx-tail\n', '[fourth ASCII RX] new\n']);
  });

  test('does not emit records for empty input or escape-only streams', () => {
    const { lines, log, write } = capture();
    write('');
    write('\x1b[31m\x1b[0m');
    log.flush();
    assert.deepStrictEqual(lines, []);
    write('text\n', 'second');
    assert.deepStrictEqual(lines, ['[second ASCII RX] text\n']);
  });

  test('bounds long lines with explicit continuation markers and the logical timestamp', () => {
    const { lines, log, write } = capture();
    write('x'.repeat(READABLE_LOG_LINE_LIMIT));
    assert.deepStrictEqual(lines, []);
    write('y'.repeat(READABLE_LOG_LINE_LIMIT), 'second');
    write('tail\n', 'third');
    log.flush();
    assert.deepStrictEqual(lines, [
      `[first ASCII RX] ${'x'.repeat(READABLE_LOG_LINE_LIMIT)} [continued]\n`,
      `[first ASCII RX] ${'y'.repeat(READABLE_LOG_LINE_LIMIT)} [continued]\n`,
      '[first ASCII RX] tail\n',
    ]);
  });

  test('does not split surrogate pairs or mark a complete boundary-sized line as continued', () => {
    const { lines, write } = capture();
    write('x'.repeat(READABLE_LOG_LINE_LIMIT - 1) + '\u{1f600}\n');
    write('y'.repeat(READABLE_LOG_LINE_LIMIT) + '\n', 'second');
    assert.deepStrictEqual(lines, [
      `[first ASCII RX] ${'x'.repeat(READABLE_LOG_LINE_LIMIT - 1)} [continued]\n`,
      '[first ASCII RX] \u{1f600}\n',
      `[second ASCII RX] ${'y'.repeat(READABLE_LOG_LINE_LIMIT)}\n`,
    ]);
  });

  test('retains the original severity across bounded continuation segments', () => {
    const { lines, write } = capture();
    write('W (1) app: ' + 'x'.repeat(READABLE_LOG_LINE_LIMIT) + '\n');
    assert.strictEqual(lines.length, 2);
    assert.ok(lines.every((line) => line.startsWith('[first ASCII RX] [WARN] ')));
  });
});

suite('Connection readable recording', () => {
  let connection: PortConnection;
  let internals: {
    appendLog(event: TrafficEvent): void;
    appendHistory(event: TrafficEvent): void;
    handleIncoming(chunk: Buffer): void;
    flushRxBuffer(force?: boolean): void;
    logFlushChain: Promise<void>;
    logBuffer: string;
    port: { emit(event: 'close'): boolean };
  };
  let vscode: typeof VSCode;
  let folder: VSCode.Uri;
  let settings: FormatSettings;

  setup(async () => {
    vscode = await import('vscode');
    const { PortConnection: Connection, DEFAULT_PORT_CONFIG } = await import('../serial/connectionManager.js');
    folder = vscode.Uri.file(join(__dirname, '..', '..', `.readable-log-tests-${randomUUID()}`));
    await vscode.workspace.fs.createDirectory(folder);
    settings = { compactTimestamps: false, messageGapMs: 25 };
    connection = new Connection('test-port', DEFAULT_PORT_CONFIG, settings);
    // Keep the real port unopened; this narrow harness injects traffic/close and awaits queued writes.
    internals = connection as unknown as typeof internals;
  });

  teardown(async () => {
    try {
      connection?.dispose();
      await internals?.logFlushChain;
    } finally {
      if (folder) {
        await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
      }
    }
  });

  function start(format: 'traffic' | 'readable' = 'readable') {
    connection.setRecording(true, folder, undefined, format);
  }

  function write(text: string, direction: 'RX' | 'TX' = 'RX', timestamp = 'first') {
    internals.appendLog({
      direction,
      bytes: Buffer.from(text),
      timestamp,
      hex: direction === 'RX' ? connection.hexRecv : connection.hexSend,
    });
  }

  async function readLog(path = connection.logFilePath): Promise<string> {
    assert.ok(path, 'recording should have a log file path');
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path))).toString('utf8');
  }

  test('retains the default traffic formatting', async () => {
    connection.setRecording(true, folder);
    write('a\r\n\x1b[31m');
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(await readLog(), '[first ASCII RX] a\n\x1b[31m\n');
  });

  test('honors per-event template modes rather than the live send toggle', async () => {
    start();
    write('pending', 'TX');
    internals.appendLog({ direction: 'TX', bytes: Buffer.from('A'), timestamp: 'second', hex: true });
    connection.setHexSend(true);
    internals.appendLog({ direction: 'TX', bytes: Buffer.from('text\n'), timestamp: 'third', hex: false });
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(await readLog(),
      '[first ASCII TX] pending\n[second HEX   TX] 41\n[third ASCII TX] text\n');
  });

  test('preserves raw traffic history with its original header settings and event modes', async () => {
    internals.appendHistory({ direction: 'RX', bytes: Buffer.from('\x1b[31mbare'), timestamp: 'first', hex: false });
    connection.setShowTimestamp(true);
    internals.appendHistory({ direction: 'TX', bytes: Buffer.from('A'), timestamp: 'second', hex: true });
    connection.setShowTimestamp(false);
    start('traffic');
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(await readLog(), '\x1b[31mbare\n[second HEX   TX] 41\n');
  });

  test('does not mix preformatted raw traffic history into a readable recording', async () => {
    internals.appendHistory({ direction: 'RX', bytes: Buffer.from('\x1b[31mold'), timestamp: 'first', hex: false });
    start();
    write('\x1b[32mnew\x1b[0m\n', 'RX', 'second');
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(await readLog(), '[second ASCII RX] new\n');
  });

  test('preserves a reused recording while its existing contents are loaded asynchronously', async () => {
    const uri = vscode.Uri.joinPath(folder, 'existing.log');
    await vscode.workspace.fs.writeFile(uri, Buffer.from('previous recording\n'));
    connection.setRecording(true, folder, uri, 'readable');
    write('new-tail');
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(connection.logFileUri?.toString(), uri.toString());
    assert.strictEqual(await readLog(), 'previous recording\n[first ASCII RX] new-tail\n');
  });

  test('uses live compact settings for both readable and hex records', async () => {
    start();
    const timestamp = '2026-08-29T14:23:01.123+08:00';
    write('pending', 'RX', timestamp);
    settings.compactTimestamps = true;
    write('-tail\n', 'RX', timestamp);
    internals.appendLog({ direction: 'TX', bytes: Buffer.from('A'), timestamp, hex: true });
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(await readLog(),
      `${formatTrafficHeader(timestamp, 'RX', false, true)} pending-tail\n` +
      `${formatTrafficHeader(timestamp, 'TX', true, true)} 41\n`);
  });

  test('flushes coalesced RX and incomplete UTF-8 before stopping recording', async () => {
    start();
    const events: TrafficEvent[] = [];
    const subscription = connection.onDidTraffic((event) => events.push(event));
    internals.handleIncoming(Buffer.from([0x61, 0xe4]));
    connection.setRecording(false);
    await internals.logFlushChain;
    subscription.dispose();
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual([...events[0].bytes], [0x61, 0xe4]);
    assert.strictEqual(await readLog(),
      `${formatTrafficHeader(events[0].timestamp, 'RX', false, false)} a\uFFFD\n`);
  });

  test('does not hold incomplete UTF-8-looking bytes back in hex receive mode', async () => {
    start();
    connection.setHexRecv(true);
    const events: TrafficEvent[] = [];
    const subscription = connection.onDidTraffic((event) => events.push(event));
    internals.handleIncoming(Buffer.from([0x00, 0xe4]));
    internals.flushRxBuffer();
    connection.setRecording(false);
    await internals.logFlushChain;
    subscription.dispose();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].hex, true);
    assert.strictEqual(await readLog(),
      `${formatTrafficHeader(events[0].timestamp, 'RX', true, false)} 00 E4\n`);
  });

  test('flushes pending text before hex toggles without disturbing the other direction', async () => {
    start();
    write('rx');
    write('tx', 'TX', 'second');
    connection.setHexRecv(true);
    internals.appendLog({ direction: 'RX', bytes: new Uint8Array([0x00, 0xff, 0x0a]), timestamp: 'third', hex: true });
    connection.setHexRecv(false);
    write('new\n', 'RX', 'fourth');
    write('-tail\n', 'TX', 'fifth');
    connection.setHexSend(true);
    write('A', 'TX', 'sixth');
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(await readLog(),
      '[first ASCII RX] rx\n[third HEX   RX] 00 FF 0A\n[fourth ASCII RX] new\n[second ASCII TX] tx-tail\n[sixth HEX   TX] 41\n');
  });

  test('setting an unchanged hex toggle does not split pending text', () => {
    start();
    write('part');
    connection.setHexRecv(false);
    write('-tail\n', 'RX', 'second');
    assert.strictEqual(internals.logBuffer, '[first ASCII RX] part-tail\n');
  });

  test('finalizes pending TX text and decoder bytes before switching to hex', async () => {
    start();
    internals.appendLog({ direction: 'TX', bytes: new Uint8Array([0x61, 0xe4]), timestamp: 'first', hex: false });
    connection.setHexSend(true);
    internals.appendLog({ direction: 'TX', bytes: new Uint8Array([0xbd, 0xa0]), timestamp: 'second', hex: true });
    connection.setHexSend(false);
    write('new\n', 'TX', 'third');
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(await readLog(), '[first ASCII TX] a\uFFFD\n[second HEX   TX] BD A0\n[third ASCII TX] new\n');
  });

  test('flushes completed lines live but keeps partial text until stop', async () => {
    start();
    write('complete\npartial');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await internals.logFlushChain;
    assert.strictEqual(await readLog(), '[first ASCII RX] complete\n');
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.strictEqual(await readLog(), '[first ASCII RX] complete\n[first ASCII RX] partial\n');
    write('ignored\n');
    assert.strictEqual(internals.logBuffer, '[first ASCII RX] complete\n[first ASCII RX] partial\n');
  });

  test('finalizes both directions before beginning a distinct recording', async () => {
    start();
    write('rx-tail');
    write('tx-tail', 'TX', 'second');
    const firstPath = connection.logFilePath;
    start();
    assert.notStrictEqual(connection.logFilePath, firstPath);
    write('fresh\n', 'RX', 'third');
    connection.setRecording(false);
    await internals.logFlushChain;
    assert.deepStrictEqual([await readLog(firstPath), await readLog()], [
      '[first ASCII RX] rx-tail\n[second ASCII TX] tx-tail\n', '[third ASCII RX] fresh\n',
    ]);
  });

  test('flushes pending text on dispose and close of an already-closed port', async () => {
    start();
    write('close-tail');
    await connection.close();
    await internals.logFlushChain;
    assert.strictEqual(await readLog(), '[first ASCII RX] close-tail\n');
    start();
    write('dispose-tail', 'TX', 'second');
    connection.dispose();
    await internals.logFlushChain;
    assert.strictEqual(await readLog(), '[second ASCII TX] dispose-tail\n');
  });

  test('finalizes both pending directions when the native port emits close', async () => {
    start();
    write('rx-tail');
    write('tx-tail', 'TX', 'second');
    internals.port.emit('close');
    await internals.logFlushChain;
    assert.strictEqual(connection.recording, true, 'preserve RF for the closed-session snapshot');
    assert.strictEqual(await readLog(), '[first ASCII RX] rx-tail\n[second ASCII TX] tx-tail\n');
  });
});
