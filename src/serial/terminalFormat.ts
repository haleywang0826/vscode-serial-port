import { bytesToAsciiForTerminal, concatBytes, splitTrailingEscape } from './format';

// eslint-disable-next-line no-control-regex -- SGR sequences start with the ESC control byte.
const SGR = /\x1b\[([0-9;:]*)m/g;

/** Remembers effective attributes, not an ever-growing history of device escape sequences. */
export class SgrState {
  private readonly attributes = new Map<string, string>();
  private resetBase = false;

  get sequence(): string {
    const parameters = [...this.attributes.values()];
    return (
      (this.resetBase ? '\x1b[0m' : '') + (parameters.length ? `\x1b[${parameters.join(';')}m` : '')
    );
  }

  update(text: string): void {
    for (const match of text.matchAll(SGR)) {
      const parameters = match[1].split(';');
      for (let i = 0; i < parameters.length; i++) {
        let value = parameters[i];
        const code = Number(value.split(':')[0]);
        if (code === 0) {
          this.attributes.clear();
          this.resetBase = true;
          continue;
        }
        if (code === 38 || code === 48 || code === 58) {
          if (!value.includes(':')) {
            const count = parameters[i + 1] === '5' ? 2 : parameters[i + 1] === '2' ? 4 : 0;
            if (!count || i + count >= parameters.length) break;
            value = parameters.slice(i, i + count + 1).join(';');
            i += count;
          }
          this.attributes.set(
            code === 38 ? 'foreground' : code === 48 ? 'background' : 'underlineColor',
            value,
          );
          continue;
        }
        if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97) || code === 39) {
          this.attributes.set('foreground', value);
        } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 49) {
          this.attributes.set('background', value);
        } else if (code === 59) {
          this.attributes.delete('underlineColor');
        } else if (code === 1 || code === 2) {
          this.attributes.set(String(code), value);
        } else if (code === 22) {
          this.attributes.delete('1');
          this.attributes.delete('2');
        } else if (code >= 10 && code <= 19) {
          this.attributes.set('font', value);
        } else {
          const groups = [
            [3, 20, 23],
            [4, 21, 24],
            [5, 6, 25],
            [7, 27],
            [8, 28],
            [9, 29],
            [26, 50],
            [51, 52, 54],
            [53, 55],
            [60, 61, 62, 63, 64, 65],
            [73, 74, 75],
          ];
          const group = groups.find((codes) => codes.includes(code));
          if (group) {
            const key = String(group[0]);
            if (code === group[group.length - 1]) {
              this.attributes.delete(key);
            } else {
              this.attributes.set(key, value);
            }
          }
        }
      }
    }
  }
}

export class RxTerminalFormatter {
  private pending: Uint8Array = new Uint8Array(0);
  private readonly sgr = new SgrState();

  format(bytes: Uint8Array): string {
    const { complete, pending } = splitTrailingEscape(concatBytes(this.pending, bytes));
    this.pending = pending;
    const text = bytesToAsciiForTerminal(complete);
    const previousStyle = this.sgr.sequence;
    this.sgr.update(text);
    // A color-only read must update the state without adding a blank traffic row.
    return text.replace(SGR, '').length ? previousStyle + text : '';
  }
}
