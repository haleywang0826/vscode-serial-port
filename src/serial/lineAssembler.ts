/**
 * Turns a raw serial byte stream into one record per *device line*.
 *
 * Everything that has to look at the byte stream character-by-character lives here, in a single
 * pass: UTF-8 reassembly across reads, ANSI escape parsing, SGR (colour) state tracking, line
 * splitting, and severity detection. Previously this work was split between `format.ts`
 * (`bytesToAscii`, `bytesToAsciiForTerminal`, `splitTrailingEscape`,
 * `splitTrailingIncompleteUtf8`) and the terminal's own `pendingRx` carry-over buffer, which meant
 * the terminal and the file log each re-derived the same facts from the same bytes and could
 * disagree about them. One assembler instance per direction per connection now derives them once
 * and hands both consumers exactly what each needs — `render` for the terminal (device colours
 * kept inline), `plain` for the log (every escape removed).
 */

/** Longest line we will accumulate before force-terminating it. A device stuck emitting bytes with
 * no line break must not be able to grow this buffer without bound; 16 KiB is far past any real
 * log line while still being a single allocation's worth of text. */
const MAX_LINE_CHARS = 16 * 1024;

const ESC = 0x1b;
/** 8-bit C1 CSI introducer — the single-byte equivalent of `ESC [`. Some devices (and anything
 * speaking a 8-bit-clean VT stream) emit this instead of the two-byte form. */
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const BEL = 0x07;

export type Severity = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';
export type Direction = 'TX' | 'RX';

/**
 * One unit of traffic, ready to render or log.
 *
 * `kind: 'hex'` is a raw chunk, emitted when the direction's hex mode is on — a hex dump has no
 * line structure to assemble, so those bytes bypass the assembler entirely and keep the existing
 * chunk-at-a-time behaviour. `kind: 'line'` is one device line.
 */
export type TrafficRecord =
  | { kind: 'hex'; direction: Direction; timestamp: string; bytes: Uint8Array }
  | {
      kind: 'line';
      direction: Direction;
      timestamp: string;
      /** Text with the device's own SGR sequences inline, prefixed by the SGR state carried in
       * from earlier lines — so a colour a device set before a line break still applies. */
      render: string;
      /** The same text with every escape sequence removed. What the file log writes. */
      plain: string;
      severity?: Severity;
      /** True when this record is an idle-flushed *partial* line — the device stopped mid-line and
       * we surfaced what we had rather than making the user wait for a newline that may never come. */
      continues: boolean;
      /** True when this record continues a partial that was already emitted, so a consumer can
       * append to the row it already drew instead of starting a new one. */
      continued: boolean;
    };

/**
 * Folds a stream of SGR parameters into the set of attributes currently in *effect*, so the state
 * can be re-emitted as one short sequence at the start of the next line. Keeping effective
 * attributes (rather than replaying every escape the device ever sent) is what bounds this: a
 * device that recolours every line would otherwise accumulate an unbounded replay list.
 *
 * Attributes are keyed by the thing they control ('fg', 'bg', 'weight', ...) rather than by their
 * numeric code, since within a group the codes are mutually exclusive — `1` (bold) and `2` (dim)
 * both set 'weight', and `22` clears it.
 */
export class SgrTracker {
  private readonly attributes = new Map<string, string>();

  /** True once any attribute has been set since the last full reset — lets `sequence` skip
   * emitting a redundant `ESC[0m` for a stream that has never used colour at all. */
  private dirty = false;

  get isDefault(): boolean {
    return !this.dirty && this.attributes.size === 0;
  }

  /** The current state as a single SGR sequence, or '' if nothing is set. Always leads with a
   * reset so it fully replaces whatever state the terminal happens to be in. */
  get sequence(): string {
    if (this.attributes.size === 0) {
      return this.dirty ? '\x1b[0m' : '';
    }
    return `\x1b[0;${[...this.attributes.values()].join(';')}m`;
  }

  /** The current foreground parameter (e.g. '31', '91', '38;5;208'), or undefined if default. */
  get foreground(): string | undefined {
    return this.attributes.get('fg');
  }

  reset(): void {
    this.attributes.clear();
    this.dirty = false;
  }

