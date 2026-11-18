# Security assessment: current architecture

Date: 2026-11-18. Scope: `my_counter/sources/spending_vault.move`, `wallet-mcp/`, `demo-ui/`, and `docs/`.
Method: manual code review, plus `sui move test` (151/151 pass). The `wallet-mcp` and `demo-ui` test suites could not run in the review sandbox (a `tsx` IPC socket was blocked), so they are **not verified**. Nothing was checked on-chain, so deployed state is also unverified.

This is a review, not an audit. Findings are labelled **confirmed** (read directly in code) or **to verify** (needs a test or an on-chain check).

## 1. Verdict

| Layer | Strength | Why |
| --- | --- | --- |
| Move vault (the real security boundary) | Good for a testnet demo | Funds sit in a shared `Vault`. The agent holds only an `AgentCap`. Every agent path checks vault ID, cap version, pause state, permission flag and policy. Extensive negative tests. |
| Signer (`wallet-mcp/src/signer`) | Weak to moderate | It is a replay and sanity gate, not a policy gate. It signs any approved-by-file transaction from the agent address. It does not inspect what the transaction does. |
| Approval chain (passkey, UI, approval file) | Weak to moderate | The passkey is verified only by the UI backend. Nothing downstream can check it. The "separate OS account" signer isolation is not actually enforced. |
| Owner key | Weak (documented) | It lives in the plain Sui CLI keystore on the same machine. Whoever controls that machine controls the vault. |
| Defaults / config | Weak | The default vault in `config.ts` is a legacy vault. The legacy `create` entry point is still public. |

**Bottom line.** If the agent key, the MCP server and the model are all compromised, the on-chain design limits the loss to what the owner enabled. That holds only for a vault created with `create_secure` or migrated with `set_agent_security_policy`. It does not protect against a compromised owner machine, UpgradeCap holder, or a legacy or unmigrated vault.

## 2. What exists

### On-chain: `my_counter::spending_vault`
- **Objects**
  - `Vault` (shared): SUI balance, per-tx limit, pause flag, agent version.
  - `OwnerCap` (key+store): required for every admin action.
  - `AgentCap` (key+store): carries a version, so `revoke_all_agents` kills all caps.
- **Agent actions**
  - `spend`, `spend_with_clock`
  - `spend_approved`
  - `stake`
  - `begin_swap` / `finish_swap`
  - `begin_swap_auto`
- **Owner controls**
  - Pause, per-tx limit, withdraw.
  - Spend policy (epoch cap, recipient allowlist).
  - Calendar policy (UTC day and week caps).
  - Recipient blocklist.
  - Stake policy (cap, reserve, position count).
  - Validator allowlist.
  - Coin allowlist.
  - Trading sleeve.
  - One-shot `Intent` / `SpendIntent`.
  - Standing `TradeRule` with a price floor.
  - `AgentSecurityPolicy` with payments/staking/trading toggles. It cannot be removed once installed.
- **Safety mechanisms**
  - Hot-potato `SwapTicket`.
  - `StakedSui` receipts stay inside the vault.
  - Fail-closed pause (`is_paused` aborts on inconsistent state).
  - Legacy-package freeze through the `vault.paused = true` ratchet.
- **Published**
  - `Published.toml`: package `0x7e19…90e9`, version 4, original id `0x9468…a533`.
  - `docs/onchain-agent-security.md` describes a *different* deployment: package `0x24e3…ed4f` ("v3"), vault `0xa963…8888`. See finding F-12.

### Off-chain: `wallet-mcp`
- MCP server with read tools, plus transaction-preparation tools (transfer, split/merge, vault spend, stake, propose/execute trade, propose/execute spend).
- All preparation tools return unsigned bytes. Execution goes through `execute_approved_transaction`, which calls the **isolated signer** over loopback HTTP.
- Signer checks:
  - bearer token (constant-time compare)
  - testnet chain id
  - approval file for the proposal ID, exact byte match, and expiry
  - sender and gas owner equal to the agent address
  - `ProgrammableTransaction` kind
  - canonical BCS round trip
  - 1-epoch validity window
  - one-time consume via `mkdir consumed/<id>`
- Owner actions (`blockchain/owner.ts`) are deliberately not imported by the MCP server. They run through the `npm run owner` script with the CLI keystore key.

### Off-chain: `demo-ui`
- Constrained command parser (`wallet-policy`, `wallet-intent`). It is not a free-form tool agent.
- WebAuthn passkey gate on execute, approve and reject, and on passkey management. Approvals are in-memory, single-use and bound to an action hash.
- Localhost-only guard (`rejectNonLocal`: host, origin, JSON content type).
- On passkey-approved execution, the backend writes `approvals/<id>.json` for the signer and calls `execute_approved_transaction`.

