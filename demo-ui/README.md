# demo-ui

Two demos of the Sui testnet wallet. Testnet coins have no value.

| Demo | Route | Runs where | What it shows |
|---|---|---|---|
| Browser wallet | `/browser-wallet` | Anywhere, including Vercel | Create a wallet in the page, fund it, send SUI, and see each action as the MCP tool call an AI would make. |
| Chat with Cipher | `/chat` | Your machine only | Type a request. Cipher, an assistant powered by Claude, calls `get_balance` and `transfer_sui` on the real `wallet-mcp` server, using the wallets its npm scripts created, and the balances update live. |

## Run locally

Requires Node.js 20.9 or newer.

```bash
cd demo-ui
npm install
npm run dev        # http://localhost:3000
```

`npm run build` checks types and builds the production version. The server binds to 127.0.0.1, so it is not reachable from other machines.

## Browser wallet

- Everything runs in the browser. There is no backend and no secret.
- Two keypairs (sender and receiver) are generated in the page and kept in `localStorage`.
- [lib/sui.ts](lib/sui.ts) is a browser port of `wallet-mcp/src/blockchain`: the same SDK calls and the same tool output text.
- Funding goes through https://faucet.sui.io. The faucet's proof-of-work takes minutes even in native Node, so the page does not run it. It copies the address, opens the faucet, and polls until the SUI arrives.

## Chat with Cipher

```
Browser ──▶ /api/chat ──▶ Claude (Messages API, your key)
                │                 │ tool_use
                ▼                 ▼
         wallet-mcp MCP server (stdio, build/index.js) ──▶ Sui testnet
                │
          wallet-mcp/.wallet/sender.json, receiver.json
```

1. Put your key in `demo-ui/.env.local` (gitignored):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
2. Start the app and open `/chat`. The panel shows a checklist. Use its buttons for anything missing:
   - `npm install` and `npm run build` prepare `wallet-mcp`.
   - `npm run setup` creates and funds the sender (the faucet can take a few minutes).
   - `npm run demo` creates the receiver and sends it 0.01 SUI.
3. Ask Cipher things like "What's my balance?" or "Send 0.02 SUI to the receiver".

How it works:

- [lib/server/agent.ts](lib/server/agent.ts) starts `wallet-mcp` over stdio, lists its tools, and passes them to Claude (`claude-opus-5-5`, low effort). Every `tool_use` is executed with the MCP client's `callTool`, so the tool code, input validation, and output are exactly what Claude Code gets from `.mcp.json`.
- The page streams Cipher's text and each tool call and result, and refreshes balances after every tool result.
- [app/api/scripts/route.ts](app/api/scripts/route.ts) runs only a fixed list of `wallet-mcp` npm scripts, one at a time.
- [lib/server/local-only.ts](lib/server/local-only.ts) refuses any request that is not to localhost, from a localhost page, with a JSON body. On Vercel the chat routes always refuse, so a deploy never spends your key.

`transfer_sui` signs inside the `wallet-mcp` process with no policy check yet. That is phase 2 in [docs/DESIGN.md](../docs/DESIGN.md).

## Deploy to Vercel

1. In Vercel, choose **Add New → Project** and import this GitHub repo.
2. Set **Root Directory** to `demo-ui`. Keep the default Next.js settings.
3. Deploy. No environment variables are needed. Only the browser wallet works there; the chat page explains that it is local only.
