# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`vscode-serial-port`) implementing a full-featured serial
port tool: live monitoring, send/receive in hex or ASCII, RTS/DTR control,
multiple ports open in parallel, log-to-file, and reusable send templates.
The Activity Bar panel (port picker, default settings, per-port sessions,
send templates) and the `serialport`-backed I/O are implemented; see
Architecture below for the module layout.

## Commands

```bash
npm install         # install dependencies
npm run watch        # incremental esbuild build (used by the "Run Extension" F5 task)
npm run compile      # one-shot esbuild build -> dist/extension.js
npm run compile-tests # tsc build of src/** (incl. tests) -> out/, needed before npm test
npm run lint          # eslint src
npm test              # compile-tests + compile + lint, then runs the extension test suite via @vscode/test-cli
npm run package       # production esbuild bundle (minified, no sourcemap)
```

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded (this runs the `npm: watch` background task first via
`.vscode/launch.json` / `.vscode/tasks.json`).

There is currently one test file (`src/test/extension.test.ts`), so "run a
single test" just means running `npm test` — there's nothing yet to filter
down to.

## Architecture

**Build split:** the extension entry point is bundled with **esbuild**
(`esbuild.js` → `dist/extension.js`, `vscode` marked external) for fast,
minimal-dependency packaging. Tests are compiled separately with **tsc**
(`tsconfig.json` → `out/`) because `@vscode/test-cli` / `@vscode/test-electron`
load compiled test files directly from disk rather than through the bundle.
Don't merge these two build paths — they serve different consumers.

**`extensionKind: ["ui"]` (in `package.json`) is the load-bearing design
decision for this project.** It forces VS Code to always run this extension
on the machine hosting the UI (i.e. the physical Windows box), even when the
window is connected to a WSL, SSH, or container remote workspace. This is
what lets a user in a WSL-remote window access physical Windows COM ports
with zero manual configuration — there is no hand-rolled IPC/socket bridge.
Because the extension still runs inside the standard VS Code extension API
surface, calls like `vscode.workspace.fs.*` and
`vscode.window.createTerminal`/`Pseudoterminal` are transparently proxied by
VS Code to whatever the actual remote workspace is — so port I/O happens on
Windows while logs/templates/terminal output land in the user's real
workspace (e.g. the WSL filesystem). When implementing the serial connection
manager, log persistence, and terminal/monitor view, rely on these
`vscode.*` APIs rather than Node's raw `fs`/`child_process`, or this
WSL-transparency property breaks.

Serial I/O uses the `serialport` npm package (prebuilt native bindings for
win32/darwin/linux, x64+arm64) so packaging never requires a native build
toolchain on the user's machine. Its native binding can't be bundled by
esbuild, so `serialport` is in esbuild's `external` list and carved back out
of `.vscodeignore`'s `node_modules/**` exclusion — `node_modules/serialport`
and `node_modules/@serialport` must physically ship inside the `.vsix`.

**Module layout** (`src/`):
- `serial/connectionManager.ts` — `PortConnection` (one open port: I/O,
  live baud-rate update, byte counters, hex/ascii + recording toggles, and
  file-based logging while recording) and `ConnectionManager` (the
  open-ports registry, keyed by device path).
- `serial/format.ts` — hex↔bytes conversion and the hex-mode keystroke
  filter, shared by the tree's stats display and the terminal.
- `serial/pseudoterminal.ts` — the interactive per-port terminal: a
  `vscode.Pseudoterminal` that echoes/buffers typed input itself (ptys don't
  echo), rejects non-hex keystrokes while hex-send is on, and sends on
  Enter. The input line is pinned to the terminal's actual bottom row via an
  ANSI scroll region (DECSTBM, `\x1b[<top>;<bottom>r`) confined to rows
  `1..rows-1` — the same mechanism `tmux`'s status line and `htop`'s header
  use. Redrawing the prompt after each write (the original approach) only
  places it just after the last printed line, leaving blank rows below it
  until the screen fills; a real scroll region is what keeps the last row
  pinned to the bottom of the viewport from the start, with incoming/echoed
  text scrolling independently above it.
