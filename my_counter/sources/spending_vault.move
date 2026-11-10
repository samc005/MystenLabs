/// Module: spending_vault
///
/// A shared vault of SUI that an owner funds and a delegated "agent" can spend
/// from, but only within rules enforced on-chain:
///   - the agent can only send up to `per_tx_limit` per spend
///   - the owner can pause spending at any time
///   - the owner can revoke every agent permission at once
///   - the owner can always withdraw the remaining funds
///   - the agent can stake vault funds, but only with validators the owner allowed,
///     and the staking receipt stays inside the vault so only the owner can unstake
///
/// Permissions are capability objects: whoever holds the object has the power.
module my_counter::spending_vault;

use sui::balance::Balance;
use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use sui::dynamic_object_field as dof;
use sui::event;
use sui::sui::SUI;
use sui_system::staking_pool::StakedSui;
use sui_system::sui_system::{Self, SuiSystemState};

// === Errors ===
const EWrongVault: u64 = 0;
const EPaused: u64 = 1;
const EOverLimit: u64 = 2;
const EInsufficientFunds: u64 = 3;
const ERevoked: u64 = 4;
const EValidatorNotAllowed: u64 = 5;
const EStakeNotFound: u64 = 6;

// === Objects ===

/// Shared object that holds the money and the rules.
public struct Vault has key {
    id: UID,
    balance: Balance<SUI>,
    per_tx_limit: u64,
    paused: bool,
    /// Bumped by `revoke_all_agents`. Agent caps with an older version stop working.
    agent_version: u64,
    total_spent: u64,
}

/// Held by the owner. Required for every admin action.
public struct OwnerCap has key, store {
    id: UID,
    vault_id: ID,
}

/// Held by the agent's wallet. Only allows `spend`, within the vault's rules.
public struct AgentCap has key, store {
    id: UID,
    vault_id: ID,
    version: u64,
}

/// Dynamic-field key: marks a validator the agent may stake with. Stored on the vault's
/// UID so the `Vault` struct itself is unchanged (keeps the package upgrade-compatible).
public struct AllowedValidator has copy, drop, store {
    validator: address,
}

/// Dynamic-object-field key: a `StakedSui` receipt held by the vault, found by its ID.
public struct StakeKey has copy, drop, store {
    staked_sui_id: ID,
}

// === Events (so apps and explorers can see activity) ===

public struct Spent has copy, drop {
    vault_id: ID,
    agent_cap_id: ID,
    recipient: address,
    amount: u64,
}

public struct Staked has copy, drop {
    vault_id: ID,
    agent_cap_id: ID,
    validator: address,
    amount: u64,
    staked_sui_id: ID,
}

public struct Unstaked has copy, drop {
    vault_id: ID,
    staked_sui_id: ID,
    /// Principal plus rewards returned to the vault.
    amount: u64,
}

// === Owner actions ===

/// Create a vault. The vault is shared; the caller receives the `OwnerCap`.
public fun create(per_tx_limit: u64, ctx: &mut TxContext) {
    let vault = Vault {
        id: object::new(ctx),
        balance: sui::balance::zero(),
        per_tx_limit,
        paused: false,
        agent_version: 0,
        total_spent: 0,
    };
    let owner_cap = OwnerCap {
        id: object::new(ctx),
        vault_id: object::id(&vault),
    };
    transfer::share_object(vault);
    transfer::public_transfer(owner_cap, ctx.sender());
}

/// Give an address permission to spend from the vault (within its rules).
public fun issue_agent_cap(
    cap: &OwnerCap,
    vault: &Vault,
    agent: address,
    ctx: &mut TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let agent_cap = AgentCap {
        id: object::new(ctx),
        vault_id: cap.vault_id,
        version: vault.agent_version,
    };
    transfer::public_transfer(agent_cap, agent);
}

public fun set_per_tx_limit(cap: &OwnerCap, vault: &mut Vault, new_limit: u64) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    vault.per_tx_limit = new_limit;
}

public fun set_paused(cap: &OwnerCap, vault: &mut Vault, paused: bool) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    vault.paused = paused;
}

/// Invalidate every `AgentCap` issued so far. Issue new ones afterwards if needed.
public fun revoke_all_agents(cap: &OwnerCap, vault: &mut Vault) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    vault.agent_version = vault.agent_version + 1;
}

/// Take funds back out of the vault to the owner.
public fun withdraw(
    cap: &OwnerCap,
    vault: &mut Vault,
    amount: u64,
    ctx: &mut TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(vault.balance.value() >= amount, EInsufficientFunds);
    let coin = coin::take(&mut vault.balance, amount, ctx);
    transfer::public_transfer(coin, ctx.sender());
}

