# wallet-mcp

Local MCP tools for a Sui testnet wallet. The server exposes wallet inspection,
chain discovery, simulation, and explicitly mutating testnet actions to an MCP
client such as the `demo-ui` Cipher chat.

Testnet coins have no value. The MCP server uses the public sender address. A separate signer process owns the Ed25519 key and signs approved testnet proposals.

## Requirements

- Node.js 22 or newer
- npm
- A public testnet sender address in `SUI_ADDRESS` for tools that default to the sender

## Setup

```powershell
cd wallet-mcp
npm install
npm run build
```

The standalone operator command `npm run setup` creates the sender wallet if needed and requests testnet SUI
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
npm test
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
The contract enforces the per-spend limit, pause, and revocation, plus whatever
owner policies are set (see [Owner policies](#owner-policies)).

| Tool | Inputs | Behavior |
|---|---|---|
| `vault_status` | none | Reads vault balance, per-spend limit, total spent, paused flag, staking allowlist and positions, and other coins the vault may hold or holds. |
| `vault_spend` | `to`, `amount`, `dryRun` optional | Pays from the vault under its on-chain rules. |
| `vault_stake` | `validator`, `amount`, `dryRun` optional | Stakes vault funds with a validator the owner allowed, within the stake policy if one is set. The receipt stays in the vault. |

| `vault_spend` | `to`, `amount`, `dryRun` optional | Prepares or simulates a vault payment. |
| `vault_stake` | `validator`, `amount`, `dryRun` optional | Prepares or simulates a vault stake. |
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
| `vault_intents` | none | Lists on-chain approved trades and payments that have not run yet. |
| `vault_swap` | `proposalId` or `intentId`, `dryRun` optional | Runs an approved trade, or one a standing trade rule covers. Rejected by the contract otherwise. Proceeds go back into the vault. |

| `vault_intents` | none | Lists on-chain approved trades that have not run yet. |
| `vault_swap` | `proposalId` or `intentId`, `dryRun` optional | Prepares an unsigned approved trade. Submit its exact bytes through execute_approved_transaction after trusted policy approval. Proceeds go back into the vault. |

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

### Owner policies

Hard limits the agent cannot exceed, set by the owner and enforced by the contract.
All are optional and **off by default**: a vault with no policy behaves as before
(per-spend limit only), so configure them for every new vault.

| Policy | What it limits | Owner command |
|---|---|---|
| Spending cap | Total direct `vault_spend` per epoch (about a day). With `allowlist`, also only to listed recipients. | `spend-policy <sui> [any\|allowlist]`, `allow-recipient`, `disallow-recipient`, `clear-spend-policy` |
| Stake policy | Total staked, a liquid reserve the agent cannot stake into, and number of positions. | `stake-policy <maxStaked> <reserve> <positions>`, `clear-stake-policy` |
| Standing trade rule | One pair, one direction: max per trade, max per epoch, a price floor, and an expiry. Inside it a swap needs no per-trade approval. | `trade-rule <sell> <buy> <maxTrade> <maxEpoch> <minPrice> [hours]`, `remove-trade-rule` |

Anything outside a policy is not refused outright: the agent calls `propose_spend`
(or `propose_trade`), the owner sees an approval card, and approving signs a
single-use on-chain approval for exactly that recipient and amount.

| Tool | Inputs | Behavior |
|---|---|---|
| `propose_spend` | `recipient`, `amount` | **Does not pay.** Records a payment that needs approval and shows the owner a card. Refuses payments the policy already allows. |
| `vault_spend_approved` | `proposalId`, `dryRun` optional | Pays an approved spend proposal. The contract pays only the approved recipient and amount, once, before it expires. |

Standing trade rules: `propose_trade` checks the rule. If it covers the trade, the
proposal is created already approved (no card) and `vault_swap` runs it through
`begin_swap_auto`, which re-checks the rule on-chain. The agent still chooses
`amount_in` and `min_out`, but the contract rejects a trade over the size or epoch
limits, or with `min_out` below the owner's floor.

```powershell
npm run owner -- spend-policy 0.05 allowlist
npm run owner -- allow-recipient 0x...
npm run owner -- stake-policy 2 0.05 2
npm run owner -- trade-rule SUI tUSDC 0.05 0.1 1.5 24   # sell up to 0.05 SUI, floor 1.5 tUSDC per SUI
npm run owner -- spend-intent 0x... 0.08                # approve one payment directly
npm run vault -- spend-approved prop_xxxxxxxxxx --dry-run
```

What these do **not** do:

- **The price floor is the owner's number, not an oracle.** If the market falls below
  it the rule simply stops matching; if the owner sets it far below the market, the
  agent could sell cheaply inside the size limits. Keep the floor near the market and
  the limits small.
- **The per-epoch caps are per Sui epoch, not per rolling 24 hours.** A spender can
  use a full cap just before an epoch boundary and again just after, up to twice the
  cap in a short time.
- **A DEX or pool allowlist cannot be enforced on-chain.** The contract sees only the
  output coin and `min_out`, not which pool the agent routed through.
- **The Approve button signs with the owner's CLI key**, using the keystore on this
  machine. It is not a wallet signature the owner reviews. Anyone who controls this
  machine controls the owner key.
- **The owner and upgrade authority are single keys.** There is no multisig or
  timelock on the `OwnerCap` or the package `UpgradeCap`; an upgrade can change what
  every rule does.
- **The agent key lives in the MCP process.** There is no isolated signer.
- **Stake counters are kept by the contract.** Positions opened before a stake policy
  existed are synced when the owner sets the policy (`stake-policy` does this from the
  vault's actual receipts). Unstaking never fails because of a counter.

### Testnet write tools

### Testnet transaction tools

Preparation tools return unsigned transaction bytes in `structuredContent.transactionBytes`.
Use `estimate_gas` with those exact bytes before approval. In Cipher, confirm
with the user before invoking the faucet or execution tool.

| Tool | Inputs | Behavior |
|---|---|---|
| `transfer_sui` | `to`, `amount` | Prepares a direct SUI transfer. Set `SUI_ENABLE_DIRECT_TRANSFER=true` in the MCP environment to enable preparation outside the vault. |
| `request_faucet` | none | Requests testnet SUI for the configured sender without a wallet signature. |
| `split_coin` | `coinId`, `amount`, `recipient` optional | Prepares a coin split. The sender is the default recipient. |
| `merge_coins` | `primaryCoinId`, `coinIds` | Prepares a coin merge. |
| `execute_approved_transaction` | `network`, `proposalId`, `transactionBytes`, `policyDecision` | Requests a signature for an approved proposal, submits the signed bytes to testnet, and reports its digest. |

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

## Isolated signer

Run the signer and the model-facing services under separate OS accounts.
Install the signer code and dependencies in a location writable only by the
signer account or an administrator. The signer owns the testnet key and its
persistent state. Configure `SUI_WALLET_FILE` as a signer-owned file with mode
`0600` in a private directory, or inject `SUI_SECRET_KEY` into the signer process
only. An existing testnet wallet file uses the same JSON format as the
standalone setup command. Run key-bearing setup and operator scripts from the
signer account and keep that wallet out of the model-facing checkout.

1. Build wallet-mcp and set `SUI_SIGNER_STATE_DIR` to an absolute, private,
   persistent directory owned by the signer. Startup creates `approvals/` and
   `consumed/` with mode `0700`.
2. Generate a bearer token with `openssl rand -hex 32`. Set `SUI_SIGNER_TOKEN`
   in the signer and MCP environments and keep it in server-side configuration.
3. Start the signer with `npm run signer`. It binds to `127.0.0.1:38435`.
   Set `SUI_SIGNER_PORT` on both processes to change the port.
4. Set `SUI_ADDRESS` in the MCP environment to the public address printed by
   the signer. The chat host forwards these MCP settings. Its wallet panel
   also accepts the public `SUI_RECEIVER_ADDRESS`.

The trusted policy and proposal service must publish an approval atomically
to `approvals/<proposalId>.json` after checking the exact serialized bytes.
Use a temporary file followed by a rename in the same directory. The approval
producer must have trusted write access through the signer account. The
model-facing process receives only the public address, IPC token, and proposal
details. A chat confirmation or a caller-provided decision alone has no
authority.
Swaps are stricter: the agent cannot start one without an owner-signed on-chain
intent, so a prompt-injected or mistaken model cannot trade, change the amounts, or
keep the proceeds. What this does not protect: the owner key lives in the Sui CLI
keystore on the same machine, and the UI's Approve button signs with it, so anyone
with access to this machine and a local browser session can approve. A wallet-signed
approval (browser wallet) would remove that. `min_out` is the only price protection:
there is no oracle, so an owner who approves a poor price gets a poor price.


An approval file contains these fields:

```json
{
  "network": "testnet",
  "proposalId": "payment-123",
  "transactionBytes": "<base64 BCS transaction bytes>",
  "policyDecision": { "id": "decision-123", "allowed": true },
  "expiresAtMs": 1794355200000
}
```

Use a unique proposal ID and a short expiry expressed in Unix milliseconds.
Send the same fields except `expiresAtMs` to the execution tool. The signer
checks the bearer token, approved bytes and decision, testnet chain identifier,
transaction epoch bounds, and sender and gas owner. It consumes the proposal
ID before returning a signature. Keep the `consumed/` state across restarts.
If signing or submission is interrupted, reconcile the transaction digest
before approving another proposal. Signer refusals include a machine-readable
error code.

The deterministic policy and durable proposal workflow are dependencies of
the signer integration. This branch defines the approval record contract.
Execution fails closed until a trusted producer publishes an approval.
`npm test` exercises the contract through a local signer with a fixture key.

Swap MCP tools never load a private key: vault_swap prepares unsigned bytes (or simulates). On-chain owner approval and the signer’s separate byte-bound policy approval are both required. Preparation does not mark a proposal executed; confirm the execution digest and on-chain intent state before retrying.

### Signer environment file

Copy .env.signer.example to .env.signer and fill in the existing agent wallet path (or signer-only secret key), private state directory, and bearer token. npm run signer loads .env.signer explicitly. The UI backend uses a matching token/state directory in demo-ui/.env.local; it needs only the public SUI_ADDRESS, never the signer private key. Real environment files and state are gitignored; templates contain no secrets.
