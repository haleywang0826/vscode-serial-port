import * as assert from 'assert';
import { detectSeverity, LineAssembler, TrafficRecord } from '../serial/lineAssembler';

const encoder = new TextEncoder();
const TS = '2026-09-05T14:23:01.123+08:00';

/** Collects every record an assembler emits, with severity detection on. */
function collect(): { assembler: LineAssembler; records: TrafficRecord[] } {
  const records: TrafficRecord[] = [];
  const assembler = new LineAssembler('RX', {
    emit: (record) => records.push(record),
    detectSeverity: () => true,
  });
  return { assembler, records };
}

function lines(records: TrafficRecord[]): { render: string; plain: string; severity?: string }[] {
  return records
    .filter((record): record is Extract<TrafficRecord, { kind: 'line' }> => record.kind === 'line')
    .map((record) => ({ render: record.render, plain: record.plain, severity: record.severity }));
}

/** True if `text` contains any escape introducer — checked by `includes` rather than a character
 * class because a control character inside a regex literal is an eslint error. */
function hasEscape(text: string): boolean {
  return text.includes('\x1b') || text.includes('\x9b') || text.includes('\x9c');
}

/** Feeds `bytes` to a fresh assembler in chunks split at `offset`, then flushes. */
function runSplit(bytes: Uint8Array, offset: number): TrafficRecord[] {
  const { assembler, records } = collect();
  assembler.write(bytes.slice(0, offset), TS);
  assembler.write(bytes.slice(offset), TS);
  assembler.flush();
  return records;
}

suite('LineAssembler', () => {
  test('splitting the stream at any offset produces the same records', () => {
    // Covers, in one invariant, the three ways a read boundary can land badly: inside the SGR
    // escape, inside the CRLF pair, and inside the payload.
    const bytes = encoder.encode('\x1b[0;32mI (123) wifi: up\r\n');
    const expected = JSON.stringify(lines(runSplit(bytes, bytes.length)));
    for (let offset = 0; offset <= bytes.length; offset++) {
      assert.strictEqual(JSON.stringify(lines(runSplit(bytes, offset))), expected, `split at offset ${offset}`);
    }
  });

  test('a multi-byte character split across reads never yields U+FFFD', () => {
    const bytes = encoder.encode('温度: 25℃\n');
    for (let offset = 0; offset <= bytes.length; offset++) {
      const result = lines(runSplit(bytes, offset));
      assert.strictEqual(result.length, 1, `split at offset ${offset}`);
      assert.strictEqual(result[0].plain, '温度: 25℃', `split at offset ${offset}`);
    }
  });

  test('plain carries no escape byte for SGR, OSC, DCS or cursor-movement input', () => {
    const { assembler, records } = collect();
    assembler.write(
      encoder.encode(
        '\x1b[1;31mred\x1b[0m' + // SGR
          '\x1b]0;window title\x07' + // OSC terminated by BEL
          '\x1bPq#0;2;0;0;0\x1b\\' + // DCS terminated by ST
          '\x1b[2J\x1b[10;20H' + // cursor movement / erase
          '\x9b31mtail' + // 8-bit C1 CSI
          '\n',
      ),
      TS,
    );
    const [line] = lines(records);
    assert.ok(!hasEscape(line.plain), `plain still contains an escape: ${JSON.stringify(line.plain)}`);
    assert.strictEqual(line.plain, 'redtail');
    // The render side keeps SGR (that is the point of it) but must have dropped everything else.
    assert.ok(line.render.includes('\x1b[1;31m'));
    assert.ok(!line.render.includes('\x1b[2J'));
    assert.ok(!line.render.includes('\x1b]0;'));
  });

  test('a colour set on one line still applies to the next', () => {
    const { assembler, records } = collect();
    assembler.write(encoder.encode('\x1b[33mfirst\nsecond\n'), TS);
    const [first, second] = lines(records);
    assert.ok(first.render.includes('\x1b[33m'));
    assert.ok(second.render.startsWith('\x1b[0;33m'), `second line lost the carried colour: ${JSON.stringify(second.render)}`);
    assert.strictEqual(second.plain, 'second');
  });

  test('CR, LF and CRLF each end exactly one line', () => {
    const { assembler, records } = collect();
    assembler.write(encoder.encode('a\r\nb\nc\rd\r\n'), TS);
    assert.deepStrictEqual(
      lines(records).map((line) => line.plain),
      ['a', 'b', 'c', 'd'],
    );
  });

  test('a line is stamped when its first byte arrived, not when it completed', () => {
    const { assembler, records } = collect();
    const later = '2026-09-05T14:23:09.999+08:00';
    assembler.write(encoder.encode('slow'), TS);
    assembler.write(encoder.encode(' line\n'), later);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].timestamp, TS);
  });

  test('an idle flush emits a partial, and its completion is marked continued', () => {
    const { assembler, records } = collect();
    assembler.write(encoder.encode('esp32> '), TS);
    assembler.flushPartial();
    assembler.write(encoder.encode('help\n'), TS);
    const emitted = records.filter((record): record is Extract<TrafficRecord, { kind: 'line' }> => record.kind === 'line');
    assert.strictEqual(emitted.length, 2);
    assert.deepStrictEqual(
      emitted.map((record) => [record.plain, record.continues, record.continued]),
      [
        ['esp32> ', true, false],
        ['help', false, true],
      ],
    );
  });

  test('a TX line is never classified — what you send is a command, not a log record', () => {
    const records: TrafficRecord[] = [];
    const tx = new LineAssembler('TX', { emit: (record) => records.push(record), detectSeverity: () => true });
    tx.write(encoder.encode('[ERROR] reboot\n'), TS);
    const [sent] = lines(records);
    assert.strictEqual(sent.plain, '[ERROR] reboot');
    assert.strictEqual(sent.severity, undefined, 'the user typing "[ERROR]" must not label their own send');
  });

  test('flush emits an unterminated final line so a prompt is never lost on close', () => {
    const { assembler, records } = collect();
    assembler.write(encoder.encode('no newline here'), TS);
    assembler.flush();
    assert.deepStrictEqual(
      lines(records).map((line) => line.plain),
      ['no newline here'],
    );
  });

  test('an all-control-byte reply is still surfaced, as visible \\xNN escapes', () => {
    // The hex-send-into-an-ASCII-session case: you send raw byte values, the device echoes them,
    // and none of them are printable. These used to be dropped outright, which left the line empty
    // and the partial-flush path with nothing to emit — a reply that plainly arrived looked like a
    // dead port. Every received byte must leave a mark.
    const { assembler, records } = collect();
    assembler.write(new Uint8Array([0x00, 0x01, 0x7f]), TS);
    assembler.flush();
    assert.deepStrictEqual(
      lines(records).map((line) => line.plain),
      ['\\x00\\x01\\x7F'],
    );
  });

  test('escaping a control byte never touches tab, CR/LF or an escape sequence', () => {
    // The three exemptions, in one line: tab is load-bearing in device output, CR/LF are line
    // structure and are consumed as such, and ESC-introduced sequences are parsed rather than
    // escaped (so a colour still applies instead of printing as "\x1B[0;32m").
    const { assembler, records } = collect();
    assembler.write(encoder.encode('\x1b[0;32ma\tb\x07c\r\n'), TS);
    const [line] = lines(records);
    assert.strictEqual(line.plain, 'a\tb\\x07c');
    assert.ok(!hasEscape(line.plain), 'no escape byte survives into the log text');
  });
});