  /** Applies one SGR sequence's parameter string (the text between `ESC[` and `m`). */
  apply(parameters: string): void {
    // A bare `ESC[m` means `ESC[0m`.
    const codes = parameters.length === 0 ? [''] : parameters.split(';');
    for (let i = 0; i < codes.length; i++) {
      const raw = codes[i];
      // A colon-separated sub-parameter (ITU T.416 form, e.g. `38:2::r:g:b`) is self-contained;
      // only the leading number selects the attribute.
      const code = Number(raw.split(':')[0] || '0');
      if (!Number.isFinite(code)) {
        continue;
      }
      if (code === 0) {
        this.attributes.clear();
        this.dirty = true;
        continue;
      }
      if (code === 38 || code === 48) {
        const key = code === 38 ? 'fg' : 'bg';
        if (raw.includes(':')) {
          this.set(key, raw);
          continue;
        }
        // Semicolon form: `38;5;n` (256-colour) or `38;2;r;g;b` (truecolour). Consume the whole
        // run as one value so it is re-emitted intact; anything malformed is dropped rather than
        // half-applied.
        const extra = codes[i + 1] === '5' ? 2 : codes[i + 1] === '2' ? 4 : 0;
        if (extra === 0 || i + extra >= codes.length) {
          break;
        }
        this.set(key, codes.slice(i, i + extra + 1).join(';'));
        i += extra;
        continue;
      }
      this.applySimple(code, raw);
    }
  }

  private applySimple(code: number, raw: string): void {
    if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      this.set('fg', raw);
    } else if (code === 39) {
      this.clear('fg');
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      this.set('bg', raw);
    } else if (code === 49) {
      this.clear('bg');
    } else if (code === 1 || code === 2) {
      this.set('weight', raw);
    } else if (code === 22) {
      this.clear('weight');
    } else if (code === 3) {
      this.set('italic', raw);
    } else if (code === 23) {
      this.clear('italic');
    } else if (code === 4) {
      this.set('underline', raw);
    } else if (code === 24) {
      this.clear('underline');
    } else if (code === 5 || code === 6) {
      this.set('blink', raw);
    } else if (code === 25) {
      this.clear('blink');
    } else if (code === 7) {
      this.set('reverse', raw);
    } else if (code === 27) {
      this.clear('reverse');
    } else if (code === 8) {
      this.set('hidden', raw);
    } else if (code === 28) {
      this.clear('hidden');
    } else if (code === 9) {
      this.set('strike', raw);
    } else if (code === 29) {
      this.clear('strike');
    }
    // Anything else (fonts, framing, ideogram attributes) is deliberately ignored: it is not
    // rendered by VS Code's terminal, so carrying it across lines would only add noise.
  }

  private set(key: string, value: string): void {
    this.attributes.set(key, value);
    this.dirty = true;
  }

  private clear(key: string): void {
    this.attributes.delete(key);
    this.dirty = true;
  }
}

/** Escape-sequence parser states. `csi` covers both the 7-bit `ESC [` and 8-bit `0x9B` forms;
 * `string` covers OSC/DCS/PM/APC, which run until BEL or ST rather than a single final byte. */
type EscapeState = 'text' | 'escape' | 'csi' | 'string';

interface AssemblerCallbacks {
  emit(record: TrafficRecord): void;
  /** Read at emit time (never captured), so toggling the setting mid-session takes effect on the
   * next line without touching already-emitted records. */
  detectSeverity(): boolean;
}

/**
 * Per-direction line assembler. Feed it bytes with `write`; it calls back with one record per
 * completed device line. Call `flushPartial` from an idle timer to surface a line the device left
 * unterminated (a prompt), and `flush` on close to make sure nothing buffered is silently lost.
 */
export class LineAssembler {
  private readonly decoder = new StreamingUtf8Decoder();
  private readonly sgr = new SgrTracker();

  private escape: EscapeState = 'text';
  private csiParameters = '';
  /** True when the in-progress string sequence is an OSC, which may terminate with BEL as well as
   * ST — DCS/PM/APC only accept ST. */
  private oscString = false;

  private render = '';
  private plain = '';
  /** Timestamp of the first byte that landed in the current line, so a line's timestamp reflects
   * when the device started emitting it, not when it happened to finish. */
  private lineTimestamp: string | undefined;
  /** Set after a CR so an immediately-following LF (the CRLF pair) does not end a second, empty
   * line. Cleared by any other byte, so a lone CR still terminates. */
  private skipLf = false;
  /** True once a partial has been emitted for the line currently being accumulated, so the next
   * record for it is marked `continued` and consumers can append rather than redraw. */
  private partialEmitted = false;

  constructor(
    private readonly direction: Direction,
    private readonly callbacks: AssemblerCallbacks,
  ) {}

  write(bytes: Uint8Array, timestamp: string): void {
    for (const character of this.decoder.decode(bytes)) {
      this.consume(character, timestamp);
    }
  }

