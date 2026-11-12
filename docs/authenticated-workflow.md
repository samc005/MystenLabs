# Authenticated wallet workflow

This branch connects the local chat UI to passkey authentication, deterministic wallet dispatch, transaction simulation, and the isolated signer. It targets a single-owner localhost testnet demo, not a hosted multi-user wallet.

## User journey

1. Submit one wallet request. On first use the browser enrolls the owner's passkey; later device enrollment requires an existing passkey.
2. Authenticate the exact request with WebAuthn user verification. Approval is single-use and expires after two minutes.
3. Explicit commands are parsed directly. Other wording is translated by the model into a constrained intent. The backend validates that intent and resolves contacts through operator configuration. General-purpose answers, scripts, arbitrary Move calls, raw transaction input, and model-chosen tool names are not accepted.
4. Code dispatches one allowed MCP action. Read results return directly. A spend or stake prepares unsigned bytes, simulates them, and presents the canonical amount and resolved address with simulation output.
5. The owner chooses Approve with passkey and execute. This second, distinct passkey approval binds an opaque server-generated transaction ID and its canonical command. The ID refers to immutable bytes held only on the server.
6. The backend claims the transaction once, checks the emergency lock, simulates those exact bytes again, and atomically publishes a short-lived byte-bound approval record.
7. MCP requests a signature from the signer and submits the exact bytes. Validators enforce vault policies. The receipt contains the transaction digest; unknown submission status must be checked before creating another approval.

Swap and out-of-policy payment proposal cards additionally require passkey approval of the complete stored proposal before the owner CLI can create an on-chain intent. Execution still requires its own passkey confirmation and signer record.

## Commands and natural language

Supported commands: balance; vault status; validators; send <amount> SUI to <full address>; stake <amount> SUI with <validator address>; quote <amount> SUI to tUSDC; swap <amount> SUI to tUSDC; execute swap prop_<10 hex digits>; execute payment prop_<10 hex digits>; request payment <amount> SUI to <full address> (for an owner-approved out-of-policy payment).

Natural-language examples such as “can you send 0.01 SUI to Alice?” translate into the same canonical action as other phrasings. Configure trusted contacts using WALLET_CONTACTS_JSON, a JSON object mapping names such as Alice and Bob to full Sui addresses, in the UI backend environment.

Unknown contacts fail. There is no model-generated address, contact-book editing tool, or automatic name-service lookup. The translator must preserve literal recipient/validator/amount details present in the request. Missing or ambiguous details fail rather than being invented. Number words and unsupported assets can be refused. Voice can later feed transcription into this same interface; microphone capture/transcription is not part of this PR.

The deterministic guarantee is capability restriction, not perfect understanding of arbitrary language. A translation mistake can still select a valid wallet intent. The canonical confirmation and passkey are the owner's final authorization; the vault independently enforces limits. Unrelated model prose never reaches the UI.

## Operator setup

Use Node 22+ and Sui's matching testnet toolchain. Build wallet-mcp before starting the UI. Configure the deployed package/vault/capability and pool IDs to match the deployed contract version; merging code does not upgrade a package.

The trusted backend needs SUI_ADDRESS (agent public address), SUI_SIGNER_STATE_DIR (absolute private directory), SUI_SIGNER_TOKEN (64 lowercase hex characters), and optionally SUI_SIGNER_PORT (default 38435). Natural-language translation additionally needs ANTHROPIC_API_KEY. WALLET_INTENT_MODEL defaults to claude-opus-5-5.

The signer uses the same state directory/token and its private testnet key, as described in wallet-mcp/README.md. Create a private state directory (0700); approvals are written atomically with mode 0600. The demo backend must own and have trusted access to that directory. Public vault/pool overrides are forwarded to MCP; secret keys and the state directory are not forwarded.

Trust boundary: this local integration trusts the UI backend, MCP transaction builders, local owner CLI, and signer. It does not implement OS-user isolation between these processes. Running them under the same OS user does not protect keys/state from a fully compromised local process. Separate signer ownership needs a narrowly scoped authenticated approval broker rather than shared filesystem ownership. Owner contract administration still uses the CLI key; WebAuthn is verified by this backend, not by Move. Emergency lock stops this application's new requests; it is not on-chain capability revocation.

Pending transactions and WebAuthn challenges live in one server process. Restarts expire them safely. Do not run multiple UI workers against this memory-based state. Signer consumption state persists across restarts.

## Verification

Run npm test in demo-ui for intent/allowlist/contact/approval/replay/enrollment tests, npm test in wallet-mcp for signer tests, and build both packages. Authorization and execution tests mock cryptographic verification, MCP, and filesystem storage to test server authorization state; they do not replace a real-device WebAuthn test.

Before a live demo, test with a real passkey, configured signer, funded gas account, and matching deployed vault:

- Register; authenticate a read; confirm a low-value payment; inspect its digest.
- Reject linked-list/general-code requests; unknown names; altered recipients; extra fields.
- Cancel a prepared transaction; attempt replay; expire an approval; restart the UI.
- Lock the application and verify command/execution/proposal approval rejection.
- Verify the chain rejects an out-of-policy spend even when the UI approves it.

No live transaction or device biometric approval is generated by automated tests.

## Passkey device management and lost-device recovery

Open /passkeys (linked from chat and browser-wallet). With a working passkey, Show registered devices requires authentication, Add new passkey requires an existing credential, and removing a device requires approval bound to that credential ID. The last credential cannot be removed through the site; add its replacement first. Credential changes invalidate outstanding WebAuthn challenges and application approvals. Mutations are serialized and credential files are replaced atomically.

If every private passkey was deleted from Google Password Manager or lost, the server's old public-key registration cannot authenticate you. In your own private terminal, from the repository root, run:

    npm run passkeys:recover --prefix demo-ui

Enter the displayed one-use code at http://localhost:3000/passkeys within 10 minutes. Do not share the code. The server retains a private backup of the old registrations, removes their application access, and locks wallet actions. Stay in that tab and click Add new passkey; the recovery response authorizes replacement enrollment only in that tab. Then choose Unlock with new passkey and return to chat. If you close the tab before enrollment, generate a new local code and restart recovery.

The code is generated only by the local operator CLI, never by an agent tool or unauthenticated site endpoint. Its hash, not its plaintext, is stored under the ignored .passkey directory. A new code supersedes the previous one. Expired, incorrect, and replayed codes fail. Another tab cannot claim replacement enrollment without the recovery response token.

Removing a registration does not remove a passkey from a device's password manager. Local recovery does not change wallet keys, funds, contract ownership, or on-chain AgentCaps, and cannot undo a transaction already signed or submitted. This is localhost operator recovery, not hosted-account identity recovery. Do not manually delete credentials.json to bypass authentication.
