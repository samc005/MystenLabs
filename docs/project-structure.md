# Project structure

## Repository layout

| Directory | Responsibility |
| --- | --- |
| `demo-ui/` | Next.js browser wallet, local Cipher chat, passkey authorization, and proposal service |
| `wallet-mcp/` | MCP server, Sui transaction services, isolated signer, and operational scripts |
| `my_counter/` | Move spending vault, deployment metadata, and policy regression tests |
| `testnet_pool/` | Move test token and fixed-rate testnet swap pool, with deployment metadata |
| `docs/` | Design, setup, security boundaries, demo runbooks, and dated verification evidence |

`my_counter` retains its original package name but contains the spending vault;
it is an active contract package. The testnet pool is used by the swap tools.
Keep their Move lockfiles and published metadata for reproducible builds and deployment tracking.

## UI and authorization

- `demo-ui/app/`: pages and API routes for chat, passkeys, proposals, script execution, and wallets.
- `demo-ui/components/`: chat, proposal, script runner, and wallet panels.
- `demo-ui/lib/server/`: model/MCP integration, passkey verification, proposal storage, intent validation, and wallet execution.
- `demo-ui/lib/`: browser wallet helpers, shared policy logic, and response parsing.
- `demo-ui/scripts/` and `demo-ui/test/`: recovery, security verification, rehearsals, and authorization regression tests.

## Wallet services

- `wallet-mcp/src/index.ts`: stdio MCP entry point.
- `wallet-mcp/src/config.ts`: network configuration and public deployment identifiers.
- `wallet-mcp/src/mcp/`: server configuration and tool definitions.
- `wallet-mcp/src/blockchain/`: Sui reads, transaction preparation/submission, vaults, proposals, and swaps.
- `wallet-mcp/src/signer/`: authenticated signer client, protocol, and separate signer process.
- `wallet-mcp/src/scripts/`: setup, balance, transfer, vault, owner, demo, and preflight commands.
- `wallet-mcp/src/web.ts` and `wallet-mcp/web/`: standalone local wallet web demo.
- `wallet-mcp/test/`: signer and owner setup regression tests.

The UI starts the wallet MCP server over stdio. Tools use the blockchain services;
signing requests go through the isolated signer. See the
[authenticated workflow](authenticated-workflow.md) and
[signer setup](../wallet-mcp/README.md#isolated-signer) for configuration and trust boundaries.

## Local and generated files

Install and build the two Node packages separately using their READMEs. Their
`node_modules/`, build output, local environment files, wallet secrets, and
passkey state are ignored by Git. Commit the package lockfiles and environment
examples; keep populated environment files and private state local.

Dated JSON evidence and demo notes in `docs/` record prior verification runs.
They are historical evidence rather than live deployment status.
