import * as assert from 'assert';
import {
  bytesToHex,
  findSeverityToken,
  formatAnnotatedLine,
  formatTrafficHeader,
  parseAnnotatedHeader,
} from '../serial/format';
import { LineAssembler, TrafficRecord } from '../serial/lineAssembler';
import type { Severity } from '../serial/lineAssembler';

const encoder = new TextEncoder();
const TS = '2026-09-05T14:23:01.123+08:00';

/** The rendered timestamp is derived in the *machine's* local timezone from the stored
 * offset-bearing string, so a header can only be asserted by shape, never as fixed text — a literal
 * expectation would pass in exactly one timezone. These two cover both display forms. */
const STAMP = String.raw`\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}`;
const COMPACT_STAMP = String.raw`\d{2}:\d{2}:\d{2}\.\d{3}`;

suite('Annotated log records', () => {
  test('the header is the same width in every mode and direction', () => {
    const widths = new Set(
      (['TX', 'RX'] as const).flatMap((direction) =>
        [true, false].map((hex) => formatTrafficHeader(TS, direction, hex, false).length),
      ),
    );
    assert.strictEqual(widths.size, 1, 'headers must stay column-aligned line to line');
    assert.match(formatTrafficHeader(TS, 'RX', false, false), new RegExp(`^\\[${STAMP} ASC RX\\]$`));
    assert.match(formatTrafficHeader(TS, 'TX', true, false), new RegExp(`^\\[${STAMP} HEX TX\\]$`));
  });

  test('neither timestamp form carries a year or a UTC offset', () => {
    // Both are constant for a whole session and are recorded on the file's '# ---' banner instead;
    // on every line they would only cost horizontal space, which is the scarce resource here.
    const header = formatTrafficHeader(TS, 'RX', false, false);
    assert.ok(!header.includes('2026'), 'no year on the line');
    assert.ok(!/[+-]\d{2}:\d{2}|Z/.test(header), 'no UTC offset on the line');
  });

  test('compact timestamps drop the date and only change the rendering, never the stored value', () => {
    assert.match(formatTrafficHeader(TS, 'RX', false, true), new RegExp(`^\\[${COMPACT_STAMP} ASC RX\\]$`));
    // The compact form is exactly the tail of the full one — the same instant, with less of it shown.
    const full = formatTrafficHeader(TS, 'RX', false, false);
    const compact = formatTrafficHeader(TS, 'RX', false, true);
    assert.ok(full.endsWith(compact.slice(1)), `${full} should end with ${compact.slice(1)}`);
    // The stored string is the source of truth and is never mutated by the setting — the full form
    // still comes back unchanged from the same input.
    assert.strictEqual(formatTrafficHeader(TS, 'RX', false, false), full);
  });

  test('a severity token is emitted in the header, never in the payload', () => {
    // The point of the column: what follows the closing bracket is byte-for-byte what the device
    // said, so a device that labels its own lines no longer produces a confusing "[ERROR] [ERROR]".
    assert.match(
      formatAnnotatedLine(TS, 'RX', false, false, 'ERROR', '[ERROR] iaijrgoi[jre'),
      new RegExp(`^\\[${STAMP} ASC RX ERROR\\] \\[ERROR\\] iaijrgoi\\[jre$`),
    );
  });

  test('the level column is blank but still present when nothing was detected', () => {
    assert.match(
      formatAnnotatedLine(TS, 'RX', false, false, undefined, 'chatter'),
      new RegExp(`^\\[${STAMP} ASC RX {6}\\] chatter$`),
    );
  });

  test('every annotated header is the same width, so the payload starts at a fixed column', () => {
    const widths = new Set(
      (['TX', 'RX'] as const).flatMap((direction) =>
        [true, false].flatMap((hex) =>
          [undefined, 'INFO', 'ERROR', 'TRACE'].map(
            (severity) => formatAnnotatedLine(TS, direction, hex, false, severity, 'x').indexOf('x'),
          ),
        ),
      ),
    );
    assert.strictEqual(widths.size, 1, 'the payload must start at the same offset on every line');
  });

  test('a hex record keeps the grouped-byte-pair payload shape', () => {
    const bytes = new Uint8Array([0x0a, 0xff, 0x3c]);
    assert.match(
      formatAnnotatedLine(TS, 'TX', true, false, undefined, bytesToHex(bytes)),
      new RegExp(`^\\[${STAMP} HEX TX {6}\\] 0A FF 3C$`),
    );
  });

  test('an annotated line never carries a newline of its own', () => {
    // The single newline is appended by the one caller that writes the line out, so no call site
    // can omit it or add a second — the blank-row bug this replaced came from doing both.
    assert.ok(!formatAnnotatedLine(TS, 'RX', false, false, 'WARN', 'text').includes('\n'));
  });

  test('a device burst produces exactly one log line per device line, with no blank rows', () => {
    const records: TrafficRecord[] = [];
    const assembler = new LineAssembler('RX', {
      emit: (record) => records.push(record),
      detectSeverity: () => true,
    });
    // Colour-per-severity output in ESP-IDF's own style, arriving as two ragged reads that split
    // both a line and an escape sequence.
    const burst =
      '\x1b[0;32mI (301) cpu_start: Pro cpu up.\r\n' +
      '\x1b[0;33mW (318) spiram: no SPIRAM\r\n' +
      '\x1b[0;31mE (402) wifi: connect failed\r\n\x1b[0m';
    const bytes = encoder.encode(burst);
    assembler.write(bytes.slice(0, 70), TS);
    assembler.write(bytes.slice(70), TS);
    assembler.flush();

    const file = records
      .filter((record): record is Extract<TrafficRecord, { kind: 'line' }> => record.kind === 'line')
      .filter((record) => !record.continues)
      .map((record) => formatAnnotatedLine(record.timestamp, record.direction, false, false, record.severity, record.plain) + '\n')
      .join('');

    assert.strictEqual(
      file,
      formatAnnotatedLine(TS, 'RX', false, false, 'INFO', 'I (301) cpu_start: Pro cpu up.') +
        '\n' +
        formatAnnotatedLine(TS, 'RX', false, false, 'WARN', 'W (318) spiram: no SPIRAM') +
        '\n' +
        formatAnnotatedLine(TS, 'RX', false, false, 'ERROR', 'E (402) wifi: connect failed') +
        '\n',
    );
    assert.ok(!file.includes('\n\n'), 'no blank rows');
    assert.ok(!file.includes('\x1b') && !file.includes('\x9b'), 'no escape byte ever reaches the log file');
  });
});