- `webview/serialPanelProvider.ts` + `media/webview/{main.js, style.css}` —
  the Activity Bar view is a `vscode.WebviewViewProvider`, not a
  `TreeDataProvider`. It was a tree view originally, but `TreeItem` can't
  anchor a dropdown to its own row (`showQuickPick` always opens as a
  floating overlay) or keep inline row buttons visible outside hover/focus —
  both were hard requirements, so the presentation layer moved to a webview
  where a real `<select>` and `<button>` do both for free.
  `serialPanelProvider.ts` builds the nonce/CSP-gated HTML, serializes all
  panel state (ports, selected port, default config, resolved log folder,
  open sessions, templates) via `buildState()`, and pushes it to the webview
  as `{type: 'state', state}` on resolve, on visibility change, on an
  explicit `refreshPorts` message, and (debounced 150ms) whenever
  `ConnectionManager.onDidChange` fires. `media/webview/main.js` is vanilla
  JS with no framework or bundler — it does a full DOM re-render from that
  state on every message and posts action messages back
  (`selectPort`, `openPort`, `closePort`, `refreshPorts`,
  `updateDefaultSetting`, `updateSessionBaudRate`, `setCheckbox`,
  `addTemplate`, `updateTemplate`, `deleteTemplate`, `sendTemplate`,
  `browseLogFolder`, `clearLogFolder`, `openLogFile`); it keeps in-progress
  form edits in local JS state (not the pushed state) so an unrelated push
  (e.g. another port's byte counter) can't clobber them.
- `templates/templateStore.ts` — CRUD for send templates over
  `context.globalState` (global, not workspace-scoped).

Recording a session's traffic writes to an auto-named log file
(`<port>_<ISO timestamp>.log`, one full ISO-8601 date-time per line) via
debounced `vscode.workspace.fs.writeFile` calls in `PortConnection` — never
raw Node `fs`, to preserve the WSL-transparency property described above.
There's no `OutputChannel` view for this anymore: the terminal already
shows the same live TX/RX traffic, so a second live view would be
redundant. The destination folder defaults to `<workspace root>/serial
logs` (auto-created via `vscode.workspace.fs.createDirectory`), falling
back to the extension's `context.globalStorageUri` when no workspace
folder is open; a custom "Log Folder" override (persisted in
`context.globalState`, browsed via `vscode.window.showOpenDialog`) takes
priority over that default when set. Turning Record off flushes and keeps
the file path around (rather than clearing it) so the panel can still show
and open the completed log — each session card has an icon button that
opens its current log file via `vscode.window.showTextDocument`.

## Publishing

`publisher` in `package.json` is a placeholder (`REPLACE_ME_PUBLISHER_ID`) —
must be set to a real Marketplace publisher id before packaging/publishing.
Never commit a Marketplace token; `vsce publish` reads it from the `VSCE_PAT`
env var.

## Sandbox note (this agent host only)

In this Claude Code sandbox specifically, nested child processes (e.g. npm's
internal `cmd.exe /d /s /c node ...` lifecycle/script runner) fail to resolve
bare command names like `node` via `PATH`, even though `$env:Path` displays
the right directories — `where.exe` reproduces the same failure. This is a
property of this sandboxed shell, not of a real dev machine or CI. If
`npm run <script>` or `npm install` (with lifecycle scripts) mysteriously
fails with "'node' is not recognized" in this environment, invoke the
underlying tool directly instead, e.g.:

```powershell
Start-Process -FilePath "E:\nodejs\node.exe" -ArgumentList 'd:\serialPort\esbuild.js' -NoNewWindow -Wait -PassThru -RedirectStandardOutput out.log -RedirectStandardError err.log
```

Direct `&`-invocation of a native exe (e.g. `& "E:\nodejs\node.exe" ...`) also
silently produces no captured output in this shell, even though the process
runs — always go through `Start-Process ... -RedirectStandardOutput/-RedirectStandardError`
and read the redirected files back, for any native executable, not just for
lifecycle-script cases.

and for `npm install`, use `--ignore-scripts` then manually run the
individual package's install script the same way (e.g.
`node node_modules/esbuild/install.js`) if a dependency needs one.

This generalizes beyond Node: any native executable in this sandbox (e.g.
`git.exe`) silently produces no captured output via plain invocation or
even PowerShell variable capture (`$out = & ...`) — the `Start-Process
-RedirectStandardOutput/-RedirectStandardError` pattern above is required
for all of them, not just Node/npm.
