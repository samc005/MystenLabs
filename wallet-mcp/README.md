# wallet-mcp

The first slice of the Sui wallet: a testnet address, faucet SUI, balance queries, a small transfer, and read-only chain inspection. An MCP server exposes these actions so an AI client can call them.

Testnet coins are worthless. The secret key is written to `.wallet/sender.json` (mode `0600`) and is gitignored. This milestone signs inside the process. The full architecture, security stages, and roadmap are in [docs/DESIGN.md](../docs/DESIGN.md).

## Layout

```
src/index.ts                 MCP entry (stdio)
src/config.ts                Network, wallet path, explorer links
src/mcp/server.ts            Registers tools
src/mcp/tools/getAddress.ts  Read the local wallet address
src/mcp/tools/getBalance.ts  Read balances
src/mcp/tools/getTransaction.ts  Read transaction details
src/mcp/tools/listTransactions.ts  List recent transactions
src/mcp/tools/getCoinMetadata.ts  Read coin metadata
src/mcp/tools/listOwnedObjects.ts  List owned objects
src/mcp/tools/getNft.ts       Read object/NFT metadata
src/mcp/tools/estimateGas.ts  Simulate serialized transactions
src/mcp/tools/transfer.ts    Send testnet SUI
src/blockchain/client.ts     Sui gRPC client
src/blockchain/balance.ts    Address balances
src/blockchain/faucet.ts     Testnet faucet
src/blockchain/transfer.ts   coinWithBalance transfer
src/blockchain/wallet.ts     Local key file
```

## Setup

Requires Node.js 22 or newer (Node 24.7+ uses native Argon2 for the faucet).

```bash
cd wallet-mcp
npm install
npm run setup
```

`npm run setup` creates the sender wallet if needed, requests testnet SUI when the balance is 0, and prints the address. The faucet runs a proof-of-work and can take a minute. If it rate-limits you, wait and retry, or use https://faucet.sui.io with the printed address.

## Commands

```bash
npm run balance                         # local wallet
npm run balance -- 0xYourAddress        # any address
npm run transfer -- 0xRecipient 0.01    # send 0.01 SUI
npm run demo                            # fund sender, send 0.01 SUI to a second local address
```

Confirm the transfer on the explorer link the command prints (Suiscan, testnet).

## MCP

```bash
npm run build
```

`.mcp.json` registers the server as `wallet`. Start the client from this folder so `build/index.js` resolves. The server logs to stderr only; stdout is the protocol.

| Tool | Input | What it does |
|---|---|---|
| `get_address` | none | Returns the local wallet address. |
| `get_balance` | `address` optional | Reads balances from the chain. Omit `address` to use the local wallet. |
| `get_transaction` | `digest` | Reads transaction status, effects, events, and balance changes. |
| `list_transactions` | `address`, `limit` optional | Lists recent transactions sent by an address. |
| `get_coin_metadata` | `coinType` | Reads token name, symbol, decimals, and icon metadata. |
| `list_owned_objects` | `address`, `type`, `limit` optional | Lists objects owned by an address. |
| `get_nft` | `objectId` | Reads an object’s type and display metadata. |
| `estimate_gas` | `transactionBase64` | Simulates serialized transaction bytes without signing or submitting. |
| `transfer_sui` | `to`, `amount` | Sends testnet SUI. `amount` is a decimal string such as `"0.01"`. |

`transfer_sui` does not take a secret key. Run `npm run setup` before using the tools.

## Authorization boundary

The read-only tools above do not sign or submit transactions. `transfer_sui` remains the original local-key testnet spike. Token transfers, staking, and unstaking are intentionally not exposed until the Move contract, policy checks, and separate signer/approval layer are in place.

## What this does not do yet

No policy limits, no separate signer process, no simulation summary, no passkey, no Move vault. A transfer from the MCP tool is a real testnet transaction. Those later boundaries are specified in [docs/DESIGN.md](../docs/DESIGN.md).
