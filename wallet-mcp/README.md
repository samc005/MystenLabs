# wallet-mcp

Local MCP tools for a Sui testnet wallet. The server exposes wallet inspection,
chain discovery, simulation, and explicitly mutating testnet actions to an MCP
client such as the `demo-ui` Cipher chat.

Testnet coins have no value. Signing happens locally with the key in
`.wallet/sender.json`; the file is gitignored and written with mode `0600`.
Never pass a secret key as a tool argument or commit one to the repository.

## Requirements

- Node.js 22 or newer
- npm
- A Sui testnet wallet created by `npm run setup` for signing tools

## Setup

```powershell
cd wallet-mcp
npm install
npm run setup
npm run build
```

`npm run setup` creates the sender wallet if needed and requests testnet SUI
when its balance is zero. Faucet proof-of-work can take a few minutes. If the
faucet rate-limits the request, wait and retry or use
https://faucet.sui.io.

## Commands

```powershell
npm run balance
npm run balance -- 0xYourAddress
npm run transfer -- 0xRecipient 0.01
npm run demo
npm run build
npm run typecheck
```

`npm run demo` creates a receiver wallet when needed, funds the sender, and
sends `0.01` testnet SUI to the receiver.

## MCP server

Build the server before starting an MCP client:

```powershell
npm run build
```

`.mcp.json` registers the server as `wallet`:

```json
{
  "mcpServers": {
    "wallet": {
      "type": "stdio",
      "command": "node",
      "args": ["build/index.js"]
    }
  }
}
```

The server writes logs to stderr. stdout is reserved for the MCP protocol.
The active network defaults to `testnet`; `SUI_NETWORK` may select another
network for read-only operations. Signing is always restricted to testnet.

## Tool reference

All amounts are decimal strings unless stated otherwise. Addresses and object
IDs must be valid Sui values. Limits are capped by the tool schemas to avoid
unbounded network requests.

### Wallet and balance tools

| Tool | Inputs | Behavior |
|---|---|---|
| `get_address` | none | Returns the local sender wallet address. Read-only. |
| `get_balance` | `address` optional | Reads all token balances. Omitting `address` uses the local sender wallet. Read-only. |
| `list_coins` | `address`, `coinType`, `limit` optional | Lists individual coin objects, balances, and IDs. Read-only. |
| `list_owned_objects` | `address`, `type`, `limit` optional | Lists objects owned by an address, with JSON and display data when available. Read-only. |

### Object and Move inspection tools

| Tool | Inputs | Behavior |
|---|---|---|
| `get_object` | `objectId` | Reads complete object metadata, content, display data, and previous transaction. Read-only. |
| `get_objects` | `objectIds` | Reads multiple objects in one request. Read-only. |
| `get_nft` | `objectId` | Reads an object's type, display metadata, and JSON content. Read-only. |
| `list_dynamic_fields` | `parentId`, `limit`, `includeValue` optional | Lists dynamic fields attached to an object. Read-only. |
| `get_dynamic_field` | `parentId`, `nameType`, `nameBcsBase64` | Reads a dynamic field value using its BCS-encoded name. Read-only. |
| `get_dynamic_object_field` | `parentId`, `nameType`, `nameBcsBase64` | Reads a child object stored in a dynamic object field. Read-only. |
| `get_coin_metadata` | `coinType` | Reads coin name, symbol, decimals, description, and icon URL. Read-only. |
| `get_move_function` | `packageId`, `moduleName`, `functionName` | Reads a Move function's visibility, entry status, parameters, and returns. Read-only. |

### Transaction, event, and network tools

| Tool | Inputs | Behavior |
|---|---|---|
| `get_transaction` | `digest` | Reads transaction status, effects, events, balance changes, and transaction data. Read-only. |
| `list_transactions` | `address`, `limit` optional | Lists recent transactions sent by an address. Read-only. |
| `list_events` | one of `sender`, `eventType`, `emitModule`; `limit`, `order` optional | Queries recent on-chain events. Read-only. |
| `estimate_gas` | `transactionBase64` | Simulates serialized transaction bytes without signing or submitting. Read-only. |
| `get_chain_info` | none | Reads chain identity, protocol configuration, system state, and reference gas price. Read-only. |
| `resolve_name` | exactly one of `name` or `address` | Resolves a SuiNS name to an address or an address to its default name. Read-only. |
| `resolve_mvr` | `packages` or `types` | Resolves Move Registry package and type names. Read-only. |
| `wait_for_transaction` | `digest`, `timeoutMs` optional | Waits for a transaction to checkpoint and reports its final result. It does not submit a transaction. |

### Testnet write tools

These tools mutate testnet state. They use the local sender key and cannot be
undone. In the Cipher chat, Cipher must explain the action and ask for clear
confirmation in a separate message before calling a write tool.

| Tool | Inputs | Behavior |
|---|---|---|
| `transfer_sui` | `to`, `amount` | Sends SUI from the local sender wallet. Gas is paid automatically and the tool waits for confirmation. |
| `request_faucet` | none | Requests testnet SUI for the local sender wallet and waits for faucet confirmation. Faucet limits apply. |
| `split_coin` | `coinId`, `amount`, `recipient` optional | Splits a local SUI coin. The new coin stays with the sender unless `recipient` is supplied. |
| `merge_coins` | `primaryCoinId`, `coinIds` | Merges local SUI coin objects into the primary coin. |

Write tools intentionally do not expose secret keys. Token transfers other than
SUI, staking, unstaking, arbitrary Move calls, and generic serialized
transaction submission are not enabled in this milestone.

## Local Cipher web UI

The repository's `demo-ui` app is the intended frontend. Start it from the
repository root in a second terminal:

```powershell
cd demo-ui
npm install
npm run dev
```

Open http://127.0.0.1:3000/chat. The UI starts `wallet-mcp/build/index.js`
over stdio and discovers the registered tools dynamically. Build wallet-mcp
first whenever its TypeScript changes.

For Claude API access, create `demo-ui/.env.local`:

```text
ANTHROPIC_API_KEY=your-key-here
```

Keep the key server-side. Do not put it in browser JavaScript, `.mcp.json`, a
tracked README, or a commit.

The optional `wallet-mcp` web prototype can be started with `npm run web`, but
it is not the `demo-ui` frontend used by the `testdemo-ui` branch.

## Security boundary

This is a local testnet experiment, not a production wallet. The current
implementation signs in the MCP process with a local Ed25519 key. Signing is
restricted to testnet, and the UI confirmation prompt is conversational rather
than a hardware-backed approval boundary.

Not implemented yet: a separate signer process, policy limits, passkeys,
hardware-wallet approval, production secret storage, arbitrary Move call
authorization, token transfer policies, staking policies, and a production
transaction approval workflow.

See [docs/DESIGN.md](../docs/DESIGN.md) for the architecture and roadmap.
