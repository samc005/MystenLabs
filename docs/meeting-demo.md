# Meeting demo: November wallet changes

The past week's work adds a chat/MCP interface, a Move vault with spending and staking policies, a trading sleeve and owner-approved swaps, non-SUI custody, an isolated signer, and local passkeys. PR #46 adds the authenticated connection from requests to signer approval and deterministic wallet dispatch.

## Prerequisites

Use the feature branch until #46 is merged. Node 22+ is required. Build the MCP server before starting chat:

    npm ci --prefix wallet-mcp
    npm run build --prefix wallet-mcp
    npm ci --prefix demo-ui
    npm test --prefix demo-ui
    npm run build --prefix demo-ui

The existing agent wallet must own the configured AgentCap and have testnet SUI for gas. The vault needs a funded main balance. Match SUI_VAULT_PACKAGE_ID, SUI_VAULT_ID, and SUI_VAULT_AGENT_CAP_ID to a deployed contract with the required functions. Do not create a new unrelated wallet for an existing capability.

The local environment files are demo-ui/.env.local and wallet-mcp/.env.signer. Their committed templates are demo-ui/.env.example and wallet-mcp/.env.signer.example. Copy the templates when setting up another checkout, generate a fresh matching signer token for both files, and use the same absolute private signer-state directory in both. Never commit populated environment files.

Set ANTHROPIC_API_KEY and SUI_ADDRESS in demo-ui/.env.local. Set SUI_WALLET_FILE to the absolute path of the existing agent wallet in wallet-mcp/.env.signer (private file mode 0600); alternatively set SUI_SECRET_KEY only there. npm run signer explicitly loads .env.signer; Next loads .env.local. Shell environment variables take precedence, so remove stale exported values when changing files. Configure public vault/pool overrides to match the deployment, and WALLET_CONTACTS_JSON with real full addresses for Alice/Bob. Leave optional overrides commented rather than blank.

This demo's backend and signer need trusted access to the same private state directory. This is a localhost prototype, not a deployment with separate OS-user isolation. See authenticated-workflow.md for details.

Start two terminals from the repository root:

    npm run signer --prefix wallet-mcp

    npm run dev --prefix demo-ui

Open http://localhost:3000/chat. Use the same hostname and port throughout the demo. Confirm the wallet panel shows the expected public address and balances. The separate browser-wallet route has its own browser-generated wallet: funding it does not fund the agent's gas account or vault.

## Five-minute presentation

1. Say: “The model translates intent; deterministic code chooses the capability; the owner confirms spending; the contract enforces limits.”
2. Enter balance. Enroll a passkey on first use, then authenticate the request. Show the MCP result coming from testnet. Enter vault status to show balances and on-chain limits.
3. Enter reverse a linked list. After authentication the application returns an unsupported-request error, without calling a general coding tool.
4. Enter can you send 0.01 SUI to Alice? The trusted contact configuration resolves Alice to an address. Inspect the canonical amount/address and simulation output. Cancel first to demonstrate that preparation does not spend.
5. Repeat with send Alice 0.01 SUI. Confirm the same recipient and amount. Choose Approve with passkey and execute only if you intend to spend this small testnet amount. Check the returned digest on the testnet explorer and refresh the recipient balance.
6. Optionally show quote 0.05 SUI to tUSDC. This uses the project's testnet mock pool, not a live mainnet DEX price. A swap needs funds in the trading sleeve; pending proposals need owner CLI approval through the card plus passkey. Use the exact supported execution command shown in authenticated-workflow.md when needed.

Rehearse steps 4–5 with the actual device and chain before the meeting. The automated tests do not prove that the enrolled authenticator, configured RPC, deployed package and funded accounts work together.

## Optional contract demonstrations

- request payment <amount> SUI to <full address> records an owner-approval proposal for a payment outside policy. An ordinary send outside policy fails; it does not silently escalate.
- validators lists candidate validators. Staking requires owner allowlisting, minimum 1 SUI, and any configured reserve/position limits; avoid staking live unless rehearsed.
- Show the passing Move tests as evidence of cap, allowlist, expiry, replay, price-floor and revocation enforcement.
- Passkey controls at /browser-wallet can lock the application. Unlock before returning to chat. This is an application lock, not on-chain revocation.

## What to say accurately

Authentication is local WebAuthn verified by the backend. Move still verifies the agent key and capability; it does not verify this browser passkey directly. Owner approvals currently use a local Sui CLI key. The signer checks exact approved bytes, testnet chain and epoch scope, and single-use proposal IDs.

This is a single-owner localhost demo. Voice transcription and hosted multi-user accounts are not implemented. Natural-language interpretation can fail or be ambiguous; the supported capabilities are restricted deterministically and spending details require explicit confirmation.

## If rehearsal fails

- Missing signer approval/state: check the UI and signer share the private state directory and bearer token.
- Missing capability, wrong sender, insufficient gas: use the signer address that owns AgentCap and fund its testnet gas account.
- Move target not found: check the configured package version; a Git merge does not deploy or upgrade contracts.
- Unknown Alice/Bob: configure their full addresses in WALLET_CONTACTS_JSON and restart the UI.
- Passkey failure: keep localhost origin consistent. Do not delete an existing credential store to bypass authentication.
- Unknown submission status: inspect the reported digest before preparing another payment.

If live execution is unavailable, show authenticated reads, unsupported-request rejection, preparation/simulation, and the automated enforcement tests. Do not claim an executed payment without a confirmed digest.