## 3. Findings

Severity assumes a mainnet-like deployment with real funds. Testnet-only today, so most are "fix before mainnet".

### Critical / High

**F-01 (High, confirmed; mitigated 2026-11-18 by the hard-rule policy engine, see `wallet-mcp/src/policy/evaluate.ts`). Signer does not enforce transaction content.**
*Status: the signer now re-runs `evaluateTransaction` on the exact bytes before signing and the MCP execute tool runs it as a pre-flight. Covered by `wallet-mcp/test/policy.test.ts` (T-25 now expected to refuse). Still open: F-02/F-03, because anything that can rewrite the signer's code, config or state can still weaken it.*
`signer/server.ts` signs any `ProgrammableTransaction` whose sender and gas owner are the agent address, and whose approval file matches. It does not allow-list package, module, function, commands, gas budget, or `transferObjects`.
- Anything that can write an approval file can have the agent key sign "transfer the AgentCap to X" or "send all gas SUI to X".
- The signer's stated purpose (see `docs/architecture.md`) is "policy decision on exact bytes". Today the "policy" is only that a file exists.
- Mitigation by design: the vault is the real boundary. But the AgentCap is `store`, so transferring it is a valid agent-key action.

**F-02 (High, confirmed). Approval record is self-asserted.**
`demo-ui/lib/server/wallet-execution.ts` writes `policyDecision: { id, allowed: true }` itself. The signer cannot verify the passkey, so the passkey is enforced only by `executePrepared`'s in-process call. `docs/architecture.md` still says the approval producer is "not wired up", which contradicts the code. Documentation drift hides the real trust model.

**F-03 (High, confirmed). Signer isolation is nominal.**
`signer/main.ts` and `wallet-execution.ts` both require the state directory to be owned by the *current* uid. For the UI to write approvals and the signer to read them, they must run as the **same OS user**. That contradicts "signer runs under a separate OS account" (`docs/architecture.md`).
- Same user means the agent key file `.wallet/sender.json`, the signer token and the approvals directory are all readable by any process of that user, including the MCP server and anything the model can run.
- `sender.json` still exists in plaintext (mode 0600) and `src/scripts/vault.ts`, `transfer.ts`, `boundaries.ts` and `demo.ts` load it directly and sign without the signer.

**F-04 (High, confirmed). Owner key is in the local CLI keystore, same machine and user as the agent stack.**
`blockchain/owner.ts` loads every key in `~/.sui/sui_config/sui.keystore`. This is documented as a known limitation. It is the largest remaining risk: the OwnerCap holder can withdraw everything, unfreeze old packages, and disable all limits. The passkey gates the UI, not the key.

**F-05 (High, to verify on-chain). The default vault may be a legacy vault.**
`config.ts` hard-codes `DEFAULT_VAULT` (vault `0xed4a…0832`, cap `0xcacf…828d`) and falls back to it silently when env vars are unset. If that vault was made by `create`, then:
- `AgentSecurityPolicy` does not exist.
- `assert_agent_permission` and `assert_mandatory_spend_policy` return early.
- The agent can spend, stake and trade with only the per-tx limit.

Test T-07 checks this. The code should refuse to start against a vault that is not secure-mode.

### Medium

**F-06 (Medium, confirmed). Legacy `create` is still public.**
Anyone, including docs and scripts, can still create an unrestricted vault. `docs/onchain-agent-security.md` says "new integrations should call `create_secure`". Nothing enforces this. Since `create_secure` is the only safe constructor, `create` should be removed in the next package version (not possible on an already-published public function without a new package or a deprecation guard).

**F-07 (Medium, confirmed). Old-package bytecode can bypass new policy if the owner calls old `set_paused(false)`.**
Prior package versions stay callable on Sui. The design freezes them by forcing `vault.paused = true`. Owner-signed `set_paused(false)` through an **old** package ID resets `vault.paused` to false. After that, old bytecode `spend` ignores the calendar policy, blocklist and permission flags. New code fails closed (`is_paused` aborts), but the old path is live.
- `vaultConfig()` takes the package ID from env with no check that it is the latest.
- Needs an owner action (so it is a footgun, not a remote exploit).
- Test T-12 proves or refutes this.