/// Let the agent stake with `validator`. Nothing can be staked with a validator
/// until the owner allows it here.
public fun allow_validator(cap: &OwnerCap, vault: &mut Vault, validator: address) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let key = AllowedValidator { validator };
    if (!df::exists(&vault.id, key)) {
        df::add(&mut vault.id, key, true);
    };
}

public fun disallow_validator(cap: &OwnerCap, vault: &mut Vault, validator: address) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let key = AllowedValidator { validator };
    if (df::exists(&vault.id, key)) {
        let _: bool = df::remove(&mut vault.id, key);
    };
}

/// Unstake a position the agent opened. Principal and rewards go back into the
/// vault's balance, not to the owner's wallet (use `withdraw` for that). The agent
/// cannot call this: it needs the `OwnerCap`.
public fun unstake(
    cap: &OwnerCap,
    vault: &mut Vault,
    system: &mut SuiSystemState,
    staked_sui_id: ID,
    ctx: &mut TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let key = StakeKey { staked_sui_id };
    assert!(dof::exists(&vault.id, key), EStakeNotFound);

    let staked: StakedSui = dof::remove(&mut vault.id, key);
    let returned = sui_system::request_withdraw_stake_non_entry(system, staked, ctx);
    let amount = returned.value();
    vault.balance.join(returned);

    event::emit(Unstaked { vault_id: object::id(vault), staked_sui_id, amount });
}

// === Anyone ===

/// Anyone can top up the vault.
public fun deposit(vault: &mut Vault, payment: Coin<SUI>) {
    vault.balance.join(coin::into_balance(payment));
}

// === Agent action ===

/// Send `amount` SUI from the vault to `recipient`. Enforced rules:
/// right vault, cap not revoked, vault not paused, under limit, enough funds.
public fun spend(
    cap: &AgentCap,
    vault: &mut Vault,
    recipient: address,
    amount: u64,
    ctx: &mut TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(cap.version == vault.agent_version, ERevoked);
    assert!(!vault.paused, EPaused);
    assert!(amount <= vault.per_tx_limit, EOverLimit);
    assert!(vault.balance.value() >= amount, EInsufficientFunds);

    let payment = coin::take(&mut vault.balance, amount, ctx);
    vault.total_spent = vault.total_spent + amount;

    event::emit(Spent {
        vault_id: object::id(vault),
        agent_cap_id: object::id(cap),
        recipient,
        amount,
    });

    transfer::public_transfer(payment, recipient);
}

/// Every rule `stake` enforces, separated out so it can be unit tested without a
/// live `SuiSystemState`. Note the per-spend limit does not apply to staking: the
/// funds stay in the vault's custody and only the owner can unstake them. The
/// validator allowlist is the staking rule instead.
fun assert_can_stake(cap: &AgentCap, vault: &Vault, validator: address, amount: u64) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(cap.version == vault.agent_version, ERevoked);
    assert!(!vault.paused, EPaused);
    assert!(is_validator_allowed(vault, validator), EValidatorNotAllowed);
    assert!(vault.balance.value() >= amount, EInsufficientFunds);
}

/// Stake `amount` SUI from the vault with an owner-allowed validator. The `StakedSui`
/// receipt is kept inside the vault; the agent never holds it. Sui requires at least
/// 1 SUI per stake.
public fun stake(
    cap: &AgentCap,
    vault: &mut Vault,
    system: &mut SuiSystemState,
    validator: address,
    amount: u64,
    ctx: &mut TxContext,
) {
    assert_can_stake(cap, vault, validator, amount);

    let stake_coin = coin::take(&mut vault.balance, amount, ctx);
    let staked = sui_system::request_add_stake_non_entry(system, stake_coin, validator, ctx);
    let staked_sui_id = object::id(&staked);
    dof::add(&mut vault.id, StakeKey { staked_sui_id }, staked);

    event::emit(Staked {
        vault_id: object::id(vault),
        agent_cap_id: object::id(cap),
        validator,
        amount,
        staked_sui_id,
    });
}

// === Reads ===

public fun is_validator_allowed(vault: &Vault, validator: address): bool {
    df::exists(&vault.id, AllowedValidator { validator })
}

public fun balance(vault: &Vault): u64 { vault.balance.value() }

public fun per_tx_limit(vault: &Vault): u64 { vault.per_tx_limit }

public fun total_spent(vault: &Vault): u64 { vault.total_spent }

public fun is_paused(vault: &Vault): bool { vault.paused }

// === Tests ===

#[test_only]
use sui::test_scenario as ts;

#[test_only]
const OWNER: address = @0xA;
#[test_only]
const AGENT: address = @0xB;
#[test_only]
const RECIPIENT: address = @0xC;

/// Owner creates and funds a vault with `funds` and gives AGENT a cap.
#[test_only]
fun setup(s: &mut ts::Scenario, limit: u64, funds: u64) {
    create(limit, s.ctx());
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    deposit(&mut vault, coin::mint_for_testing<SUI>(funds, s.ctx()));
    issue_agent_cap(&owner_cap, &vault, AGENT, s.ctx());
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
}

