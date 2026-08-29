# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`vscode-serial-port`) implementing a full-featured serial
port tool: live monitoring, send/receive in hex or ASCII, RTS/DTR control,
multiple ports open in parallel, log-to-file, and reusable send templates.
Currently the repo only contains the dev-environment scaffold (build/lint/test
tooling + a placeholder command) — feature work has not started yet.

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

There is currently one source file (`src/extension.ts`) and one test file
(`src/test/extension.test.ts`), so "run a single test" just means running
`npm test` — there's nothing yet to filter down to.

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

Serial I/O (not yet implemented) is planned to use the `serialport` npm
package (prebuilt native bindings for win32/darwin/linux, x64+arm64) so
packaging never requires a native build toolchain on the user's machine.

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
& "E:\nodejs\node.exe" "d:\serialPort\esbuild.js"
& "E:\nodejs\node.exe" "d:\serialPort\node_modules\eslint\bin\eslint.js" src
& "E:\nodejs\node.exe" "d:\serialPort\node_modules\typescript\lib\tsc.js" -p . --outDir out
```

and for `npm install`, use `--ignore-scripts` then manually run the
individual package's install script the same way (e.g.
`node node_modules/esbuild/install.js`) if a dependency needs one.