**F-08 (Medium, confirmed). Standing trade rule: price floor is static and agent chooses the route.**
`begin_swap_auto` enforces size, epoch budget and floor, but the floor is an owner-typed number, not an oracle.
- The agent can drain `max_per_epoch` every epoch at the floor.
- A stale floor means value loss.
- The agent chooses the DEX route and keeps any surplus above `min_out` (it can route through a self-controlled pool and pocket the difference). The `Out` coin type is not checked against `allow_coin`.
- Rules do expire (`expiry_ms`), which limits exposure.

**F-09 (Medium, confirmed). One-off intents bypass budgets by design.**
`spend_approved` skips `assert_mandatory_spend_policy`, per-tx, epoch, daily and weekly caps, and the allowlist. It still enforces permission, pause, revocation and blocklist. The owner's signature is the only control.
- The UI approval shows `proposal.amountMist` and `recipient` from a JSON file in `.proposals/`.
- That file is plain JSON on disk, writable by the same user, and written by the model-reachable `propose_spend` tool.
- `decideProposal` re-reads the file and approves exactly what is stored. The passkey hash binds to the proposal content at decision time, so swapping the file between display and decision changes the hash and fails. A swap before display is still not detected.

**F-10 (Medium, confirmed). Epoch-based caps allow a double burst at epoch boundaries.**
`SpendPolicy.daily_cap` and `TradeRule.max_per_epoch` reset on epoch change. The source says so. The calendar policy (UTC day and week) adds a second limit when set, and it is mandatory in secure mode. Tests should confirm the two limits are enforced together.

**F-11 (Medium, confirmed). `web.ts` in `wallet-mcp` has no origin/host checks.**
It binds to 127.0.0.1 and exposes `/api/chat` with every MCP tool. It lacks the `rejectNonLocal` protection that `demo-ui` has, so it is open to DNS rebinding and cross-site POSTs from a browser on the same machine (a `text/plain` body is accepted because the code does not check content type). Execution is still gated by the signer and approvals, but this lets any page drive the agent to propose trades or payments. Remove it, or add the same guards.

**F-12 (Medium, confirmed). Deployment and documentation drift.**
- `Published.toml`: package `0x7e19…`, version 4.
- `docs/onchain-agent-security.md`: package `0x24e3…` "version 3", vault `0xa963…`.
- `config.ts` default vault is yet another (`0xed4a…`).

It is unclear which deployment is "the secure one". Also `docs/architecture.md` says approval publishing is unwired while the UI now does it.

### Low / Hardening

| ID | Finding | Notes |
| --- | --- | --- |
| F-13 | No events for `set_paused`, `withdraw`, `revoke_all_agents`, `issue_agent_cap`, `set_per_tx_limit`, `allow_validator`, `set_calendar_policy`, `block_recipient`, `set_agent_security_policy` (the last emits one). | Weak monitoring; an owner-side compromise would be hard to alert on. |
| F-14 | `AgentCap` has `store` and can be transferred or wrapped. No per-cap revoke, only global `revoke_all_agents`. | Revoking one agent means re-issuing every cap. |
| F-15 | `deposit_trading<T>` takes any coin type from anyone. | Dust/spam coins in the sleeve. The owner can still withdraw. The allowlist is bypassed for the sleeve. |
| F-16 | `is_paused` is `public` and aborts instead of returning `true` on inconsistent state. | Off-chain `devInspect` readers see an abort, not "paused". |
| F-17 | Stake counters (`staked_total`, `positions`) are owner-synced and ignore rewards. | Counters can drift from reality. `sync_stake_counters` trusts the caller's arithmetic. |
| F-18 | `split_coin` / `merge_coins` / `request_faucet` are always registered, and `split_coin` takes an arbitrary recipient. | Bypasses the `SUI_ENABLE_DIRECT_TRANSFER=false` guard for the gas wallet. Loss is limited to the agent's own gas balance, but the intent of the flag is defeated. |
| F-19 | `execute_approved_transaction` returns "status unknown" when submission fails, with the approval already consumed. | Safe (fails closed) but needs a documented recovery path. The user must re-approve. |
| F-20 | Signer does not check gas budget or price. | An approved transaction could burn the gas wallet through a large budget. |
| F-21 | Approvals and consumed marker use the filesystem only. | A wiped state dir (or restored backup) re-enables replays of still-valid transactions. Mitigated by the 1-epoch window and 30 s approval expiry. |
| F-22 | `.proposals/` holds 19 old proposal files (mode 0600, git-ignored). `demo-ui/.env.local` holds `ANTHROPIC_API_KEY`. | Not committed. Keep it that way. |
| F-23 | Passkey store `.passkey/` is on disk in the app directory, and approvals are in memory. | Restart clears approvals, which is acceptable. Same-user file access means the credential store (public keys, counters) can be edited. A forged approval still needs a valid WebAuthn assertion for `verifyAuthentication`. |
| F-24 | `contacts.json` has no integrity protection. | Anyone who can edit it can redirect "pay Alice". The UI shows the resolved address, but the user must read it. |

