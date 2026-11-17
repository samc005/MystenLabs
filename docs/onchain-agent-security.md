# On-chain agent security policy

The vault owns the assets. An agent signature is not unrestricted authority: Move checks the agent capability, its authorization version, the effective pause state, the owner-granted action permission and the action-specific policy before funds can move. This boundary still applies if the model, MCP server or agent signing key is compromised.

## Defaults and permissions

New integrations should call `create_secure`, not the retained legacy `create` entry point. A secure vault starts with payments, staking and trading disabled. Only the matching OwnerCap can enable or disable each category using `set_agent_security_policy`. There is no function that removes this security policy after activation.

Existing vaults require an owner-controlled migration. Installing the policy freezes both prior package generations: the original raw pause flag and the version-2 effective pause field stay true. Current code reads a new effective pause state. Owner pause/unpause preserves those barriers. Never administer a migrated vault through old package code.

| Agent operation | Required contract checks after activation |
| --- | --- |
| Direct payment | Payments enabled; spend policy present with recipient enforcement enabled; calendar policy present; recipient allowed and not blacklisted; per-payment, epoch, daily and weekly budgets; sufficient balance |
| Owner-approved payment | Payments enabled; exact, unexpired, unconsumed owner intent; blacklist, pause, revocation and custody checks. The explicit intent remains an exception to direct-payment budgets/allowlist |
| Staking | Staking enabled; stake policy present; validator allowed; configured principal, reserve and position bounds; receipt retained in vault |
| Owner-approved trade | Trading enabled; exact owner intent, expiry, input amount, output type and minimum return; proceeds retained in trading sleeve |
| Standing-rule trade | Trading enabled; exact coin-pair rule, expiry, per-trade and epoch budgets, price floor; proceeds retained in trading sleeve |
| Administration, withdrawals, unstaking | Matching OwnerCap required; not available through AgentCap |

Zero budgets deny spending. Missing mandatory policy objects do not silently authorize it. Removing a spend/stake policy prevents the corresponding delegated action. Disabling a category also blocks previously issued intents in that category. Toggling permissions does not reset usage counters.

Owner CLI examples (testnet):

    npm run owner:demo --prefix wallet-mcp -- agent-security off off off

This installs the policy and denies every agent payment, stake and trade. To enable direct payments, first configure the spend policy in allowlist mode, approve specific recipients, configure day/week budgets, then enable payments. Stake and trade permissions are separate. Owner-signed changes are explicit authority, not AI tool arguments.

## Threat model and limits

This policy constrains vault assets controlled by AgentCap. It does not prevent malware from operating other apps, taking the agent's gas balance, stealing secrets outside the vault, misleading a person, or withholding service. It cannot infer that an otherwise permitted payment is contrary to unstated user intent.

OwnerCap and package UpgradeCap are roots of authority. Malware that can use the owner's key can authorize malicious policy changes or withdrawals. For protection against malware on the agent machine, keep owner and upgrade keys on an independent hardware-backed wallet/device; the agent/UI host must not be able to read or invoke them. The current local demo has a CLI owner keystore and is not such an isolated production deployment. WebAuthn currently gates application actions and is not verified directly by Move.

Production use also requires review of the Move package and upgrade policy, the signing environment, and the exact permissions the user chooses. This implementation makes no claim to prevent every unwanted action or to secure a compromised owner device.

## Activated separate testnet deployment

The policy is active on demo vault `0xa963a3a48b259edb408320f1f262032d874d0fef6409eb8b66dce320c9578888` using package version 3 at `0x24e3bd9edfdf9284b3486ce3c96e1a68b8ebff8e688f12de12ef7ca86106ed4f`.

- Upgrade digest: `EBQfovc49XEKUpN7xWxWcq5HibykWxqVU66KNUCrS2DY`.
- Policy activation digest: `HSUtSLjexQFxoVBQJcX6dzgBpAY6kqNzcdZVLrdtVH5r`.
- Current permissions: payments **off**, staking **off**, trading **off**. Owner administration and recovery remain available.
- 151 Move tests pass, including 15 new security-policy tests. Wallet build, 3 signer/MCP tests and 22 UI/backend tests pass.
- [Live direct-contract evidence](agent-security-evidence.json) records exact Move rejection of payment, approved-payment, staking, standing-rule swap, owner-intent swap, and both prior package versions. No payment, trade or stake was submitted.

To reproduce the current deny-all checks after building wallet-mcp:

    node --env-file=demo-ui/.env.local demo-ui/scripts/verify-agent-security.mjs

Older rollout scripts expected permitted activity under the previous policy configuration. Their evidence is historical; do not enable permissions merely to make an old rehearsal pass. Enabling future activity requires explicit owner selection of both the permissions and their corresponding rules.
