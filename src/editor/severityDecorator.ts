import * as vscode from 'vscode';
import type { Severity } from '../serial/lineAssembler';
import { parseAnnotatedHeader } from '../serial/format';
import { readSeverityColors, SEVERITY_ORDER, SeverityColors } from '../severityColors';

/** Languages whose documents can contain our header shape: the dedicated `serial-log` language
 * (`*.serial.log`, `*.raw.log`) and VS Code's built-in `log`, which is where an older recording or
 * a custom `saveLogAt` naming lands and where our grammar injection already applies. Anything else
 * is left alone outright, and even within these two `parseAnnotatedHeader` still has to match the
 * full header before a line is touched. */
const DECORATED_LANGUAGES = new Set(['serial-log', 'log']);

/** Upper bound on the lines scanned per refresh. A recorded session is thousands of lines, not
 * millions; this exists only so an accidentally-huge file can't stall the extension host, and the
 * cap degrades gracefully — the first `MAX_SCAN_LINES` lines are still decorated. */
const MAX_SCAN_LINES = 200_000;

/** Levels worth a mark in the scrollbar's overview ruler. Only the two that mean "something went
 * wrong": marking every INFO line would paint the whole ruler and tell the reader nothing. */
const RULER_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(['ERROR', 'WARN']);

/** Coalescing window for document edits. A log being recorded grows continuously, so re-scanning on
 * every change event would mean re-scanning several times a second for the whole session. */
const REFRESH_DEBOUNCE_MS = 250;

/** Settings that change what a decorated line looks like, so a change to any of them has to rebuild
 * the palette. The direction colours are in here because the editor now paints TX/RX and the payload
 * with the same two colours the terminal uses. */
const COLOR_SETTINGS = ['serialPort.severityColors', 'serialPort.txColor', 'serialPort.rxColor'];

type Direction = 'TX' | 'RX';

/** Decoration bucket for a line's payload — the device's own bytes after the closing bracket. Keyed
 * by whatever decides the colour: the detected level when it has an override, otherwise the
 * direction. Same precedence the terminal uses for its rows, so the two surfaces agree. */
type PayloadKey = Severity | Direction;

/**
 * Paints a recorded log the way the terminal paints it, from the same settings:
 * `serialPort.severityColors` for the level token and the payload of a classified line,
 * `serialPort.txColor`/`rxColor` for the direction token and everything an unclassified line
 * carries.
 *
 * A TextMate grammar cannot read a setting, so the shipped `configurationDefaults` textMateRules
 * can only ever provide a fixed palette. Decorations can, and they paint over token colours, so
 * once this is running the settings are what the user actually sees — changing a colour in the
 * panel updates every open log immediately, with no reload and no editing of `settings.json`.
 *
 * The timestamp and the mode column are deliberately left to the theme: they repeat identically on
 * every line, and colouring them too would leave nothing on the line that *isn't* shouting.
 *
 * The overview-ruler marks are the other half of the value: in a ten-thousand-line boot log, an
 * ERROR is otherwise findable only by scrolling or searching.
 */