## 4. Things that are good (keep)

- Hot-potato `SwapTicket` and exact-type `Intent<In, Out>` / `AllowedCoin<T>`.
- Staking receipts stay in the vault; only the owner can unstake.
- Overflow-safe u128 math in the calendar and price floor. u64 additions in epoch counters fail closed on overflow.
- `revoke_all_agents` and the version check on every agent path.
- Signer: constant-time token compare, strict zod schemas, size limits, private-dir permission checks, single-use claim before signing, canonical-BCS check, epoch window.
- `demo-ui`: loopback host/origin checks, action-bound single-use passkey approvals, fixed script allow-list.
- Testnet-only guard (`assertTestnet`) at every signing point.

## 5. Remediation plan (priority order)

1. **Decide and document the canonical deployment** (F-05, F-12). Add a startup check in `vaultConfig()` that reads the vault on-chain and refuses to run unless `AgentSecurityPolicy` exists.
2. **Make the signer content-aware** (F-01, F-20).
   - Parse the decoded `ProgrammableTransaction`.
   - Allow only `${packageId}::spending_vault::{spend_with_clock, spend_approved, stake, begin_swap, begin_swap_auto, finish_swap}` plus allow-listed DEX calls.
   - Reject `TransferObjects` and `MakeMoveVec` of non-vault objects.
   - Cap the gas budget.
3. **Real signer isolation** (F-02, F-03). Run the signer as a different OS user. The UI submits an approval request through a narrow authenticated socket rather than writing the state directory. Move `sender.json` out of the repo and make the scripts use the signer.
4. **Move the owner key off the host** (F-04): hardware wallet or multisig. Put the UpgradeCap behind the same control.
5. **Package v5** (F-06, F-07, F-13, F-14).
   - Remove or disable `create`.
   - Add events to all owner actions.
   - Make old-package freezing independent of `set_paused` (for example by tying agent actions to a version field in the vault).
   - Consider per-agent revocation.
6. **Harden the trading rules** (F-08). Bound the `Out` coin type with `allow_coin`; consider a short rule expiry by default and an oracle or TWAP check where available.
7. **Close the small gaps**: delete or guard `web.ts` (F-11), gate `split_coin`/`merge_coins` behind the same flag (F-18), fix docs drift (F-12).

## 6. Test plan

Run Move tests with `cd my_counter && sui move test`. Wallet tests are `cd wallet-mcp && npm test` (needs a normal shell, not the sandbox). Live checks run on testnet with `demo-ui/scripts/verify-agent-security.mjs`.

### A. On-chain (Move unit tests to add, plus live checks)

| ID | Test | Expected |
| --- | --- | --- |
| T-01 | `create_secure` vault: agent calls `spend`, `spend_with_clock`, `spend_approved`, `stake`, `begin_swap`, `begin_swap_auto` with no policy set | Each aborts with `EActionDisabled` (33). Already covered by 15 security tests; add `begin_swap` standalone. |
| T-02 | Payments enabled but no calendar policy | `EMandatoryPolicy` (34) |
| T-03 | Boundary: spend exactly day cap, then +1 MIST; cross UTC midnight; cross epoch but not day | Matches the documented reset behavior. Confirms epoch cap and calendar cap are both enforced. |
| T-04 | Epoch-boundary double burst on `SpendPolicy` and `TradeRule` | Document the maximum burst (2x). Assert calendar cap still stops it in secure mode. |
| T-05 | `AgentCap` transferred to a second address | The second address can act. Document as expected or add transfer restrictions. |
| T-06 | `revoke_all_agents`, then issue a new cap | Old cap `ERevoked` on every agent function, including `spend_approved`, `begin_swap`, `begin_swap_auto`, `stake`. |
| T-07 | **Live:** read the default vault `0xed4a…0832`, check for `AgentSecurityPolicy`, `PolicyMigration`, `paused` and `agent_version`. | Establishes whether F-05 is real. |
| T-08 | Stake counters: stake, unstake a position that predates the policy, then sync | `record_unstake` never aborts; counters never underflow. |
| T-09 | `begin_swap_auto` with `rate_num` and `amount_in` at u64 extremes | `floor` overflow gives `ERateBelowFloor`, not a wrap. |
| T-10 | `deposit_trading<T>` with an arbitrary coin type, then `withdraw_trading<T>` as owner | Works for the owner only. Agent cannot withdraw. |
| T-11 | `finish_swap` with an `Out` coin from a different, worthless coin type | Does not compile or abort (typed). Confirms the `Out` type is bound by the intent or rule. |
| T-12 | **Live/local:** migrate a vault, then call old-package `set_paused(false)` as owner, then agent calls old-package `spend` | Expect either abort (F-07 refuted) or success (F-07 confirmed). Record which. |
| T-13 | `is_paused` on a vault where `vault.paused == false` but the policy exists (simulate old unpause) | New code aborts; old code behavior documented. |
| T-14 | Two simultaneous `begin_swap` for one intent in one PTB | Second fails `EIntentNotFound`. |
| T-15 | Hot-potato: PTB that calls `begin_swap` but never `finish_swap` | Transaction fails to build/execute. |