suite('Reading a log line back out', () => {
  const SEVERITIES: Severity[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

  test('every line the writer produces is read back with the right level and offsets', () => {
    // A round-trip against `formatAnnotatedLine` rather than against hand-written strings: the
    // editor decorator and the log writer must agree on the header shape forever, and this is what
    // makes a change to one that breaks the other fail here.
    for (const severity of SEVERITIES) {
      for (const hex of [true, false]) {
        for (const compact of [true, false]) {
          const line = formatAnnotatedLine(TS, 'RX', hex, compact, severity, 'payload');
          const token = findSeverityToken(line);
          assert.ok(token, `no token found in ${line}`);
          assert.strictEqual(token.severity, severity);
          assert.strictEqual(line.slice(token.start, token.end), severity, 'the offsets must span exactly the level word');
        }
      }
    }
  });

  test('the direction and payload offsets address exactly their own columns', () => {
    // What the decorator paints: the direction token in the TX/RX colour, and everything from
    // `payload` onward in the level (or direction) colour — so an off-by-one here would colour the
    // closing bracket, or clip the device's first character.
    for (const direction of ['TX', 'RX'] as const) {
      for (const compact of [true, false]) {
        const line = formatAnnotatedLine(TS, direction, false, compact, undefined, 'hello world');
        const header = parseAnnotatedHeader(line);
        assert.ok(header, `no header parsed from ${line}`);
        assert.strictEqual(header.direction, direction);
        assert.strictEqual(line.slice(header.directionStart, header.directionEnd), direction);
        assert.strictEqual(line.slice(header.payload), 'hello world');
      }
    }
  });

  test('an empty payload leaves the payload offset at the end of the line, not past it', () => {
    // A device can end a line with nothing after the header (a bare newline). The decorator skips
    // an empty range, but only if the offset is in bounds to begin with.
    const line = formatAnnotatedLine(TS, 'RX', false, false, undefined, '');
    const header = parseAnnotatedHeader(line);
    assert.ok(header);
    assert.strictEqual(header.payload, line.length);
  });

  test('logs recorded by earlier versions still read', () => {
    // Only the writer moved to "ASC" and the short timestamp; the reader keeps every shape this
    // extension has ever written, so a log recorded last month still lights up in the editor.
    for (const line of [
      '[2026-09-05T14:23:01.123+08:00 ASCII RX ERROR] E (402) wifi: connect failed',
      '[09/05 14:23:01.123 ASCII RX ERROR] E (402) wifi: connect failed',
      '[09/05 14:23:01.123 HEX   TX      ] 0A FF 3C',
    ]) {
      const header = parseAnnotatedHeader(line);
      assert.ok(header, `legacy line not recognised: ${line}`);
      assert.strictEqual(line.slice(header.directionStart, header.directionEnd), header.direction);
    }
    assert.strictEqual(findSeverityToken('[09/05 14:23:01.123 ASCII RX WARN ] W (318) spiram')?.severity, 'WARN');
  });

  test('nothing is reported for a line the writer left unclassified', () => {
    assert.strictEqual(findSeverityToken(formatAnnotatedLine(TS, 'RX', false, false, undefined, 'chatter')), undefined);
    // TX lines are never classified, so in practice they always take the blank-column path.
    assert.strictEqual(findSeverityToken(formatAnnotatedLine(TS, 'TX', false, false, undefined, 'ping')), undefined);
  });

  test('a level word in the payload is not mistaken for the header column', () => {
    // The duplicate-marker case: the device labelled its own line, and that text is payload.
    const line = formatAnnotatedLine(TS, 'RX', false, false, undefined, '[ERROR] iaijrgoi[jre');
    assert.strictEqual(findSeverityToken(line), undefined);
  });

  test('an unrelated .log file is never touched', () => {
    // The decorator also runs over VS Code's built-in `log` language, so anchoring on the full
    // header — not just a bracketed word — is what keeps someone else's log un-recoloured.
    for (const line of ['2026-09-05 [ERROR] something', '[2026-09-05T14:23:01.123+08:00] ERROR boom', '']) {
      assert.strictEqual(findSeverityToken(line), undefined);
      assert.strictEqual(parseAnnotatedHeader(line), undefined);
    }
  });
});
