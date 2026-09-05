import * as vscode from 'vscode';
import type { Severity } from './serial/lineAssembler';

/** One CSS hex colour per detected log level. An empty string means **no override**: the terminal
 * row keeps the configured TX/RX colour and the editor leaves the level token to the theme. That
 * escape hatch is why `INFO` can ship with a colour at all — recolouring every ordinary line is a
 * matter of taste, and anyone who dislikes it can clear one level without losing the others. */
export type SeverityColors = Record<Severity, string>;

/** Display order for the panel's "Level Colours" block — most to least severe, so it reads as a
 * legend rather than an alphabetised list. */
export const SEVERITY_ORDER: readonly Severity[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

/** Kept in sync with the `serialPort.severityColors` default in `package.json` and with the
 * `configurationDefaults` textMateRules that colour the same levels before the extension activates.
 * ERROR/WARN are VS Code's own error/warning foregrounds; INFO is deliberately desaturated so an
 * ordinary log line reads as present-but-quiet rather than competing with a real problem; TRACE is
 * dimmer than DEBUG so the two stay distinguishable. */
export const DEFAULT_SEVERITY_COLORS: SeverityColors = {
  ERROR: '#f14c4c',
  WARN: '#cca700',
  INFO: '#6f9dc0',
  DEBUG: '#9d9d9d',
  TRACE: '#6e6e6e',
};

/**
 * Reads `serialPort.severityColors`, merging the user's value over the defaults key by key rather
 * than trusting the whole object to be present: a user who sets only `ERROR` in `settings.json`
 * must still get the other four defaults, not four blanks. A non-string value is ignored the same
 * way a missing one is.
 */
export function readSeverityColors(): SeverityColors {
  const stored = vscode.workspace.getConfiguration('serialPort').get<Record<string, unknown>>('severityColors') ?? {};
  const colors = { ...DEFAULT_SEVERITY_COLORS };
  for (const severity of SEVERITY_ORDER) {
    const value = stored[severity];
    if (typeof value === 'string') {
      colors[severity] = value;
    }
  }
  return colors;
}
