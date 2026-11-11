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
The contract enforces the per-spend limit, pause, and revocation.

| Tool | Inputs | Behavior |
|---|---|---|
| `vault_status` | none | Reads vault balance, per-spend limit, total spent, and paused flag. |
| `vault_spend` | `to`, `amount`, `dryRun` optional | Prepares or simulates a vault payment. |
| `vault_stake` | `validator`, `amount`, `dryRun` optional | Prepares or simulates a vault stake. |

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
