# End-to-end flow with the policy engine

```mermaid
sequenceDiagram
    participant U as User
    participant UI as demo-ui backend
    participant P as Passkey (WebAuthn)
    participant M as wallet-mcp (MCP)
    participant S as Signer (holds agent key)
    participant N as Sui node
    participant C as Move vault contract

    U->>UI: "send 1 SUI to 0xAlice" (or via NL -> fixed grammar)
    UI->>UI: parseWalletCommand + grounding check (closed grammar)
    UI->>M: call the one matching tool
    M->>N: read vault status (limits, policy, balance)
    M->>M: classify (direct vs needs owner approval)
    M-->>UI: unsigned tx bytes
    UI->>M: estimate_gas(bytes)  [dry run #1, for the summary]
    M->>N: simulateTransaction
    UI-->>U: approval card (summary + simulated balance changes)
    U->>P: passkey approval bound to {id, command, summary}
    P-->>UI: single-use approvalId
    UI->>M: estimate_gas(bytes) again  [dry run #2, must succeed]
    UI->>UI: derive expectation {recipient: max MIST} from the command
    UI->>S: write approvals/<id>.json {bytes, expectation, expiry 30 s}
    UI->>M: execute_approved_transaction(bytes)
    M->>M: STAGE 1 pre-flight: evaluateTransaction (static hard rules)
    M->>S: POST /sign (token, id, bytes)
    S->>S: token, approval file, byte match, expiry, sender, chain, epoch window
    S->>S: STAGE 1: evaluateTransaction on the exact bytes
    S->>N: its own dry run  [dry run #3, trusted]
    S->>S: STAGE 2: evaluateEffects (credits, agent drain, AgentCap)
    S->>S: claim consumed/<id> (single use), then sign
    S-->>M: signature
    M->>N: execute (bytes + signature)
    N->>C: Move: agent cap, version, pause, permission, policy, limits
    C-->>N: success or abort
    M-->>UI: digest + confirmation
```

## Layers, in order

| # | Layer | Type | Stops |
| --- | --- | --- | --- |
| 1 | Closed command grammar + grounding | Deterministic | Model inventing actions, recipients, amounts |
| 2 | Tool-side checks (`classifySpend`, balances, paused) | Deterministic, advisory | Obvious failures before the user is bothered |
| 3 | Dry run #1 and #2 (`estimate_gas`) | Simulation, UI side | Transactions that would fail; shows balance changes to the user |
| 4 | Passkey | Human | Approval without a person present. Not verifiable by the signer. |
| 5 | **Stage 1: `evaluateTransaction`** | Deterministic, static | Transfers, SplitCoins, other packages, owner functions, old packages, foreign objects, wrong sender or gas owner, big gas budget |
| 6 | **Stage 2: `evaluateEffects`** on the signer's own dry run | Deterministic over simulated effects | Credits to anyone but the approved recipient (or above the approved amount, or in another coin), agent wallet drained beyond gas, AgentCap moved or deleted, failed simulation |
| 7 | Signer replay protection | Deterministic | Reuse, expiry, wrong chain, wrong epoch window |
| 8 | Move contract | Final enforcement | Everything about vault limits: caps, allowlists, pause, revoke, permissions, stake and trade rules |

Layers 5 and 6 run twice in different places: Stage 1 in the MCP process (clear error) and in the signer (enforcement). Stage 2 runs only in the signer, because it needs a simulation the signer made itself.

## Fail-closed behavior

| Condition | Result |
| --- | --- |
| Stage 1 violation | `403 policy_denied` + reasons; approval not consumed |
| Stage 2 violation | `403 effects_denied` + reasons; approval not consumed |
| Node unreachable during signer dry run | `502 simulation_unavailable`; approval not consumed |
| No expectation in approval and the dry run credits anyone | `effects_denied: unexpected_credit` |

## What each approval expects

| Command | Expectation written for the signer |
| --- | --- |
| `send <amt> SUI to <addr>` | `{ <addr>: amt in MIST }` |
| `execute payment <prop>` | recipient and amount from the owner-approved proposal |
| stake, swap, other | none: the transaction must credit nobody |

## Known limits (still open)

- The expectation comes from the approval file. The signer verifies the transaction against it but cannot verify that the UI wrote the file honestly. Real isolation of the signer (separate OS user) is still F-02/F-03.
- Swap output and stakes stay inside the vault, so Stage 2 sees no credit. `min_out`, stake caps and the price floor are enforced only by the contract.
- Non-coin objects sent to other addresses are not visible in balance changes. Stage 1 blocks transfers and the vault contract only transfers coins, so this relies on that.
- The simulation can differ from execution if state changes between the dry run and inclusion. The contract is the final check.
- The signer's 5 s request timeout now covers one node simulation.