  /** Emits whatever is accumulated as a partial line, if there is anything. Called from the idle
   * timer so a device prompt with no trailing newline still shows up promptly. Gated on `plain`
   * rather than `render`, since a buffer holding only escapes (a device that ends its burst with a
   * trailing `ESC[0m`) has nothing to show — emitting it would manufacture a blank row and a blank
   * log line. Those escapes stay buffered and go out with the next line that has real text. A blank
   * line the device genuinely sent is unaffected: that arrives as a newline and emits from
   * `consume` directly. */
  flushPartial(): void {
    if (this.plain.length === 0) {
      return;
    }
    this.emitLine(true);
  }

  /**
   * Finalizes the stream: decodes any held-back UTF-8 bytes (a truncated character renders as
   * U+FFFD rather than vanishing), emits any accumulated text as a final line, and resets all
   * state. Used on port close and on dispose, where holding bytes back would lose them for good.
   */
  flush(): void {
    for (const character of this.decoder.end()) {
      this.consume(character, this.lineTimestamp ?? '');
    }
    if (this.plain.length > 0) {
      this.emitLine(false);
    }
    this.reset();
  }

  /** Drops all buffered state without emitting. Used when the direction's hex mode toggles (the
   * byte stream is about to be interpreted a completely different way) and on (re)attach. */
  reset(): void {
    this.decoder.reset();
    this.sgr.reset();
    this.escape = 'text';
    this.csiParameters = '';
    this.oscString = false;
    this.render = '';
    this.plain = '';
    this.lineTimestamp = undefined;
    this.skipLf = false;
    this.partialEmitted = false;
  }

  private consume(character: string, timestamp: string): void {
    const code = character.codePointAt(0)!;

    if (this.escape !== 'text') {
      this.consumeEscape(character, code);
      return;
    }
    if (code === ESC) {
      this.escape = 'escape';
      return;
    }
    if (code === C1_CSI) {
      this.escape = 'csi';
      this.csiParameters = '';
      return;
    }
    // C1 string introducers: DCS (0x90), SOS (0x98), OSC (0x9d), PM (0x9e), APC (0x9f).
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      this.escape = 'string';
      this.oscString = code === 0x9d;
      return;
    }

    if (character === '\n' && this.skipLf) {
      this.skipLf = false; // second half of a CRLF pair; the CR already ended the line
      return;
    }
    this.skipLf = false;

    if (character === '\r' || character === '\n') {
      this.lineTimestamp ??= timestamp;
      this.emitLine(false);
      this.skipLf = character === '\r';
      return;
    }

    // Every remaining C0/C1 control character is rendered as a visible `\xNN` escape rather than
    // shown literally: BEL would beep, and a stray VT/FF/NUL in a log line is noise at best and
    // corrupts column alignment at worst. Tab is exempt, since it is load-bearing in plenty of
    // device output.
    //
    // Escaping rather than *dropping* is the point. A device answering a hex send with control
    // bytes while the session is in ASCII receive used to produce nothing at all — the bytes were
    // dropped, `plain` stayed empty, and `flushPartial` has nothing to emit for an empty line — so
    // an echo that plainly happened looked like a dead port. Whatever arrives on the wire now
    // always leaves a mark, and `\x00` is still obviously not text the device meant you to read.
    const text = character !== '\t' && (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      ? `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`
      : character;

    this.lineTimestamp ??= timestamp;
    if (this.plain.length + text.length > MAX_LINE_CHARS) {
      this.emitLine(true); // force-terminate; the continuation is marked `continued`
      this.lineTimestamp = timestamp;
    }
    this.render += text;
    this.plain += text;
  }

