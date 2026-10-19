# demo-ui

A browser demo of what `wallet-mcp` does today: create a Sui testnet wallet, fund it from the faucet, read balances, and send SUI. Every action is also shown as the MCP tool call (`get_balance`, `transfer_sui`) and the exact text an AI model would get back.

Testnet only. Coins have no value.

## How it works

- Everything runs in the browser. There is no backend and no secret to configure.
- Two keypairs (sender and receiver) are generated in the page and kept in `localStorage`, like `.wallet/sender.json` and `.wallet/receiver.json` in `wallet-mcp`.
- [lib/sui.ts](lib/sui.ts) is a browser port of `wallet-mcp/src/blockchain`: the same SDK calls and the same tool output text, without the Node-only file code.
- Funding goes through https://faucet.sui.io. The page copies the address, opens the faucet, and polls until the SUI arrives. The faucet's proof-of-work takes minutes even in native Node, so it is not run in the page.

## Run locally

Requires Node.js 20.9 or newer.

```bash
cd demo-ui
npm install
npm run dev        # http://localhost:3000
```

`npm run build` checks types and builds the production version.

## Deploy to Vercel

1. In Vercel, choose **Add New → Project** and import this GitHub repo.
2. Set **Root Directory** to `demo-ui`. Vercel detects Next.js; keep the default build settings.
3. Deploy. No environment variables are needed.

Or from the terminal: `cd demo-ui && npx vercel`.

## Limits

- Signing happens in the page, with no policy check. That matches `wallet-mcp` today and is phase 2 in [docs/DESIGN.md](../docs/DESIGN.md).
- Clearing site data deletes the keys. Any testnet SUI on them is lost, which only costs a trip to the faucet.
- No AI model is connected. The tool-call panel shows what a model would send and receive.
