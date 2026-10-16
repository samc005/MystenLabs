# AI wallet on Sui

A testnet wallet that turns a plain-English sentence into a Sui transaction. The model proposes. Policy, a separate signer, and a Move vault decide whether the money moves.

The design, security plan, stage-by-stage boundaries, and roadmap are in [docs/DESIGN.md](docs/DESIGN.md).

## Packages

| Directory | What it is |
|---|---|
| [hello-mcp](hello-mcp/README.md) | A one-tool MCP server (`ping`). The AI-track exercise. |
| [wallet-mcp](wallet-mcp/README.md) | Sui testnet client and the wallet MCP server (`get_balance`, `transfer_sui`). |

## Where the work is

The chain path is proven: faucet, balance, and a 0.01 SUI transfer on testnet. Signing still happens inside `wallet-mcp`. A model has not called the tools yet. That connection is the current phase. Policy, the isolated signer, simulation summaries, the vault, and passkeys are specified in the design doc and are not built.
