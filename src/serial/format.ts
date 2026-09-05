const HEX_BYTE_RE = /^[0-9a-fA-F]{2}$/;

/** Decodes contiguous runs of "plain" bytes as UTF-8 (not per-byte `String.fromCharCode`, which
 * cannot represent any multi-byte character — e.g. Chinese text is always multi-byte in UTF-8).
 * `fatal: false` renders genuinely invalid UTF-8 as U+FFFD ('�'), matching standard terminal
 * behavior (xterm, VS Code's own integrated terminal) rather than throwing or dropping bytes. */
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/** Formats bytes as space-separated uppercase hex pairs, e.g. "0A FF 3C". */
export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/**
 * Renders bytes as text: a CRLF pair or a lone CR/LF becomes one real line break ('\n'), a Tab
 * passes through as a literal '\t', and every other byte — including every other ASCII control
 * character (VT, FF, BEL, a lone ESC, ...) — is decoded as part of a contiguous UTF-8 run (see
 * `utf8Decoder`) rather than collapsed into a placeholder like '.'. This keeps the display a
 * direct, lossless reflection of the raw byte value for both ASCII and multi-byte text. Never
 * mutates the underlying bytes — this only affects the display string built from them.
 */
export function bytesToAscii(data: Uint8Array): string {
  let out = '';
  let runStart = 0;
  const flushRun = (end: number) => {
    if (end > runStart) {
      out += utf8Decoder.decode(data.subarray(runStart, end));
    }
  };
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0x0d && data[i + 1] === 0x0a) {
      flushRun(i);
      out += '\n';
      i++;
      runStart = i + 1;
      continue;
    }
    if (byte === 0x0d || byte === 0x0a) {
      flushRun(i);
      out += '\n';
      runStart = i + 1;
      continue;
    }
    if (byte === 0x09) {
      flushRun(i);
      out += '\t';
      runStart = i + 1;
      continue;
    }
  }
  flushRun(data.length);
  return out;
}

export function formatBytes(data: Uint8Array, hex: boolean): string {
  return hex ? bytesToHex(data) : bytesToAscii(data);
}

const ESC = 0x1b;

/**
 * Like `bytesToAscii`, but for terminal display: an embedded ANSI SGR (color) escape sequence
 * (`ESC [ ... m`) is passed through verbatim, so a device that colors its own serial output
 * renders as intended ("terminal standard" color support). A multi-byte CSI sequence that isn't
 * SGR (cursor movement, scroll-region changes, etc.) is still dropped instead of passed through,
 * since letting a device move the cursor or redefine the scroll region could corrupt the
 * terminal's own pinned-input-line scroll region — that's a distinct, deliberate exception,
 * unrelated to the plain-byte handling below. Every other byte, including every single-byte ASCII
 * control character (VT, FF, BEL, a lone ESC, ...), is decoded as part of a contiguous UTF-8 run
 * (see `utf8Decoder`) rather than collapsed into a placeholder like '.', so what's on screen — and
 * what a user copies from it — reflects the actual raw byte value for both ASCII and multi-byte text.
 */
export function bytesToAsciiForTerminal(data: Uint8Array): string {
  let out = '';
  let runStart = 0;
  const flushRun = (end: number) => {
    if (end > runStart) {
      out += utf8Decoder.decode(data.subarray(runStart, end));
    }
  };
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === ESC && data[i + 1] === 0x5b /* '[' */) {
      let j = i + 2;
      while (j < data.length && data[j] >= 0x30 && data[j] <= 0x3f) j++; // parameter bytes
      while (j < data.length && data[j] >= 0x20 && data[j] <= 0x2f) j++; // intermediate bytes
      if (j < data.length && data[j] >= 0x40 && data[j] <= 0x7e) {
        flushRun(i);
        if (data[j] === 0x6d /* 'm' (SGR) */) {
          out += String.fromCharCode(...data.slice(i, j + 1));
        }
        i = j;
        runStart = i + 1;
        continue;
      }
    }
    if (byte === 0x0d && data[i + 1] === 0x0a) {
      flushRun(i);
      out += '\r\n'; // raw-mode pty needs an explicit CR to return to column 1
      i++;
      runStart = i + 1;
      continue;
    }
    if (byte === 0x0d || byte === 0x0a) {
      flushRun(i);
      out += '\r\n';
      runStart = i + 1;
      continue;
    }
    if (byte === 0x09) {
      flushRun(i);
      out += '\t';
      runStart = i + 1;
      continue;
    }
  }
  flushRun(data.length);
  return out;
}

/** Like `formatBytes`, but renders ascii mode via `bytesToAsciiForTerminal` for SGR passthrough. */
export function formatBytesForTerminal(data: Uint8Array, hex: boolean): string {
  return hex ? bytesToHex(data) : bytesToAsciiForTerminal(data);
}

/** "HEX".padEnd/"ASCII".padEnd width — the longer of the two mode labels, so the header below is
 * always exactly the same length regardless of mode, keeping columns aligned line-to-line. */
const MODE_WIDTH = 5;

/** Compact display form of a timestamp for the "Compact Timestamps" setting: numeric month/day,
 * time, and milliseconds — no year or UTC offset (per spec, since both are rarely useful for a
 * live session log), e.g. "08/31 14:23:01.123". Takes a `Date` (already re-parsed from the stored
 * full `toLocalIsoString` string by the caller) rather than reading the clock itself, so this stays
 * a pure, deterministic display transform. */
export function toLocalCompactString(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/** Builds the shared `[timestamp MODE DIRECTION]` header used by both the terminal (when "Show
 * timestamp" is on) and the file log (always) — same fixed length on every line since `timestamp`
 * is already zero-padded/fixed-offset (see `toLocalIsoString`), `mode` is padded to `MODE_WIDTH`,
 * and `direction` is always 2 characters. `compact`, when true, re-parses the stored `timestamp`
 * string (always the full `toLocalIsoString` form — the source of truth, never mutated by this
 * setting) via `toLocalCompactString` for display — a pure, live, display-time transform, so
 * flipping the "Compact Timestamps" setting never retroactively changes an already-rendered or
 * already-logged line. */
export function formatTrafficHeader(timestamp: string, direction: 'TX' | 'RX', hex: boolean, compact: boolean): string {
  const displayTimestamp = compact ? toLocalCompactString(new Date(timestamp)) : timestamp;
  return `[${displayTimestamp} ${(hex ? 'HEX' : 'ASCII').padEnd(MODE_WIDTH)} ${direction}]`;
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

/** Normalizes a hex-mode string to canonical, even-length "AA BB CC" form — round-tripped through
 * `hexStringToBytes`/`bytesToHex`, so it picks up the same trailing-zero padding for an odd digit
 * count. Used to fix up a Send Template's hex data at save time, so an odd-length value (e.g. "00
 * 11 2") is stored already-padded ("00 11 20") instead of only ever getting padded transiently at
 * send time — the saved template text itself then always reads as valid, even-length hex. Returns
 * '' for an empty/all-whitespace input rather than throwing. */
export function normalizeHexString(input: string): string {
  if (input.trim().length === 0) {
    return '';
  }
  return bytesToHex(hexStringToBytes(input));
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
