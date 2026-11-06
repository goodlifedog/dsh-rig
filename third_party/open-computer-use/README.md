# open-computer-use

Cross-platform npm distribution for the open-source **Open Computer Use** MCP server.

This package bundles native runtimes for these supported platforms and lets the Node launcher choose the current `process.platform` / `process.arch` pair:

- `darwin-arm64`
- `darwin-x64`
- `linux-arm64`
- `linux-x64`
- `win32-arm64`
- `win32-x64`

Global command aliases:

- `open-computer-use`
- `ocu`
- `open-computer-use-mcp`
- `open-codex-computer-use-mcp`

## Install

```bash
npm install -g open-computer-use
```

The root launcher resolves the current `process.platform` / `process.arch` pair and runs the matching bundled native runtime.

## MCP config

If your MCP client accepts a stdio-style `mcpServers` JSON config, this is the default setup:

```json
{
  "mcpServers": {
    "open-computer-use": {
      "command": "open-computer-use",
      "args": ["mcp"]
    }
  }
}
```

Package page: https://www.npmjs.com/package/open-computer-use

## Use

```bash
open-computer-use --version
ocu --version
open-computer-use --help
open-computer-use mcp
ocu mcp
ocu capabilities
ocu capabilities --json
ocu js 'nodeRepl.write(6 * 7)'
printf 'var answer = 40
answer += 2; nodeRepl.write(answer)
.exit
' | ocu repl
open-computer-use call list_apps

# macOS permission check and onboarding
open-computer-use doctor

# Installer helpers for MCP-capable CLIs
open-computer-use install-claude-mcp
open-computer-use install-gemini-mcp
open-computer-use install-gemini-mcp --scope user
open-computer-use install-codex-mcp
open-computer-use install-opencode-mcp
open-computer-use install-codex-plugin
```

## Notes

- Version: `1.1.3`
- Supported npm platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`
- `ocu js` creates a one-shot JavaScript/native session; `ocu repl` keeps one session for the current terminal and preserves bindings between evaluations.
- Both code-first commands use the Node executable that started the npm launcher. The npm launcher itself still requires Node.js 18 or newer to be available when the command starts.
- `ocu mcp` intentionally continues to expose the native 9-tool compatibility surface; the Codex plugin adapter exposes `js` / `js_reset` separately.
- macOS still requires `Accessibility` and `Screen Recording` permissions.
- Linux requires a signed-in desktop session with AT-SPI2 / D-Bus accessibility available for real app control.
- Windows requires a signed-in desktop session for UI Automation access.

Source repository: https://github.com/iFurySt/open-computer-use