#[test]
fun test_agent_spends_within_limit() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    spend(&agent_cap, &mut vault, RECIPIENT, 60, s.ctx());
    assert!(vault.balance() == 940);
    assert!(vault.total_spent() == 60);
    ts::return_shared(vault);
    s.return_to_sender(agent_cap);

    s.next_tx(RECIPIENT);
    let received = s.take_from_sender<Coin<SUI>>();
    assert!(received.value() == 60);
    s.return_to_sender(received);
    s.end();
}

#[test, expected_failure(abort_code = EOverLimit)]
fun test_spend_over_limit_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    spend(&agent_cap, &mut vault, RECIPIENT, 101, s.ctx());
    abort 999
}

#[test, expected_failure(abort_code = EPaused)]
fun test_spend_while_paused_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    set_paused(&owner_cap, &mut vault, true);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    spend(&agent_cap, &mut vault, RECIPIENT, 10, s.ctx());
    abort 999
}

#[test, expected_failure(abort_code = ERevoked)]
fun test_spend_after_revoke_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    revoke_all_agents(&owner_cap, &mut vault);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    spend(&agent_cap, &mut vault, RECIPIENT, 10, s.ctx());
    abort 999
}

#[test, expected_failure(abort_code = EInsufficientFunds)]
fun test_spend_more_than_balance_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 5_000, 1_000);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    spend(&agent_cap, &mut vault, RECIPIENT, 2_000, s.ctx());
    abort 999
}

#[test]
fun test_owner_withdraws() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    withdraw(&owner_cap, &mut vault, 400, s.ctx());
    assert!(vault.balance() == 600);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
    s.end();
}

// --- Staking rules. `stake` itself needs a live SuiSystemState, so these test
// `assert_can_stake` (every rule `stake` enforces) and the allowlist; the real
// staking call is exercised on testnet. ---

#[test_only]
const VALIDATOR: address = @0xD;

#[test_only]
fun owner_allows_validator(s: &mut ts::Scenario, validator: address) {
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    allow_validator(&owner_cap, &mut vault, validator);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
}

#[test]
fun test_stake_allowed_validator_passes_and_ignores_per_tx_limit() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let vault = s.take_shared<Vault>();
    assert!(is_validator_allowed(&vault, VALIDATOR));
    // 900 is far over the per-spend limit of 100, but staking has no such limit.
    assert_can_stake(&agent_cap, &vault, VALIDATOR, 900);
    ts::return_shared(vault);
    s.return_to_sender(agent_cap);
    s.end();
}

#[test, expected_failure(abort_code = EValidatorNotAllowed)]
fun test_stake_unlisted_validator_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let vault = s.take_shared<Vault>();
    assert_can_stake(&agent_cap, &vault, VALIDATOR, 10);
    abort 999
}

#[test, expected_failure(abort_code = EValidatorNotAllowed)]
fun test_stake_after_disallow_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    disallow_validator(&owner_cap, &mut vault, VALIDATOR);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let vault = s.take_shared<Vault>();
    assert_can_stake(&agent_cap, &vault, VALIDATOR, 10);
    abort 999
}

#[test, expected_failure(abort_code = EPaused)]
fun test_stake_while_paused_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    set_paused(&owner_cap, &mut vault, true);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let vault = s.take_shared<Vault>();
    assert_can_stake(&agent_cap, &vault, VALIDATOR, 10);
    abort 999
}

#[test, expected_failure(abort_code = ERevoked)]
fun test_stake_after_revoke_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    revoke_all_agents(&owner_cap, &mut vault);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let vault = s.take_shared<Vault>();
    assert_can_stake(&agent_cap, &vault, VALIDATOR, 10);
    abort 999
}

#[test, expected_failure(abort_code = EInsufficientFunds)]
fun test_stake_more_than_balance_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let vault = s.take_shared<Vault>();
    assert_can_stake(&agent_cap, &vault, VALIDATOR, 1_001);
    abort 999
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_allow_validator_with_other_vaults_cap_fails() {
    let mut s = ts::begin(OWNER);
    // Two vaults, each with its own OwnerCap.
    create(100, s.ctx());
    create(100, s.ctx());
    s.next_tx(OWNER);

    let mut vault_a = s.take_shared<Vault>();
    let mut vault_b = s.take_shared<Vault>();
    let cap_a = s.take_from_sender<OwnerCap>();
    let cap_b = s.take_from_sender<OwnerCap>();

    // Pair each cap with the vault it does NOT belong to.
    if (cap_a.vault_id == object::id(&vault_a)) {
        allow_validator(&cap_a, &mut vault_b, VALIDATOR);
    } else {
        allow_validator(&cap_b, &mut vault_b, VALIDATOR);
    };
    abort 999
}
