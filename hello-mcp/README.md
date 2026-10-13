# hello-mcp

A minimal MCP (Model Context Protocol) server with one trivial tool, `ping`. It is the first step of the AI track: learn how MCP servers work before building the Sui wallet tools on top.

Part of the capstone project: an AI-powered wallet for the Sui blockchain.

## What it does

The server exposes one tool to an MCP client (such as a Claude CLI client):

| Tool | Input | Output |
|---|---|---|
| `ping` | `name` (string) | A greeting confirming the server works |

The client starts the server as a background process and talks to it over stdio (standard input/output).

## Requirements

- Node.js 20 or higher (`node --version`)
- npm (`npm --version`)

## Setup

```powershell
git clone <repo-url>
cd hello-mcp
npm install
npm run build
```

## Run

```powershell
node build/index.js
```

Expected output:

```
Hello MCP server running on stdio
```

The server then waits silently for a client. That is correct. Stop it with Ctrl+C.

## Use with Claude Code (team setup)

The repo includes a `.mcp.json` that registers this server with Claude Code. Each teammate uses their own Claude account; nothing is shared except the code.

1. Run the setup steps above (`npm install`, `npm run build`).
2. Start Claude Code from the repo root: `claude`. The path in `.mcp.json` is relative to that folder.
3. Approve the `hello` server when prompted.
4. Run `/mcp` to confirm it is connected, then ask Claude to ping the server.

## Project structure

```
hello-mcp/
  .mcp.json         Registers the server with Claude Code (shared with the team)
  src/index.ts      Server code (source)
  build/index.js    Compiled output (generated, not committed)
  package.json      Dependencies and scripts ("type": "module")
  tsconfig.json     TypeScript settings
```

## Key rules for stdio servers

- **Never write to stdout.** Do not use `console.log()`. Stdout carries the protocol messages, and printing to it breaks the server. Use `console.error()` (stderr) for logging.
- **Rebuild after every change.** Clients run `build/index.js`, not the TypeScript source. Run `npm run build` after editing `src/index.ts`.
- **Use absolute paths** when registering the server with a client.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Cannot find module '@modelcontextprotocol/server'` | Dependencies not installed. Run `npm install`. |
| Error mentioning `import` or `require` | `"type": "module"` is missing from `package.json`. |
| No `build` folder | Run `npm run build`. Check that `tsconfig.json` is in the project root. |
| Server starts but client cannot connect | Used `console.log`, forgot to rebuild, or used a relative path. |
| Works in terminal, fails in client | Wrong path, or `node` not found. Use the full path from `where node`. |

## Notes: what makes a good tool description

_To fill in as we experiment. Ideas to test:_

- Does the AI still pick `ping` if the description is vague (e.g. "does a thing")?
- Does a clear description change how reliably the tool is called?
- What happens with a missing or badly described input?

## Next steps

- Connect this server to a CLI client (next sub-issue)
- Agree the interface with the blockchain track
- Replace `ping` with real Sui tools (`get_balance`, `simulate_transfer`, ...)

## References

- MCP "Build an MCP server" tutorial: https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server