export class SeverityDecorator implements vscode.Disposable {
  private levelTypes = new Map<Severity, vscode.TextEditorDecorationType>();
  private directionTypes = new Map<Direction, vscode.TextEditorDecorationType>();
  private payloadTypes = new Map<PayloadKey, vscode.TextEditorDecorationType>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.rebuildTypes();
    this.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (DECORATED_LANGUAGES.has(event.document.languageId)) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (COLOR_SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
          this.rebuildTypes();
          this.refresh();
        }
      }),
    );
    this.refresh();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.disposeTypes();
  }

  /** Disposing a decoration type also removes it from every editor showing it, which is exactly the
   * cleanup wanted before installing a new palette — no stale colours can survive a rebuild. */
  private disposeTypes(): void {
    for (const map of [this.levelTypes, this.directionTypes, this.payloadTypes]) {
      map.forEach((type) => type.dispose());
      map.clear();
    }
  }

  private rebuildTypes(): void {
    this.disposeTypes();
    const config = vscode.workspace.getConfiguration('serialPort');
    const severityColors: SeverityColors = readSeverityColors();
    const directionColors: Record<Direction, string> = {
      TX: config.get<string>('txColor') ?? '',
      RX: config.get<string>('rxColor') ?? '',
    };

    for (const severity of SEVERITY_ORDER) {
      const color = severityColors[severity];
      if (!color) {
        continue; // empty means "no override" — leave this level to the theme and the direction colour
      }
      this.levelTypes.set(
        severity,
        vscode.window.createTextEditorDecorationType({
          color,
          // Matches the shipped grammar default, and keeps a real failure heavier than the level
          // words around it even when a user picks a low-contrast red.
          fontWeight: severity === 'ERROR' ? 'bold' : undefined,
          overviewRulerColor: RULER_SEVERITIES.has(severity) ? color : undefined,
          overviewRulerLane: RULER_SEVERITIES.has(severity) ? vscode.OverviewRulerLane.Right : undefined,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
      );
      this.payloadTypes.set(severity, this.plainColorType(color));
    }

    for (const direction of ['TX', 'RX'] as const) {
      const color = directionColors[direction];
      if (!color) {
        continue;
      }
      this.directionTypes.set(direction, this.plainColorType(color));
      this.payloadTypes.set(direction, this.plainColorType(color));
    }
  }

  /** A colour-only type. Each range needs its own instance even when two share a colour, because
   * `setDecorations` replaces every range of a type at once — reusing one across buckets would make
   * the last call wipe the earlier ones. */
  private plainColorType(color: string): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      color,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorate(editor);
    }
  }

  /**
   * Scans the whole document (up to `MAX_SCAN_LINES`) rather than only its visible range: the ruler
   * marks are only useful if they cover the file, and VS Code renders just the decorations that are
   * actually on screen, so the ranges themselves are cheap to hold.
   */
  private decorate(editor: vscode.TextEditor): void {
    if (!DECORATED_LANGUAGES.has(editor.document.languageId)) {
      return;
    }
    const levels = new Map<Severity, vscode.Range[]>();
    const directions = new Map<Direction, vscode.Range[]>();
    const payloads = new Map<PayloadKey, vscode.Range[]>();
    this.levelTypes.forEach((_type, key) => levels.set(key, []));
    this.directionTypes.forEach((_type, key) => directions.set(key, []));
    this.payloadTypes.forEach((_type, key) => payloads.set(key, []));

    const lineCount = Math.min(editor.document.lineCount, MAX_SCAN_LINES);
    for (let lineNumber = 0; lineNumber < lineCount; lineNumber++) {
      const text = editor.document.lineAt(lineNumber).text;
      const header = parseAnnotatedHeader(text);
      if (!header) {
        continue;
      }

      directions
        .get(header.direction)
        ?.push(new vscode.Range(lineNumber, header.directionStart, lineNumber, header.directionEnd));

      if (header.severity) {
        levels
          .get(header.severity)
          ?.push(new vscode.Range(lineNumber, header.severityStart, lineNumber, header.severityEnd));
      }

      if (header.payload < text.length) {
        // The level wins over the direction, and a level with no override falls through to it —
        // exactly `printRecord`'s precedence in the terminal, minus the device's own SGR, which
        // never reaches the file.
        const key: PayloadKey =
          header.severity && this.payloadTypes.has(header.severity) ? header.severity : header.direction;
        payloads.get(key)?.push(new vscode.Range(lineNumber, header.payload, lineNumber, text.length));
      }
    }

    // Every live type is set, including the ones with no matches, so a bucket that used to match and
    // no longer does has its old ranges cleared rather than left behind.
    this.levelTypes.forEach((type, key) => editor.setDecorations(type, levels.get(key) ?? []));
    this.directionTypes.forEach((type, key) => editor.setDecorations(type, directions.get(key) ?? []));
    this.payloadTypes.forEach((type, key) => editor.setDecorations(type, payloads.get(key) ?? []));
  }
}
