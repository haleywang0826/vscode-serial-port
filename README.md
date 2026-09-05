# Serial Port for VSCode

A full-featured serial port tool built right into VS Code: monitor a port's
output live, send and receive data as hex or ASCII, toggle RTS/DTR, run
multiple ports in parallel, log sessions to file, and save/reuse send
templates — all from the Activity Bar, without leaving your editor.

## Features

- **Live per-port terminal** — an interactive terminal for each open port,
  color-coded by TX/RX direction, with optional timestamps. Device ANSI
  colors (including ESP-IDF output) are supported across serial reads.
- **Hex or ASCII**, independently for send and receive.
- **Multiple ports open in parallel**, each with its own session card:
  live config, byte counters, and controls.
- **RTS/DTR control** per port — handy for boards that reset on a DTR/RTS
  edge (e.g. Arduino, ESP8266/ESP32).
- **Session logging to file** — record a port's traffic to a timestamped
  log file in your workspace (or wherever `serialPort.saveLogAt` points).
  Optional readable logs preserve UTF-8 device lines, remove ANSI codes,
  and add ESP-IDF severity markers for VS Code's Log highlighting.
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
| `serialPort.saveLogAt` | Folder for session log files. Supports the `${workspaceFolder}` token. |
| `serialPort.logFormat` | `traffic` (default): existing traffic records; `readable`: UTF-8 device lines without ANSI, with ESP-IDF severity markers. Applies when starting a recording; reopening an active recording retains its format. |
| `serialPort.txColor` / `serialPort.rxColor` | Terminal colors (CSS hex) for sent/received bytes. |
| `serialPort.sendTemplates` | Reusable send templates (usually managed via the panel UI). |

## Embedded device logs

### ANSI colors in the terminal

The terminal accepts ANSI SGR sequences from a device in ASCII receive
mode: basic/bright colors, 256-color and RGB colors, and text attributes.
For example, firmware can send `\x1b[31merror\x1b[0m` (where `\x1b` is
the actual byte `0x1B`, not four literal characters).
ESP-IDF can emit these codes when its firmware log-color option is enabled.
See the [ESP-IDF logging documentation](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/log.html).

Device colors override the configured RX color and persist between reads,
even when TX traffic is interleaved. A device reset (`ESC[0m`) restores the
terminal's default style. Terminal-generated timestamps and the input
prompt remain separate from device styling. Hex receive shows the escape
bytes literally. Cursor-moving CSI commands are discarded to protect the
pinned input line; this is a log monitor, not a full interactive device shell.

### Readable recordings and editor highlighting

Set this in VS Code Settings, then start recording (restart an active
recording to apply it):

```json
{
  "serialPort.logFormat": "readable"
}
```

Readable recordings join fragments of a device line across serial reads,
preserve UTF-8, treat CRLF/LF/CR as line endings, and strip ANSI controls.
Each line has a host timestamp and TX/RX direction. ESP-IDF's
`E/W/I/D/V (ticks) tag: message` format gets an additional
`[ERROR]` / `[WARN]` / `[INFO]` / `[DEBUG]` / `[TRACE]` marker, without
removing the device's original text. For example:

```log
[2026-09-05T16:20:32.280+08:00 ASCII RX] [INFO] I (123) wifi: connected
[2026-09-05T16:20:33.010+08:00 ASCII RX] [ERROR] E (853) sensor: timeout
```

The markers are ordinary text, not escape codes. VS Code's built-in **Log**
language highlights severity markers, timestamps and numeric/hex values
using the active theme. If needed, select **Log** from the editor's language
mode picker. No custom file association or additional extension is required.
Firmware using other log formats can emit `[INFO]`, `[WARN]` or `[ERROR]`
directly, too. A color alone is not interpreted as a severity.

The host timestamp belongs to the first fragment of each line; device
uptime remains in the original text. Headers use the shared
`serialPort.compactTimestamps` setting (enabled by default; the examples
above show the full form with that setting disabled).
RX and TX assemble independently, so
records appear in line-completion order, not necessarily timestamp order.
Completed lines use the existing approximately 300 ms write timer. Partial
lines wait for a terminator, stopping/restarting recording, closing the
port, or changing that direction's hex mode. Lines longer than 16,384
UTF-16 code units split into bounded records marked ` [continued]`, keeping
the original timestamp and severity. Incomplete UTF-8 at finalization is
replaced by the Unicode replacement character; unfinished ANSI controls
are discarded.

Readable mode starts with traffic received after recording is enabled; it
does not import the preformatted traffic-history buffer. Reopening a port
with recording still enabled retains the file and the selected log format.

The default `traffic` mode retains the base branch's behavior: UTF-8 text,
normalized line endings, captured hex/text mode, shared headers, and RX
message grouping controlled by `serialPort.messageGapMs`. Hex logging is
unchanged in both modes. Neither text format is a byte-exact capture; use
hex mode when investigating protocol bytes.

Editor alternatives:

- [Built-in Log grammar](https://github.com/microsoft/vscode/tree/main/extensions/log):
  sufficient for the readable format; highlights tokens, not ANSI colors.
- [Log File Highlighter](https://marketplace.visualstudio.com/items?itemName=emilast.LogFileHighlighter):
  optional customizable patterns and timestamp-duration visualization beyond
  the built-in grammar.
- [ANSI Colors](https://marketplace.visualstudio.com/items?itemName=iliazeus.vscode-ansi):
  `ANSI Text` language and preview for files containing actual ANSI escapes.
  Useful for traffic recordings or external captures containing ANSI codes;
  this extension's readable recordings deliberately remove those escapes.

### Further embedded-debugging improvements

These are candidates, **not implemented features**:

| Priority | Improvement | Benefit / considerations |
| --- | --- | --- |
| High | Streaming line-oriented terminal view | Build on existing UTF-8 rendering and gap-based RX grouping to preserve characters and firmware lines across message boundaries; retain a separate byte/hex view. |
| High | Level/tag/regex filtering and pause/resume | Reduce noisy telemetry while continuing full recording; use a bounded display buffer and make dropped-display counts visible. |
| High | ESP32 panic/backtrace decoding and source links | Resolve addresses with the matching firmware ELF and Xtensa/RISC-V `addr2line`; requires explicit toolchain/ELF selection and workspace trust before running tools. |
| High | Reconnect and reset/bootloader profiles | Recover after USB re-enumeration; use USB identity where available and opt-in board-specific RTS/DTR sequences to avoid unexpected resets. |
| Medium | Send line endings and raw-key mode | Support LF/CRLF commands, control keys and device shells without changing existing byte-exact sends by default. |
| Medium | Raw binary capture, replay and export | Preserve exact traffic and timing for protocol analysis, independently of the human-readable log format. |
| Medium | Time deltas, bookmarks and crash triggers | Correlate host time with device uptime; mark watchdog, brownout and panic events and save surrounding context. |
| Medium | Structured telemetry and protocol decoders | Optional JSON/CSV plotting and packet/checksum views without changing raw recording. |

[ESP-IDF Monitor](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/tools/idf-monitor.html)
already provides ESP-specific address decoding, reset sequences and GDBStub
integration. Integrating or handing off to those tools is preferable to
duplicating a debugger inside this generic serial monitor.

## Requirements

None beyond VS Code itself — the native serial bindings ship inside the
extension.

## Known limitations

- RTS/DTR and reset-on-connect behavior varies by board; if your board
  resets unexpectedly on open, check its RTS/DTR wiring.

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