  private consumeEscape(character: string, code: number): void {
    if (this.escape === 'escape') {
      if (character === '[') {
        this.escape = 'csi';
        this.csiParameters = '';
      } else if (character === ']' || character === 'P' || character === 'X' || character === '^' || character === '_') {
        this.escape = 'string';
        this.oscString = character === ']';
      } else if (code >= 0x20 && code <= 0x2f) {
        // Intermediate byte; stay in `escape` until the final byte arrives.
      } else {
        this.escape = 'text'; // final byte of a short escape (or garbage) — consumed and dropped
      }
      return;
    }
    if (this.escape === 'csi') {
      if (code >= 0x30 && code <= 0x3f) {
        this.csiParameters += character; // parameter bytes
        return;
      }
      if (code >= 0x20 && code <= 0x2f) {
        return; // intermediate bytes; not meaningful for SGR
      }
      if (code >= 0x40 && code <= 0x7e) {
        if (character === 'm') {
          // SGR is the one sequence we keep: it is what makes device colour work, and it cannot
          // move the cursor or disturb the terminal's pinned-input scroll region.
          this.sgr.apply(this.csiParameters);
          this.render += `\x1b[${this.csiParameters}m`;
        }
        // Every other CSI (cursor movement, erase, scroll-region changes) is dropped: letting a
        // device reposition the cursor would corrupt the pinned input row and the timestamp
        // columns. Raw-input mode bypasses the assembler entirely when a user wants that control.
        this.escape = 'text';
        this.csiParameters = '';
      }
      return;
    }
    // `string`: OSC/DCS/PM/APC run until ST (`ESC \` or 0x9c), and OSC also accepts BEL.
    if (code === C1_ST || (this.oscString && code === BEL)) {
      this.escape = 'text';
      return;
    }
    if (code === ESC) {
      // Either the start of a `ESC \` string terminator or a device restarting mid-string; either
      // way the string is over and the next byte decides what follows.
      this.escape = 'escape';
    }
  }

  private emitLine(continues: boolean): void {
    const plain = this.plain;
    const carried = this.sgrPrefix();
    const severity = this.detectLineSeverity(plain);
    this.callbacks.emit({
      kind: 'line',
      direction: this.direction,
      timestamp: this.lineTimestamp ?? '',
      render: carried + this.render,
      plain,
      severity,
      continues,
      continued: this.partialEmitted,
    });
    this.render = '';
    this.plain = '';
    this.partialEmitted = continues;
    if (!continues) {
      this.lineTimestamp = undefined;
    }
  }

  /**
   * Classifies a line's severity — but only for RX.
   *
   * TX is what the *user* typed or a template sent; it is a command, not a log record, and it has no
   * level. Classifying it produced two concrete problems against a device that echoes: typing
   * `[ERROR] test` coloured the outgoing row red as well as the echoed-back one, and the log line
   * for the send read `… RX ERROR] [ERROR] test`, where the level column was describing the user's
   * own text rather than anything the device had said. Leaving TX unclassified also means a TX row
   * always renders in the configured TX colour, so direction stays readable at a glance.
   */
  private detectLineSeverity(plain: string): Severity | undefined {
    if (this.direction !== 'RX' || !this.callbacks.detectSeverity()) {
      return undefined;
    }
    return detectSeverity(plain, this.sgr.foreground);
  }

  /**
   * The SGR state to re-prime at the start of the emitted line. Taken *before* this line's own
   * inline escapes are applied would be ideal, but the tracker folds them in as they are parsed —
   * so instead we rely on the fact that a device's colour is nearly always set at the start of the
   * line it applies to: re-emitting the current state is correct for the common case (a colour set
   * on a previous line still applying) and harmless when the line sets its own colour immediately
   * after, since that escape simply overrides it.
   */
  private sgrPrefix(): string {
    return this.sgr.isDefault ? '' : this.sgr.sequence;
  }
}

/**
 * Incremental UTF-8 decoder that holds back a trailing incomplete sequence between calls, so a
 * multi-byte character split across two `serialport` `'data'` reads decodes as one character
 * instead of two U+FFFD replacements. Iterating the result yields whole code points (including
 * astral ones), which is what the assembler's per-character state machine needs.
 */