suite('detectSeverity', () => {
  const cases: [string, string | undefined][] = [
    ['E (12345) wifi: connect failed', 'ERROR'],
    ['W (12345) 0 heap: low', 'WARN'],
    ['I (12345) app_main: ready', 'INFO'],
    ['[00:00:01.234,000] <err> net_if: iface down', 'ERROR'],
    ['[00:00:01.234,000] <inf> main: booted', 'INFO'],
    ['<3>kernel: something broke', 'ERROR'],
    ['<6>kernel: informational', 'INFO'],
    ['E/MyTag( 123): failed', 'ERROR'],
    ['[ERROR] could not mount fs', 'ERROR'],
    ['WARNING: voltage sag', 'WARN'],
    ['Guru Meditation Error: Core 0 panic', 'ERROR'],
    ['assert failed: xQueueSend queue.c:1234', 'ERROR'],
    // The anchoring cases: a level word that is not at the start of the line, and an ordinary
    // sentence that merely mentions one, must both stay unclassified.
    ['sensor read returned an error code', undefined],
    ['fatal is a strong word', undefined],
    ['plain device chatter', undefined],
  ];

  for (const [line, expected] of cases) {
    test(`${JSON.stringify(line)} -> ${expected ?? 'none'}`, () => {
      assert.strictEqual(detectSeverity(line), expected);
    });
  }

  test('falls back to the line colour only when no textual prefix matched', () => {
    assert.strictEqual(detectSeverity('unlabelled trouble', '31'), 'ERROR');
    assert.strictEqual(detectSeverity('unlabelled trouble', '93'), 'WARN');
    // A truecolour/256-colour value is a palette choice, not a level.
    assert.strictEqual(detectSeverity('unlabelled trouble', '38;5;208'), undefined);
    // The device's own label wins over its colour.
    assert.strictEqual(detectSeverity('I (1) app: fine', '31'), 'INFO');
  });
});
