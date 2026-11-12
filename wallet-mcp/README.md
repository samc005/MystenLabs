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

### Spending vault tools

The agent should hold only enough SUI for gas and spend through `vault_spend`.
The contract enforces the per-spend limit, pause, and revocation.

| Tool | Inputs | Behavior |
|---|---|---|
| `vault_status` | none | Reads vault balance, per-spend limit, total spent, paused flag, staking allowlist and positions, and other coins the vault may hold or holds. |
| `vault_spend` | `to`, `amount`, `dryRun` optional | Pays from the vault under its on-chain rules. |
| `vault_stake` | `validator`, `amount`, `dryRun` optional | Stakes vault funds with a validator the owner allowed. The receipt stays in the vault. |
| `list_validators` | `limit` optional | Read-only list of active validators (commission, stake, voting power) and which are allowed. |

### Trading tools (owner-approved swaps)

The agent can never trade on its own. The owner moves funds into a **trading
sleeve** and approves each trade on-chain as an **intent**: sell exactly `X` of coin
A for at least `Y` of coin B before a deadline. The agent can only run an approved
intent, once, and chooses only the route.

| Tool | Inputs | Behavior |
|---|---|---|
| `swap_quote` | `sell`, `buy`, `amount` | Read-only price check on the testnet pool. |
| `propose_trade` | `sell`, `buy`, `amount`, `slippageBps` optional | **Does not trade.** Quotes, records the exact terms, and shows the owner an approval card. `min_out` is computed from the live quote, not by the model. |
| `get_proposal` | `proposalId` optional | Status of a proposal, or the recent ones. |
| `vault_intents` | none | Lists on-chain approved trades that have not run yet. |
| `vault_swap` | `proposalId` or `intentId`, `dryRun` optional | Runs an approved trade. Rejected by the contract unless the owner approved it. Proceeds go back into the vault. |

The swap is one atomic transaction: `begin_swap` returns the coins plus a
`SwapTicket` hot potato, the DEX call runs, and `finish_swap` consumes the ticket,
checks the output against the owner's `min_out`, and deposits it into the vault. A
transaction that skips `finish_swap` cannot execute at all.

Owner commands (need the key that holds the `OwnerCap`, read from the Sui CLI
keystore; never reachable from an MCP tool):

```powershell
npm run owner -- status
npm run owner -- allocate 0.3            # move SUI into the trading sleeve
npm run owner -- intent SUI tUSDC 0.1 0.19 10   # approve one trade directly
npm run owner -- proposals               # trades Cipher proposed in chat
npm run owner -- approve prop_xxxxxxxxxx # what the UI's Approve button runs
npm run owner -- cancel 0xIntentId
npm run owner -- allow-validator 0x...   # also: disallow-validator, unstake
npm run owner -- pool-price 3.0          # move the testnet mock pool's price
npm run vault -- quote SUI tUSDC 1
npm run vault -- swap prop_xxxxxxxxxx --dry-run
npm run boundaries -- --live-intent      # attack checks, incl. the on-chain price floor
```

The swap venue on testnet is `testnet_pool/`: a fixed-rate SUI/tUSDC pool with an
owner-set price and a 0.30% fee, so the flow works regardless of real testnet
liquidity. The vault does not depend on it; any DEX that takes a coin and returns a
coin can be added in `src/blockchain/dex.ts`. In the Cipher chat, a proposal shows
as an approval card; approving signs `create_intent` and Cipher then runs it.

### Testnet write tools

These tools mutate testnet state. They use the local sender key and cannot be
undone. In the Cipher chat, Cipher must explain the action and ask for clear
confirmation in a separate message before calling a write tool.

| Tool | Inputs | Behavior |
|---|---|---|
| `transfer_sui` | `to`, `amount` | Sends SUI from the local sender wallet. Disabled by default because it bypasses the vault; set `SUI_ENABLE_DIRECT_TRANSFER=true` to register it. Gas is paid automatically and the tool waits for confirmation. |
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

The spending vault provides on-chain limits, pause, and revocation for
`vault_spend`. Local wallet write tools operate outside those vault rules.

Swaps are stricter: the agent cannot start one without an owner-signed on-chain
intent, so a prompt-injected or mistaken model cannot trade, change the amounts, or
keep the proceeds. What this does not protect: the owner key lives in the Sui CLI
keystore on the same machine, and the UI's Approve button signs with it, so anyone
with access to this machine and a local browser session can approve. A wallet-signed
approval (browser wallet) would remove that. `min_out` is the only price protection:
there is no oracle, so an owner who approves a poor price gets a poor price.

Not implemented yet: a separate signer process, wallet-wide policy limits, passkeys,
hardware-wallet approval, production secret storage, arbitrary Move call
authorization, token transfer policies, a recipient allowlist or daily cap for
`vault_spend`, oracle-based slippage, recurring or partial-fill trades, and
approval flows for `vault_spend` and `vault_stake` (they still run immediately,
bounded by the vault's rules).

See [docs/DESIGN.md](../docs/DESIGN.md) for the architecture and roadmap.
