import type { Severity } from './lineAssembler';

const HEX_BYTE_RE = /^[0-9a-fA-F]{2}$/;

/** Formats bytes as space-separated uppercase hex pairs, e.g. "0A FF 3C". */
export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** Line terminator appended to an ASCII send, per the session's "Line Ending" selector. Embedded
 * consoles disagree about what completes a command — an ESP-IDF console and a Zephyr shell accept
 * either, a bare AT modem wants CRLF, a MicroPython REPL wants CR — so it is the user's choice.
 * CRLF is the default since it satisfies every device that accepts only one of the two. */
export type LineEnding = 'none' | 'lf' | 'cr' | 'crlf';

export const LINE_ENDING_BYTES: Record<LineEnding, Uint8Array> = {
  none: new Uint8Array(0),
  lf: new Uint8Array([0x0a]),
  cr: new Uint8Array([0x0d]),
  crlf: new Uint8Array([0x0d, 0x0a]),
};

/** Width of the mode label. Both labels are three characters ("ASC"/"HEX") so the header is the
 * same length regardless of mode, keeping columns aligned line-to-line; the padding is kept anyway
 * so a future label can't silently break the alignment. Deliberately abbreviated: those three
 * columns repeat on every single line, and "ASC" is no less readable than "ASCII" once you have
 * seen one line of the file. */
const MODE_WIDTH = 3;

/** Width of the log header's severity column — the longest severity word ("ERROR"/"DEBUG"/
 * "TRACE"). The column is always present, blank when nothing was detected, so every payload starts
 * at the same character offset and `cut -c`/`awk` can address the columns positionally. */
const SEVERITY_WIDTH = 5;

/**
 * Display forms of a stored timestamp. Both are derived from a `Date` (already re-parsed from the
 * stored `toLocalIsoString` string by the caller) rather than from the clock, so they stay pure,
 * deterministic display transforms and the stored string remains the single source of truth.
 *
 * Neither carries a year or a UTC offset. A serial session is watched live and read the same day;
 * the offset is constant for the whole file and the year is on the `# ---` banner at the top, so
 * both only cost horizontal space on every line — the scarcest thing in a terminal.
 *
 * - `toLocalStampString` — `"09-05 20:58:48.375"`, the default.
 * - `toLocalCompactString` — `"20:58:48.375"`, for "Compact Timestamps": the date goes too, leaving
 *   the only part that changes between two adjacent lines.
 */
