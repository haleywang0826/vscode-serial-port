# Serial Port for VS Code

A full-featured serial port tool built as a VS Code extension: monitor a port's
output live, send and receive data as hex or ASCII, toggle RTS/DTR, run
multiple ports in parallel, save logs to file, and save/reuse send templates.

## Why this extension

Most serial tools are standalone desktop apps. This one lives inside VS Code,
so serial monitoring sits next to the code/firmware you're actually working
on, and its output/logs are just files in your workspace.

## WSL support

If your VS Code window is connected to a WSL remote workspace, this extension
still talks to physical Windows COM ports with **no manual configuration**.
It declares `extensionKind: ["ui"]`, so VS Code always runs it on the machine
hosting the UI (Windows), while workspace-facing APIs (`vscode.workspace.fs`,
integrated terminals) are transparently proxied to the actual WSL workspace.
Practically: the port I/O happens on Windows, and your logs/templates land in
the WSL filesystem you're working in.

## Status

The Activity Bar panel is implemented: pick and open ports, configure
defaults, run multiple ports in parallel with a live session view (config,
byte counters, hex send/recv toggles, recording), an interactive terminal per
open port, and reusable send templates.

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

## Publishing

Packaged with [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce).
The `publisher` field in `package.json` is a placeholder — set it to a real
Marketplace publisher id before packaging/publishing. Never commit a
Marketplace personal access token; pass it via the `VSCE_PAT` environment
variable to `vsce publish` instead.

## License

MIT — see [LICENSE](LICENSE).
