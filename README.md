# Serial Port for VSCode

A full-featured serial port tool built right into VS Code: monitor a port's
output live, send and receive data as hex or ASCII, toggle RTS/DTR, run
multiple ports in parallel, log sessions to file, and save/reuse send
templates — all from the Activity Bar, without leaving your editor.

## Features

- **Live per-port terminal** — an interactive terminal for each open port,
  color-coded by TX/RX direction, with optional per-line timestamps.
- **Device colors, preserved** — ANSI/SGR escapes from the device (ESP-IDF's
  red/yellow/green log output, Zephyr's shell, anything using colored
  `printf`) render as colors, and a color set at the start of a burst still
  applies to the end of it.
- **Log-level detection** — ESP-IDF, Zephyr, Linux printk, Android and
  generic `[ERROR]`-style prefixes are recognized on received lines and used
  to color the terminal row and fill in the log header's level column.
- **Hex or ASCII**, independently for send and receive.
- **Configurable line ending** per session (none / NL / CR / CRLF), so an
  ESP-IDF console, Zephyr shell or AT-command modem actually sees a
  completed command.
- **Raw input mode** — every keystroke goes straight to the device, so
  `Ctrl+C`, `Ctrl+D` and arrow keys work against a MicroPython REPL or a
  device's own line editor.
- **Multiple ports open in parallel**, each with its own session card:
  live config, byte counters, and controls.
- **RTS/DTR control** per port — handy for boards that reset on a DTR/RTS
  edge (e.g. Arduino, ESP8266/ESP32).
- **Session logging to file** — record a port's traffic to a timestamped
  log file in your workspace (or wherever `serialPort.saveLogAt` points),
  as readable annotated lines or as a byte-exact raw capture.
