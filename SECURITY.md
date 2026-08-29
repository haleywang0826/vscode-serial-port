# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability"
flow (Security tab → Report a vulnerability) on this repository, rather than
opening a public issue. Include steps to reproduce and, if relevant, the
platform (Windows/macOS/Linux/WSL) and VS Code version.

## Scope and design notes

- This extension talks to local serial devices only; it does not make network
  requests on its own.
- It runs with `extensionKind: ["ui"]`, meaning it always executes on the
  machine hosting the VS Code UI (not inside a remote/WSL/container extension
  host), since that's where physical serial hardware is attached.
- Send templates and logs are plain files written through the standard VS
  Code workspace file APIs; treat them like any other workspace file.
