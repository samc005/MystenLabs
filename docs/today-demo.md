# Today's separate-vault demo

Your local environment points to your own new testnet vault and mock pool. The team vault is unchanged. Both staking and trading have passed real testnet simulations and actual MCP unsigned preparation. Real-device passkey execution must still be rehearsed.

## Start / restart

If the services are already running, Ctrl-C in those terminals first so the UI reloads the new environment. From the repository root:

Terminal 1:

    npm run signer --prefix wallet-mcp

Terminal 2:

    npm run dev --prefix demo-ui

Open http://localhost:3000/chat. Keep the same hostname for passkeys. The signer uses the same wallet and token as before; no secret was copied into the UI.

Optional read-only check:

    npm run preflight --prefix wallet-mcp

Every check passed at setup time. The standing trade rule expires after 24 hours; renew it with owner:demo trade-rule if rehearsing on another day.

## Six-minute meeting sequence

1. Explain: “The agent interprets intent, code restricts capabilities, the owner authorizes exact transactions, and the vault enforces the rules on chain.”
2. Enter balance and vault status. Authenticate with your existing passkey (or register on first use). Initially the vault has 1.18 SUI main balance, a 0.02 SUI trading sleeve, a 0.1 SUI spend cap, one allowed staking validator, and a standing trade rule.
3. Enter reverse a linked list. Expect an unsupported wallet-request error, not generated code.
4. Enter this exact staking command:

       stake 1 SUI with 0x05f2ca9b4bf0a2275440eb34e6b7d8b43775c68b421a677b5e5a2ff3e5792aaa

   Review the simulation. Choose Approve with passkey and execute only when ready to lock that testnet stake. Verify the transaction digest, then vault status shows the stake receipt. This is native staking with Aphelion; rewards/activation follow Sui epoch timing. The agent cannot unstake.
5. Enter:

       swap 0.001 SUI to tUSDC

   It should produce an approved proposal under your standing rule. Click Prepare approved transaction. Authenticate the request, inspect the minimum return and simulated balance changes, and confirm execution with your passkey. Verify the digest. The proceeds stay in the trading sleeve, not the agent wallet.
6. Enter vault status again. Show that funds are in the vault/staking receipt/trading sleeve while the agent paid only gas.
7. Optional guardrail: “Please send 0.11 SUI to DemoOwner.” It should be refused because it exceeds the 0.1 SUI payment limit. DemoOwner is your own owner wallet alias.
8. Optional additional flow after the first swap: swap 0.001 tUSDC to SUI. This direction has no standing rule, so the card requires owner approval using the local owner CLI key, gated by your passkey. Then prepare and confirm execution. This demonstrates one-off approvals versus standing permissions. Rehearse before showing it live.

Do not claim a stake or trade succeeded unless the UI provides a confirmed digest. A prepared transaction or successful simulation is not execution.

## Boundaries to explain

- Staking is a real Sui system-contract integration. Trading is an on-chain testnet mock pool, not a production DEX.
- Rule limits, price floor, reserve, stake total and position count are enforced by Move. Epoch budgets are not rolling 24-hour budgets.
- Local WebAuthn protects application actions. The master key is still the CLI owner key, not an on-chain passkey.
- Liquid staking, lending, explicit blacklists, cross-chain and multi-hop routing remain future work.
- The contract prevents unauthorized actions even if the model proposes them; arbitrary natural language is not guaranteed to be interpreted perfectly, so confirm resolved details.

## Reset after a successful staking rehearsal

The demo allows one 1 SUI position. To repeat the live stake, have the owner withdraw the existing stake back into the vault first:

    npm run owner:demo --prefix wallet-mcp -- unstake <stakedSuiId-from-vault-status>

This is an actual owner-authorized testnet transaction. Never reset passkey credentials or signer consumed-approval state to repeat a demo. Each execution needs fresh approval.
