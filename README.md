# Serial Port for VSCode

A full-featured serial port tool built right into VS Code: monitor a port's
output live, send and receive data as hex or ASCII, toggle RTS/DTR, run
multiple ports in parallel, log sessions to file, and save/reuse send
templates — all from the Activity Bar, without leaving your editor.

## Features

- **Live per-port terminal** — an interactive terminal for each open port,
  color-coded by TX/RX direction, with optional timestamps.
- **Hex or ASCII**, independently for send and receive.
- **Multiple ports open in parallel**, each with its own session card:
  live config, byte counters, and controls.
- **RTS/DTR control** per port — handy for boards that reset on a DTR/RTS
  edge (e.g. Arduino, ESP8266/ESP32).
- **Session logging to file** — record a port's traffic to a timestamped
  log file in your workspace (or wherever `serialPort.saveLogAt` points).
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
| `serialPort.txColor` / `serialPort.rxColor` | Terminal colors (CSS hex) for sent/received bytes. |
| `serialPort.sendTemplates` | Reusable send templates (usually managed via the panel UI). |

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