- **Syntax highlighting for the log** — recorded logs open in the editor
  with the header, direction, timestamps and level tokens colored; see
  [Log files](#log-files) below.
- **Reusable send templates** — save frequently-sent hex/ASCII payloads and
  fire them at any open port with one click.
- **Works transparently from WSL** — open a WSL-remote VS Code window and
  add a physical Windows COM port with zero manual configuration; see
  [WSL support](#wsl-support) below.

## Getting started

1. Open the **Serial Port** view in the Activity Bar.
2. Pick a port from the dropdown and click **+** to add it as a session.
3. Click the session's toggle button to open it — a terminal appears; type
   and press Enter to send.
4. Expand **Default Settings** to change baud rate, data bits, parity, stop
   bits, or hex send/receive defaults for newly-added sessions. Each
   session can also override these while open.

## WSL support

If your VS Code window is connected to a WSL remote workspace, this
extension still talks to physical Windows COM ports with **no manual
configuration**. It declares `extensionKind: ["ui"]`, so VS Code always runs
it on the machine hosting the UI (Windows), while workspace-facing APIs
(`vscode.workspace.fs`, integrated terminals) are transparently proxied to
the actual WSL workspace. Practically: port I/O happens on Windows, and your
logs/templates land in the WSL filesystem you're working in.

## Sending to the device

Typing in a port's terminal and pressing Enter sends the line. What gets
appended to it is the session's **Line Ending** setting — `CRLF` by default,
which satisfies devices that accept only CR and devices that accept only NL.
Set it to **None** if you need to send exactly the bytes you typed. Hex sends
and hex templates never get a line ending appended.

The terminal is a **line editor** by default: it keeps a local history
(Up/Down), supports cursor editing, and pins your in-progress line to the
bottom row, so device output arriving mid-typing doesn't scramble what you
are writing. `Ctrl+L` clears the screen and `Ctrl+C` clears the pending line.

Check **Device Console** (under **Advanced** on the session card) when you need
the device itself to do the editing — a MicroPython REPL, a Zephyr shell, a
bootloader menu, or any full-screen device TUI. It hands the terminal over: the
pinned input row disappears, every keystroke (including `Ctrl+C`, `Ctrl+D` and
the arrow keys) is sent to the device immediately, and the device's own cursor
control is passed through untouched. Local history and `Ctrl+L` are line-mode
features and are not available while it is on. Logging keeps running either way.

## Log files

Check **Record to File** on a session card to record it. Two formats are
available via `serialPort.logFormat`:

**`annotated`** (default) — `<port>_<timestamp>.serial.log`. One physical
line per device line, so the file is greppable and diffable:

```
# --- COM8 recording started 2026-09-05T14:23:01.123+08:00 · 115200 8N1 ---
[09-05 14:23:01.140 ASC RX INFO ] I (301) cpu_start: Pro cpu up.
[09-05 14:23:01.142 ASC RX WARN ] W (318) spiram: no SPIRAM
[09-05 14:23:02.008 ASC TX      ] reboot
[09-05 14:23:02.311 ASC RX ERROR] E (402) wifi: connect failed
```

Every line is stamped with when the device *started* it and ANSI escapes are
stripped (no `←[0;31m` garbage in the editor). The timestamp carries no year
and no UTC offset — both are constant for the whole session and are recorded
once, in full, on the `# ---` banner; on every line they would only cost
horizontal space. Turn on **Compact Timestamps** to drop the date too and keep
just `14:23:01.140`.

The bracketed header is fixed-width, and it is the **only** thing this
extension adds to a line — everything after the closing `]` is byte-for-byte
what the device sent, so a device that labels its own output still reads
unambiguously:

```
[09-05 14:23:42.738 ASC RX ERROR] [ERROR] sensor 3 offline
                            ↑       ↑
                      detected      the device's own text
```

The level column is filled in for **received** lines only — what you send is a
command, not a log record, so a TX line is never classified and always renders
in the configured TX colour. Turn detection off entirely with
`serialPort.detectSeverity`; the column stays (blank) so the payload keeps
starting at the same offset on every line, which is what makes
`cut -c35-` and `grep ' ERROR]'` work.

**`raw`** — `<port>_<timestamp>.raw.log`. A byte-exact capture of the wire in
arrival order: no headers, nothing stripped or transformed, both directions
interleaved exactly as they happened. Use this when the capture has to be
diffed against another tool's or replayed. `Hex Receive` and `Show Timestamp`
do not affect it.

A received byte that cannot be displayed — a NUL, a BEL, a stray `0x7F` — is
written into an `annotated` line as a visible `\xNN` escape rather than being
dropped, so a device answering a hex send with control bytes while the session
is in ASCII receive still shows something instead of looking like a dead port.
Tab, CR and LF keep their normal meaning, and `raw` captures are untouched.

A line the device never terminates (a `esp32> ` prompt, or that same control-byte
echo) is held briefly so the file gets whole lines, then written out anyway once
it has been quiet for about ¾ of a second. If the device does continue it later,
the continuation is written as its own line — an append-only file can't revise a
line it has already written, and two lines beat a line that never appears.

The format is read when recording *starts*, so changing the setting mid-
recording never leaves one file holding a mix of both; the new format applies
the next time recording begins.

### Highlighting in the editor

`*.serial.log` and `*.raw.log` open in a **Serial Log** language that layers
serial-specific rules on top of VS Code's built-in **Log** grammar — so the
ISO dates, quoted strings, MAC/GUID constants and stack frames the built-in
grammar already colors still work, plus the `[timestamp MODE DIRECTION LEVEL]`
header, `RX`/`TX` direction, hex-dump payloads, ESP-IDF/Zephyr tag prefixes and
the `#` session banner. Plain `*.log` files (older recordings, or a custom
`saveLogAt` naming) get the same serial rules via a grammar injection, while
staying in the built-in **Log** language.

Every rule is anchored to the exact header shape this extension writes, so an
unrelated `.log` file you happen to open is left alone. The reader accepts every
header shape past versions wrote (`ASCII` as well as `ASC`, full ISO timestamps
as well as the short ones), so an older recording still highlights.

Bracket-pair colourisation is **off** for `*.serial.log` / `*.raw.log`. Device
output routinely contains an unbalanced `[`, and a single one shifts the nesting
depth for the whole rest of the file — every header bracket below it is drawn in
a different colour, which reads as a bug because it is one. Plain `*.log` files
stay in VS Code's built-in **Log** language, whose configuration this extension
does not control, so they still colourise brackets; set
`"[log]": { "editor.bracketPairColorization.enabled": false }` if that bothers
you.

**To see it without a device**, open [`samples/example.serial.log`](samples/example.serial.log)
— a hand-written file covering every rule, with a checklist of what to look for
at the bottom.

The level column ships with colors (red/yellow/blue/grey), because no VS Code
theme styles the `log.*` scopes on its own. They are contributed as *defaults*,
so if you already have an `editor.tokenColorCustomizations` of your own, it
replaces them — add these back, or recolor anything else, the same way:

```jsonc
"editor.tokenColorCustomizations": {
  "textMateRules": [
    { "scope": "log.error.serial", "settings": { "foreground": "#f14c4c", "fontStyle": "bold" } },
    { "scope": "log.warning.serial", "settings": { "foreground": "#cca700" } },
    { "scope": "log.info.serial", "settings": { "foreground": "#6f9dc0" } },
    { "scope": "log.debug.serial", "settings": { "foreground": "#9d9d9d" } },
    { "scope": "log.verbose.serial", "settings": { "foreground": "#6e6e6e" } },
    { "scope": "storage.type.mode.log.serial", "settings": { "foreground": "#6e6e6e" } },
    { "scope": "support.class.direction.rx.log.serial", "settings": { "foreground": "#33cc33" } },
    { "scope": "keyword.control.direction.tx.log.serial", "settings": { "foreground": "#00cccc" } },
    { "scope": "entity.name.tag.log.serial", "settings": { "fontStyle": "italic" } }
  ]
}
```

In practice you rarely need to: these rules are only the baseline for the moment
before the extension activates. Once it is running, the level token, the `RX`/`TX`
token and the payload are painted from `serialPort.severityColors` and
`serialPort.txColor`/`rxColor` instead (see below), which wins over any TextMate
rule.

Run **Developer: Inspect Editor Tokens and Scopes** on any line to see which
scopes apply to it.

### Level colours

`serialPort.severityColors` holds one CSS hex colour per level, and together with
`serialPort.txColor`/`rxColor` that palette drives **both** surfaces the same way
— an open log reads like the terminal it came from:

| Part of the line | Colour |
| --- | --- |
| timestamp, `ASC`/`HEX` | left to your theme (dimmed) — they repeat on every line |
| `RX` / `TX` | `serialPort.rxColor` / `serialPort.txColor` |
| the level token | `serialPort.severityColors[level]`, bold for `ERROR` |
| the device's own text | the level's colour, or the direction's when unclassified |

Both surfaces update live — change a colour and every open terminal and log
reflects it immediately, with no port reopen and no window reload. `ERROR` and
`WARN` also get a mark in the editor's scrollbar overview ruler, so a failure is
findable in a ten-thousand-line boot log without scrolling.

| Level | Default |
| --- | --- |
| `ERROR` | `#f14c4c` (bold in the editor) |
| `WARN` | `#cca700` |
| `INFO` | `#6f9dc0` |
| `DEBUG` | `#9d9d9d` |
| `TRACE` | `#6e6e6e` |

Set a level to `""` to turn its override off: the terminal row falls back to the
configured RX colour, and in the editor the level token is left to your theme
while the payload takes the RX colour. Useful for `INFO` if you would rather only
the unusual lines stand out.

The panel's **Default Settings › Level Colours** section has a picker for each
level (each label drawn in its own colour, so the block doubles as a legend), a
per-level button to turn the override off, **Reset all**, and a gear that opens
the same settings in VS Code's Settings UI. A device that emits its own ANSI
colours always wins over all of this — its bytes are passed through untouched.

## Extension Settings

All settings are under `serialPort.*` and configurable via the Settings UI,
`settings.json`, or the panel's own **Default Settings** section:

| Setting | Description |
| --- | --- |
| `serialPort.defaultBaudRate` | Default baud rate for newly-added ports. |
| `serialPort.defaultDataBits` | Default data bits (5/6/7/8). |
| `serialPort.defaultParity` | Default parity (none/even/odd/mark/space). |
| `serialPort.defaultStopBits` | Default stop bits (1/1.5/2). |
| `serialPort.defaultHexSend` / `defaultHexRecv` | Default hex mode for send/receive. |
| `serialPort.defaultLineEnding` | Terminator appended to ASCII sends: `none`/`lf`/`cr`/`crlf` (default `crlf`). |
| `serialPort.defaultDeviceConsole` | Start new sessions with Device Console on (keystrokes go straight to the device). |
| `serialPort.defaultShowTimestamp` / `compactTimestamps` | Show timestamps, and whether to render them as time-of-day only instead of month-day-and-time. |
| `serialPort.detectSeverity` | Recognize device log-level prefixes on received lines and color/label them accordingly. |
| `serialPort.logFormat` | `annotated` (readable, highlighted) or `raw` (byte-exact capture). |
| `serialPort.messageGapMs` | Quiet time after which an unterminated line (a prompt) is surfaced anyway. |
| `serialPort.saveLogAt` | Folder for session log files. Supports the `${workspaceFolder}` token. |
| `serialPort.txColor` / `serialPort.rxColor` | Colors (CSS hex) for sent/received bytes, in the terminal and in an open log. |
| `serialPort.severityColors` | Per-level colors (CSS hex) for the terminal row and, in an open log, the level token and payload. `""` turns a level's override off. |
| `serialPort.sendTemplates` | Reusable send templates (usually managed via the panel UI). |

## Requirements

None beyond VS Code itself — the native serial bindings ship inside the
extension.

## Known limitations

- RTS/DTR and reset-on-connect behavior varies by board; if your board
  resets unexpectedly on open, check its RTS/DTR wiring.
- In line-editing mode the terminal deliberately drops the device's
  cursor-movement and screen-erase escapes (it keeps only color), so the
  pinned input row and the timestamp columns stay intact. Turn on **Device
  Console** for a device that needs full cursor control.
- Colouring a log line's payload from the TX/RX and level colours paints over
  the finer-grained syntax colouring inside it, so the ESP-IDF/Zephyr tag
  prefixes, quoted strings and stack frames the grammar scopes are visible only
  where no payload colour applies (a level set to `""`, or a `txColor`/`rxColor`
  cleared to an empty string).

## License

MIT — see [LICENSE](LICENSE).

---

## Development

```bash
npm install
npm run watch     # incremental esbuild build
```

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded — the **Serial Port** icon appears in the Activity Bar.

```bash
npm run lint       # eslint
npm test           # compiles + runs the extension test suite
npm run package    # production bundle (dist/extension.js)
```

Packaged with [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce).
Never commit a Marketplace personal access token; pass it via the
`VSCE_PAT` environment variable to `vsce publish` instead.