### B. Signer and MCP

| ID | Test | Expected |
| --- | --- | --- |
| T-20 | Existing `signer.test.ts` | Passes (run outside sandbox). |
| T-21 | Approval for tx A, request for tx B (different bytes) | 403 `approval_mismatch` |
| T-22 | Concurrent requests for the same proposal ID (20 at once) | Exactly one 200, the rest 409 |
| T-23 | Restart the signer between two requests for one ID | Second request 409 (consumed persists) |
| T-24 | Transaction with sender set to another address | 403 `transaction_outside_signer_scope` |
| T-25 | **Gap proof:** approved tx that calls `transferObjects` of the AgentCap | Currently **signs** (confirms F-01). Should refuse after the fix. |
| T-26 | Expired approval; epoch window `maxEpoch > minEpoch + 1` | 403 `approval_expired` / `transaction_outside_epoch_window` |
| T-27 | Wrong or missing bearer token; wrong content type; body over 192 KiB | 401 / 415 / 413 |
| T-28 | Write an approval file manually as the same OS user, then call the signer | Signs (confirms F-02/F-03). Should be impossible from the agent's user after isolation. |
| T-29 | `SUI_ENABLE_DIRECT_TRANSFER` unset: list MCP tools | `transfer_sui` absent. `split_coin` with a foreign recipient present (F-18). |
| T-30 | `wallet-mcp/src/web.ts`: POST `/api/chat` with `Origin: http://evil.example` and `Host: evil.example` | Currently accepted (F-11) |

### C. demo-ui / approval chain

| ID | Test | Expected |
| --- | --- | --- |
| T-40 | Existing UI tests (`demo-ui/test/*.test.mjs`) | Pass (run outside sandbox) |
| T-41 | Reuse a passkey `approvalId` for a second execute | Rejected |
| T-42 | Modify `.proposals/<id>.json` after the card is displayed, then approve | Hash mismatch, rejected |
| T-43 | Modify `.proposals/<id>.json` *before* the card is displayed (as the same user) | Currently approvable (F-09). Add signed or hashed proposal records. |
| T-44 | Non-loopback `Host` / `Origin`; DNS-rebinding style request | 403 from `rejectNonLocal` |
| T-45 | Recovery flow: expired, reused, and wrong recovery codes | All rejected; approvals invalidated |
| T-46 | Prompt-injection through contact names or token metadata in chat | The parser refuses unknown actions. The UI shows the resolved address and amount from the transaction tool output. |

### D. End-to-end (testnet, small amounts)

1. Fresh `create_secure` vault with all permissions off: every agent action fails with `33`.
2. Enable payments only with allowlist, calendar caps and per-tx limit: pay an allowed recipient (ok), an unlisted recipient (`14`), over the cap (`31`/`32`).
3. Pause, then spend (`1`). Unpause, then spend (ok). Revoke, then spend (`4`).
4. Propose, approve and execute a one-off spend and trade; confirm the second execution fails.
5. Stake with an unlisted validator (`5`), over the stake cap (`17`), below reserve (`18`).
6. Owner withdraw, unstake and `withdraw_trading` always work, even while paused and after `disallow_coin`.

## 7. Open questions for you

1. Which deployment is canonical: `0x7e19…` (Published.toml), `0x24e3…` (docs) or `0xed4a…` (config default)? Is any of them migrated to secure mode?
2. Is a separate OS user for the signer realistic for the demo, or should the next step be a hardware or multisig owner and an on-chain signer?
3. Do you want `create` removed in a new package version, or only guarded by documentation?
