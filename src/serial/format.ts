const HEX_BYTE_RE = /^[0-9a-fA-F]{2}$/;

/** Formats bytes as space-separated uppercase hex pairs, e.g. "0A FF 3C". */
export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** Renders bytes as text, replacing non-printable control characters with '.'. */
export function bytesToAscii(data: Uint8Array): string {
  return Array.from(data, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');
}

export function formatBytes(data: Uint8Array, hex: boolean): string {
  return hex ? bytesToHex(data) : bytesToAscii(data);
}

const ESC = 0x1b;

/**
 * Like `bytesToAscii`, but for terminal display: an embedded ANSI SGR (color) escape sequence
 * (`ESC [ ... m`) is passed through verbatim, so a device that colors its own serial output
 * renders as intended ("terminal standard" color support). Any other escape sequence (cursor
 * movement, scroll-region changes, etc.) is dropped instead of passed through, since letting a
 * device move the cursor or redefine the scroll region could corrupt the terminal's own
 * pinned-input-line scroll region.
 */
export function bytesToAsciiForTerminal(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === ESC && data[i + 1] === 0x5b /* '[' */) {
      let j = i + 2;
      while (j < data.length && data[j] >= 0x30 && data[j] <= 0x3f) j++; // parameter bytes
      while (j < data.length && data[j] >= 0x20 && data[j] <= 0x2f) j++; // intermediate bytes
      if (j < data.length && data[j] >= 0x40 && data[j] <= 0x7e) {
        if (data[j] === 0x6d /* 'm' (SGR) */) {
          out += String.fromCharCode(...data.slice(i, j + 1));
        }
        i = j;
        continue;
      }
    }
    out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
  }
  return out;
}

/** Like `formatBytes`, but renders ascii mode via `bytesToAsciiForTerminal` for SGR passthrough. */
export function formatBytesForTerminal(data: Uint8Array, hex: boolean): string {
  return hex ? bytesToHex(data) : bytesToAsciiForTerminal(data);
}

/**
 * Parses a hex-mode send line ("0A FF 3C" or "0AFF3C") into bytes.
 * Throws with a message suitable for surfacing directly to the user.
 */
export function hexStringToBytes(input: string): Uint8Array {
  const compact = input.trim().replace(/\s+/g, '');
  if (compact.length === 0) {
    return new Uint8Array(0);
  }
  if (compact.length % 2 !== 0) {
    throw new Error('Hex input must have an even number of digits.');
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

/** True if `ch` is a character the hex-mode terminal input should accept while typing. */
export function isHexInputChar(ch: string): boolean {
  return /^[0-9a-fA-F ]$/.test(ch);
}

export function asciiStringToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}