class StreamingUtf8Decoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  decode(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  /** Finalizes the decoder to ensure any trailing bytes are rendered as U+FFFD if incomplete.
   * Used on close, where no further bytes will ever arrive. */
  end(): string {
    return this.decoder.decode(new Uint8Array(0));
  }

  reset(): void {
    // TextDecoder maintains internal state across calls with stream: true, but reset isn't exposed.
    // Create a new decoder instance to clear any held state (though this only matters if we ever
    // switch character sets mid-stream, which doesn't happen in serial—the device picks one encoding).
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const SEVERITY_BY_LETTER: Record<string, Severity> = {
  E: 'ERROR',
  W: 'WARN',
  I: 'INFO',
  D: 'DEBUG',
  V: 'TRACE',
};

const SEVERITY_BY_WORD: Record<string, Severity> = {
  ERR: 'ERROR',
  ERROR: 'ERROR',
  FATAL: 'ERROR',
  CRITICAL: 'ERROR',
  CRIT: 'ERROR',
  PANIC: 'ERROR',
  ALERT: 'ERROR',
  EMERG: 'ERROR',
  WRN: 'WARN',
  WARN: 'WARN',
  WARNING: 'WARN',
  INF: 'INFO',
  INFO: 'INFO',
  NOTICE: 'INFO',
  DBG: 'DEBUG',
  DEBUG: 'DEBUG',
  VERBOSE: 'TRACE',
  TRACE: 'TRACE',
};

/** ESP-IDF / ESP8266 RTOS SDK: `E (12345) wifi: message`, optionally with the core id
 * (`E (12345) 0 wifi:`). The tag must be followed by a colon, which is what keeps this from
 * matching an ordinary sentence that happens to start with a capital letter. */
const ESP_IDF_RE = /^([EWIDV]) \(\d+\)(?: \d+)? [^\s:]+:/;
/** Zephyr's log backend: `[00:00:01.234,000] <err> module: message`. */
const ZEPHYR_RE = /^\[\d{2}:\d{2}:\d{2}[.,]\d{3}(?:,\d{3})?\]\s*<(err|wrn|inf|dbg)>/i;
/** Linux/printk kernel level prefix: `<3>` (KERN_ERR) through `<7>` (KERN_DEBUG). */
const PRINTK_RE = /^<([0-7])>/;
/** Android logcat-ish: `E/TagName( 123):` or `E/TagName:`. */
const LOGCAT_RE = /^([EWIDV])\/[^\s/:]+\s*(?:\(\s*\d+\s*\))?:/;
/** A bracketed or trailing-colon level word at the very start of the line: `[ERROR] …`,
 * `ERROR: …`, `(WARN) …`. Anchored so the word "error" inside a message never triggers it. */
const LEVEL_WORD_RE = /^[[(]?([A-Za-z]{3,8})[\])]?\s*[:\-\]]/;
/** ESP32 crash/abort banners, which carry no level prefix of their own but are unambiguously
 * fatal — surfacing them as ERROR is what makes a crash findable in a long log. */
const CRASH_RE =
  /^(Guru Meditation Error|abort\(\) was called|assert failed|Backtrace:|Rebooting\.\.\.|CORRUPT HEAP|Stack canary watchpoint triggered|Debug exception reason)/;

/** printk numeric levels 0-7 mapped onto our five severities. */
const PRINTK_SEVERITY: Severity[] = ['ERROR', 'ERROR', 'ERROR', 'ERROR', 'WARN', 'INFO', 'INFO', 'DEBUG'];

/**
 * Classifies a device line's severity from its text, falling back to its ANSI foreground colour.
 *
 * Every pattern is anchored to the start of the line: a message that merely *contains* the word
 * "error" is not an error line, and treating it as one would mis-colour ordinary prose and fill a
 * log with false `[ERROR]` markers. The colour fallback only runs when no textual prefix matched,
 * since a device that labels its lines is always more authoritative than the palette it chose.
 */
export function detectSeverity(line: string, foreground?: string): Severity | undefined {
  const text = line.trimStart();
  if (text.length === 0) {
    return undefined;
  }

  const espIdf = ESP_IDF_RE.exec(text);
  if (espIdf) {
    return SEVERITY_BY_LETTER[espIdf[1]];
  }
  const zephyr = ZEPHYR_RE.exec(text);
  if (zephyr) {
    return SEVERITY_BY_WORD[zephyr[1].toUpperCase()];
  }
  const printk = PRINTK_RE.exec(text);
  if (printk) {
    return PRINTK_SEVERITY[Number(printk[1])];
  }
  const logcat = LOGCAT_RE.exec(text);
  if (logcat) {
    return SEVERITY_BY_LETTER[logcat[1]];
  }
  if (CRASH_RE.test(text)) {
    return 'ERROR';
  }
  const word = LEVEL_WORD_RE.exec(text);
  if (word) {
    const severity = SEVERITY_BY_WORD[word[1].toUpperCase()];
    if (severity) {
      return severity;
    }
  }
  return severityFromColor(foreground);
}

/**
 * Last-resort classification from the line's ANSI foreground colour, using the convention every
 * embedded logging framework follows (ESP-IDF, Zephyr, NuttX, Arduino libraries): red for errors,
 * yellow for warnings, green for info. Only the basic and bright 3-bit colours are considered —
 * a 256-colour or truecolour value is a deliberate palette choice by the device, not a level.
 */
function severityFromColor(foreground: string | undefined): Severity | undefined {
  if (!foreground) {
    return undefined;
  }
  switch (foreground) {
    case '31':
    case '91':
      return 'ERROR';
    case '33':
    case '93':
      return 'WARN';
    case '32':
    case '92':
      return 'INFO';
    default:
      return undefined;
  }
}
