# Meeting requirements and today's demo readiness

Source: Meeting Notes, Oct 29 and Oct 20, https://docs.google.com/document/d/1bZJ5rDPVOaudAwSUoVRtH_kFbT9LpD1oRDCz5T0d6Gw/edit

## Requirement coverage

| Meeting requirement | Implementation | What is not yet proved or included |
| --- | --- | --- |
| Vault holds capital; agent holds gas | Vault balance and separate signer wallet | Separate owner-controlled demo vault is configured; signer owns its AgentCap |
| Agent interacts with vault via MCP | Fixed wallet-intent dispatcher, MCP builders, byte-bound signer approval | A live authenticated transaction must be rehearsed after authorization |
| Native staking integration | Sui system staking call from vault; receipt held by vault; owner unstaking | Minimum 1 SUI, allowed validator and policy limits apply; separate demo vault now has 1.18 SUI in its main balance; 1 SUI simulation passes |
| Trading integration | Vault begin-swap, on-chain mock pool, finish-swap; proceeds return to sleeve | This is a testnet mock venue, not Cetus/DeepBook or a production DEX |
| Application-specific restrictions | Spend cap/recipient allowlist; stake total/reserve/positions; standing trade size, epoch cap, floor and expiry | Epoch budgets are not rolling 24-hour limits; verify deployed policy settings |
| Separate admin key; one-off authorization | OwnerCap, owner CLI and exact single-use spend/trade intents | Local WebAuthn gates UI approvals, but owner administration still uses a CLI key, not an on-chain passkey |
| Pause/revoke | Contract pause and agent-version revocation; application passkey lock | Application lock and on-chain revocation are distinct |
| Optional recipient allowlist | Implemented | A separate explicit recipient blacklist from Oct 20 is not implemented |
| UI and smart contract developed together | Chat, proposal cards, passkey confirmation and simulated balance changes | Real-device WebAuthn rehearsal remains necessary |
| Pick one or two real activities | Native staking and on-chain mock-pool swaps selected | Liquid staking and lending remain unimplemented alternatives |
| Extra novelty / multi-hop idea | Composable begin-swap/finish-swap ticket and policy constraints | Cross-chain, asynchronous and multi-hop routing are not implemented |

Do not claim all meeting requirements are completed or exceeded. The local policy engine, replay protection, passkeys and richer contract policies are additional progress, but they do not replace live staking/trading evidence.

## Read-only preflight from the repo root

    npm run build --prefix wallet-mcp
    npm run preflight --prefix wallet-mcp

It reports blockers without signing or changing the chain. A successful quote is not an executed swap.

Earlier team-vault check (superseded by the separate demo deployment):
- Configured signer: 1 SUI gas; does not own configured AgentCap.
- Main vault: 0.030009968 SUI; unpaused; one validator allowed.
- Trading sleeve: 0.054925 SUI.
- Quote: selling 0.001 SUI returns 1994 raw tUSDC units at the mock pool.

These are observations at check time, not persistent guarantees.

## Owner setup needed before live staking/trading

The owner must use the CLI keystore that holds this vault's OwnerCap. These are explicit operator actions; they are not agent tools and are not run by preflight.

1. Grant the configured signer constrained vault access:

       npm run owner:demo --prefix wallet-mcp -- authorize-agent <SUI_ADDRESS>

   Inspect the transaction's newly created AgentCap in its explorer receipt. Put its object ID in SUI_VAULT_AGENT_CAP_ID in demo-ui/.env.local. Restart the UI. Do not substitute an OwnerCap.

2. Fund the main vault for staking, for example 2 testnet SUI from the owner wallet:

       npm run owner:demo --prefix wallet-mcp -- fund 2

   Funding the agent wallet or trading sleeve does not fund the main vault. The owner must have funds plus gas. No owner funds are moved automatically.

3. Run preflight again. In chat, authenticate validators and select an allowed validator. Then request:

       stake 1 SUI with <allowed-validator-address>

   Review simulation and policy constraints, confirm with the passkey, and verify the digest. Show the receipt in vault status; only the owner can unstake.

4. Request a small trade:

       swap 0.001 SUI to tUSDC

   If pending, approve the exact proposal with the owner card and passkey. If already approved under a standing rule, use Prepare approved transaction. Review the simulated balance changes, approve execution with the passkey, and verify the digest and sleeve balances. Do not re-run a transaction whose submission status is unknown.

5. Demonstrate a rejected action: unrelated coding request; disallowed validator; or transaction exceeding configured rules. Read the actual refusal, not a model's claim of success.

The Claude translator uses automatic tool selection because the configured model rejects forced tool choice. Automatic selection does not broaden permissions: the backend still requires exactly one recognized intent, validates its fields and grounds literal details before dispatch.


## Separate demo deployment — verified after setup

A separate copy of the vault package and mock-pool package was published on testnet. Your local owner created the vault and granted its AgentCap to your configured signer. Only gitignored local environment overrides were changed; the team deployment was not upgraded or funded.

Configured and confirmed on chain:
- Main vault funding: 1.2 SUI; 0.02 SUI allocated to the trading sleeve, leaving 1.18 SUI liquid.
- Per-payment limit and epoch spend cap: 0.1 SUI.
- Staking limit: 1 SUI total, one position, minimum liquid reserve 0.05 SUI.
- Allowed validator: Aphelion, 0x05f2ca9b4bf0a2275440eb34e6b7d8b43775c68b421a677b5e5a2ff3e5792aaa.
- Standing SUI-to-tUSDC rule: 0.01 SUI per trade, 0.03 SUI per epoch, minimum price 1.5 tUSDC/SUI, expires 24 hours after setup.
- DemoOwner contact: your own local CLI owner address (not an external Alice/Bob identity).

Verification completed:
- Live Claude natural-language translation returns a valid balance intent.
- Read-only preflight: all checks READY.
- Native 1 SUI staking and 0.001 SUI standing-rule swap simulate successfully on testnet.
- Actual MCP server: both workflows simulate successfully and return unsigned transaction bytes.
- No stake or swap was consumed by these checks; perform passkey-approved execution during rehearsal.
- Confirmed proposal executions now update the proposal card; unknown/unconfirmed submissions do not.

See today-demo.md for the exact presentation commands. Deployment receipts, configuration, validator selection, and simulation results are saved under the ignored wallet-mcp/.wallet directory.