export function toLocalStampString(date: Date): string {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${toLocalCompactString(date)}`;
}

export function toLocalCompactString(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function buildHeader(
  timestamp: string,
  direction: 'TX' | 'RX',
  hex: boolean,
  compact: boolean,
  severityColumn: string,
): string {
  const date = new Date(timestamp);
  const displayTimestamp = compact ? toLocalCompactString(date) : toLocalStampString(date);
  return `[${displayTimestamp} ${(hex ? 'HEX' : 'ASC').padEnd(MODE_WIDTH)} ${direction}${severityColumn}]`;
}

/** Builds the shared `[timestamp MODE DIRECTION]` header used by the terminal when "Show timestamp"
 * is on — the same fixed length on every line, since both timestamp forms are zero-padded, `mode` is
 * padded to `MODE_WIDTH`, and `direction` is always 2 characters. Both forms are rendered from the
 * stored `timestamp` string (always the full `toLocalIsoString` form — the source of truth, never
 * mutated by any display setting), so flipping "Compact Timestamps" never retroactively changes an
 * already-rendered or already-logged line.
 *
 * No severity column here: in the terminal the level is already carried by the row's colour, and
 * horizontal space in a terminal is the scarce resource. The file log adds one — see
 * `formatAnnotatedLine`. */
export function formatTrafficHeader(timestamp: string, direction: 'TX' | 'RX', hex: boolean, compact: boolean): string {
  return buildHeader(timestamp, direction, hex, compact, '');
}

/**
 * One complete `annotated` log line, with no trailing newline (the caller appends exactly one, so no
 * call site can omit it or add a second and reintroduce the blank-row bug).
 *
 * The detected severity lives *inside* the header, as a fixed-width column after the direction:
 *
 * ```
 * [09-05 19:24:42.738 ASC RX ERROR] [ERROR] sensor 3 offline
 * [09-05 19:24:42.740 ASC TX      ] status
 * ```
 *
 * The invariant that buys is worth the six columns: **everything up to and including the first `]`
 * is written by this extension, everything after it is the device's own bytes.** The earlier shape
 * put the marker after the `]`, where a device that labels its own lines produced `[ERROR] [ERROR] …`
 * and there was no way to tell which half came from where. It also makes the header a fixed-width
 * record: a reader (human, `grep -c ' ERROR]'`, or `cut`) can address the level without parsing the
 * payload.
 *
 * `text` is always a record's escape-free `plain` field, never `render`, so no ANSI byte can reach
 * the file.
 */
export function formatAnnotatedLine(
  timestamp: string,
  direction: 'TX' | 'RX',
  hex: boolean,
  compact: boolean,
  severity: string | undefined,
  text: string,
): string {
  return `${buildHeader(timestamp, direction, hex, compact, ` ${(severity ?? '').padEnd(SEVERITY_WIDTH)}`)} ${text}`;
}

/** The exact header shape `formatAnnotatedLine` writes, with the direction and level columns
 * captured: an opening bracket, a timestamp, the mode, the direction, and the level padded to
 * `SEVERITY_WIDTH`.
 *
 * Three timestamp forms and two mode spellings are accepted, not one: the current
 * `toLocalStampString`/`toLocalCompactString` pair, plus the full `toLocalIsoString` form and the
 * old `MM/DD` compact form written by earlier versions, and `ASCII` alongside `ASC`. Reading is
 * where backwards compatibility is cheap and worth having — a log recorded last week should still
 * light up — while the writer only ever emits the current shape.
 *
 * Anchored to the whole header rather than to a bare level word, so a line in somebody else's `.log`
 * file that happens to contain "ERROR" is never matched. The `d` flag gives us each capture group's
 * offsets directly, which is what the caller actually wants. */
const HEADER_RE =
  /^\[(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:[+-]\d{2}:\d{2}|Z)|\d{2}[/-]\d{2} \d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}:\d{2}\.\d{3}) (?:ASCII|HEX {2}|ASC|HEX) (TX|RX)(?: (ERROR|WARN|INFO|DEBUG|TRACE))? *\]/d;

/** One parsed `annotated` header: which columns are where, so a consumer can address them without
 * re-deriving the shape. Offsets are half-open `[start, end)` character indices into the line, and
 * span the words themselves, never the padding around them. `payload` is the offset of the first
 * character the device actually sent. */
export interface AnnotatedHeader {
  direction: 'TX' | 'RX';
  directionStart: number;
  directionEnd: number;
  severity?: Severity;
  severityStart: number;
  severityEnd: number;
  payload: number;
}

/**
 * Parses one `annotated` log line's header — the read side of `formatAnnotatedLine`, kept beside the
 * writer so the two cannot drift apart. Returns `undefined` when the line is not one of ours.
 *
 * The editor decorator uses this to paint the line the same way the terminal paints its row; keeping
 * it here, free of any `vscode` import, is also what makes it directly unit-testable against the
 * writer's output.
 */
export function parseAnnotatedHeader(line: string): AnnotatedHeader | undefined {
  const match = HEADER_RE.exec(line);
  const direction = match?.indices?.[1];
  if (!match || !direction) {
    return undefined;
  }
  const severity = match.indices?.[2];
  return {
    direction: match[1] as 'TX' | 'RX',
    directionStart: direction[0],
    directionEnd: direction[1],
    severity: match[2] as Severity | undefined,
    severityStart: severity?.[0] ?? 0,
    severityEnd: severity?.[1] ?? 0,
    // +1 for the single space the writer puts between the closing bracket and the device's bytes.
    payload: Math.min(match[0].length + 1, line.length),
  };
}

/**
 * The level token of one `annotated` log line: the detected severity and the half-open
 * `[start, end)` offsets of the word itself, or `undefined` when the line is not one of ours or
 * carries no level (which includes every TX line — those are never classified).
 */
export function findSeverityToken(line: string): { severity: Severity; start: number; end: number } | undefined {
  const header = parseAnnotatedHeader(line);
  if (!header?.severity) {
    return undefined;
  }
  return { severity: header.severity, start: header.severityStart, end: header.severityEnd };
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}


/**
 * Parses a hex-mode send line ("0A FF 3C" or "0AFF3C") into bytes. An odd number of digits is
 * padded with a trailing 0 (e.g. "0A3" -> "0A 30") rather than rejected, since a user who stops
 * mid-byte almost always means the low nibble to be 0, not an error to correct.
 * Throws with a message suitable for surfacing directly to the user.
 */
export function hexStringToBytes(input: string): Uint8Array {
  let compact = input.trim().replace(/\s+/g, '');
  if (compact.length === 0) {
    return new Uint8Array(0);
  }
  if (compact.length % 2 !== 0) {
    compact += '0';
  }
  const bytes = new Uint8Array(compact.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const pair = compact.slice(i * 2, i * 2 + 2);
    if (!HEX_BYTE_RE.test(pair)) {
      throw new Error(`Invalid hex byte "${pair}".`);
    }
    bytes[i] = parseInt(pair, 16);
  }
  return bytes;
}

/** True if `ch` is a hex digit — the only character hex-mode input should accept while typing.
 * Spaces between byte pairs are auto-inserted (see `appendHexInputChar`), so a typed space is
 * simply ignored rather than accepted verbatim. */
export function isHexDigitChar(ch: string): boolean {
  return /^[0-9a-fA-F]$/.test(ch);
}

/** Appends `ch` (assumed to pass `isHexDigitChar`) to `current`, auto-inserting a space first
 * when `ch` starts a new byte pair — e.g. typing "0","A","1" yields "0A 1", so hex-send input
 * (terminal and template payload fields) always reads as grouped "AA BB CC" bytes without the
 * user having to type the separating spaces themselves. */
export function appendHexInputChar(current: string, ch: string): string {
  const digitsOnly = current.replace(/\s+/g, '');
  const needsSpace = digitsOnly.length > 0 && digitsOnly.length % 2 === 0;
  return needsSpace ? `${current} ${ch}` : `${current}${ch}`;
}

export function asciiStringToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}
