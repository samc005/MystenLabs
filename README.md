# AI wallet on Sui

A testnet wallet that turns a plain-English sentence into a Sui transaction. The model proposes. Policy, a separate signer, and a Move vault decide whether the money moves.

The design, security plan, stage-by-stage boundaries, and roadmap are in [docs/DESIGN.md](docs/DESIGN.md).

## Packages

| Directory | What it is |
|---|---|
| [demo-ui](demo-ui/README.md) | Browser wallet and local Cipher chat, passkey authorization, and proposal workflow. |
| [wallet-mcp](wallet-mcp/README.md) | Sui testnet tools, transaction preparation, isolated signer, and CLI scripts. |
| [my_counter](my_counter/) | Move spending vault and its policy regression tests. |
| [testnet_pool](testnet_pool/) | Move test token and fixed-rate swap pool. |

See [the project structure](docs/project-structure.md) for module responsibilities and [the authenticated workflow](docs/authenticated-workflow.md) for setup and verification.

## Where the work is

The wallet MCP prepares testnet transactions and submits them after the isolated signer approves the exact bytes. End-to-end execution through Cipher requires a trusted policy and proposal service to publish approvals. See the [signer setup](wallet-mcp/README.md#isolated-signer).

The [on-chain agent security policy](docs/onchain-agent-security.md) documents mandatory permissions, secure vault creation, migration barriers, and the owner-key trust boundary.
