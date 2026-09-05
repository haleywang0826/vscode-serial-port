import { StringDecoder } from 'string_decoder';
import { formatTrafficHeader } from './format';

export type LogFormat = 'traffic' | 'readable';
export type LogDirection = 'RX' | 'TX';

export const READABLE_LOG_LINE_LIMIT = 16 * 1024;

type EscapeState = 'text' | 'escape' | 'intermediate' | 'csi' | 'string' | 'stringEscape';

const SEVERITIES = { E: 'ERROR', W: 'WARN', I: 'INFO', D: 'DEBUG', V: 'TRACE' } as const;

class DirectionLog {
  private decoder = new StringDecoder('utf8');
  private escape: EscapeState = 'text';
  private osc = false;
  private line = '';
  private timestamp: string | undefined;
  private skipLf = false;
  private severity: string | undefined;
  private utf8Remaining = 0;
  private continuationMin = 0x80;
  private continuationMax = 0xbf;

  constructor(
    private readonly direction: LogDirection,
    private readonly emit: (line: string) => void,
    private readonly settings: { compactTimestamps: boolean },
  ) {}

  write(bytes: Uint8Array, timestamp: string): void {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Decoding byte-wise preserves the timestamp of a multibyte character's first fragment,
    // even when it begins immediately after a line ending in the same serial read.
    for (let i = 0; i < buffer.length; i++) {
      this.timestamp ??= timestamp;
      const byte = buffer[i];
      const continuation =
        this.utf8Remaining > 0 && byte >= this.continuationMin && byte <= this.continuationMax;
      if (this.utf8Remaining > 0 && !continuation) {
        this.consume(this.decoder.end(), timestamp);
        this.decoder = new StringDecoder('utf8');
        this.utf8Remaining = 0;
      }
      // Eight-bit ANSI controls are also common on serial links. Do not mistake a valid
      // UTF-8 continuation byte for one, however (e.g. the 0x9b in a Unicode character).
      if (!continuation && byte >= 0x80 && byte <= 0x9f) {
        this.consume(String.fromCharCode(byte), timestamp);
        continue;
      }
      this.consume(this.decoder.write(buffer.subarray(i, i + 1)), timestamp);
      this.utf8Remaining = continuation
        ? this.utf8Remaining - 1
        : byte >= 0xc2 && byte <= 0xdf
          ? 1
          : byte >= 0xe0 && byte <= 0xef
            ? 2
            : byte >= 0xf0 && byte <= 0xf4
              ? 3
              : 0;
      this.continuationMin =
        !continuation && byte === 0xe0 ? 0xa0 : !continuation && byte === 0xf0 ? 0x90 : 0x80;
      this.continuationMax =
        !continuation && byte === 0xed ? 0x9f : !continuation && byte === 0xf4 ? 0x8f : 0xbf;
    }
  }

  flush(): void {
    this.consume(this.decoder.end(), this.timestamp ?? '');
    if (this.line.length > 0) {
      this.finishLine();
    }
    this.decoder = new StringDecoder('utf8');
    this.escape = 'text';
    this.osc = false;
    this.timestamp = undefined;
    this.skipLf = false;
    this.severity = undefined;
    this.utf8Remaining = 0;
    this.continuationMin = 0x80;
    this.continuationMax = 0xbf;
  }

  private consume(text: string, timestamp: string): void {
    for (const character of text) {
      if (!this.isText(character)) {
        continue;
      }
      if (character === '\n' && this.skipLf) {
        this.skipLf = false;
        this.timestamp = undefined;
        continue;
      }
      this.skipLf = false;
      this.timestamp ??= timestamp;
      if (character === '\r' || character === '\n') {
        this.finishLine();
        this.skipLf = character === '\r';
        continue;
      }
      if (this.line.length + character.length > READABLE_LOG_LINE_LIMIT) {
        this.finishLine(true);
      }
      this.line += character;
    }
  }

  private finishLine(continued = false): void {
    // Only recognize the anchored ESP-IDF level/ticks/tag prefix, never words in a payload.
    if (this.severity === undefined) {
      const match = /^([EWIDV]) \(\d+\) [^\s:]+:/.exec(this.line);
      this.severity = match ? SEVERITIES[match[1] as keyof typeof SEVERITIES] : '';
    }
    const label = this.severity ? `[${this.severity}] ` : '';
    this.emit(
      `${formatTrafficHeader(this.timestamp!, this.direction, false, this.settings.compactTimestamps)} ${label}${this.line}${continued ? ' [continued]' : ''}\n`,
    );
    this.line = '';
    if (!continued) {
      this.timestamp = undefined;
      this.severity = undefined;
    }
  }

  private isText(character: string): boolean {
    const code = character.codePointAt(0)!;
    if (this.escape === 'string' || this.escape === 'stringEscape') {
      if (
        code === 0x9c ||
        (this.osc && code === 0x07) ||
        (this.escape === 'stringEscape' && character === '\\')
      ) {
        this.escape = 'text';
      } else {
        this.escape = code === 0x1b ? 'stringEscape' : 'string';
      }
      return false;
    }
    if (code === 0x1b) {
      this.escape = 'escape';
      return false;
    }
    if (code === 0x9b) {
      this.escape = 'csi';
      return false;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      this.escape = 'string';
      this.osc = code === 0x9d;
      return false;
    }
    if (this.escape === 'escape') {
      if (character === '[') {
        this.escape = 'csi';
      } else if (']PX^_'.includes(character)) {
        this.escape = 'string';
        this.osc = character === ']';
      } else if (code >= 0x20 && code <= 0x2f) {
        this.escape = 'intermediate';
      } else if (code >= 0x30 && code <= 0x7e) {
        this.escape = 'text';
      }
      return false;
    }
    if (this.escape === 'intermediate') {
      if (code >= 0x30 && code <= 0x7e) {
        this.escape = 'text';
      }
      return false;
    }
    if (this.escape === 'csi') {
      if (code >= 0x40 && code <= 0x7e) {
        this.escape = 'text';
      }
      return false;
    }
    return (
      character === '\t' ||
      character === '\r' ||
      character === '\n' ||
      (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))
    );
  }
}

/** Emits completed device lines in completion order; unfinished RX/TX lines remain independent. */
export class ReadableLog {
  private readonly directions: Record<LogDirection, DirectionLog>;

  constructor(emit: (line: string) => void, settings: { compactTimestamps: boolean }) {
    this.directions = {
      RX: new DirectionLog('RX', emit, settings),
      TX: new DirectionLog('TX', emit, settings),
    };
  }

  write(direction: LogDirection, bytes: Uint8Array, timestamp: string): void {
    this.directions[direction].write(bytes, timestamp);
  }

  /** Finalizes partial UTF-8 and text, discards unfinished escapes, and resets selected streams. */
  flush(direction?: LogDirection): void {
    if (direction) {
      this.directions[direction].flush();
    } else {
      this.directions.RX.flush();
      this.directions.TX.flush();
    }
  }
}
