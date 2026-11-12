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
use sui::clock::Clock;
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
const EZeroAmount: u64 = 7;
const EIntentNotFound: u64 = 8;
const EIntentExpired: u64 = 9;
const EInsufficientTrading: u64 = 10;
const EBelowMinOut: u64 = 11;
const EBadExpiry: u64 = 12;

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

// === Trading: owner-approved swaps ===
//
// The agent can never trade on its own. The owner moves funds into a "trading sleeve"
// (per-coin balances held by the vault) and posts an `Intent`: sell exactly `amount_in`
// of `In` for at least `min_out` of `Out`, before `expiry_ms`. The agent can only
// execute an existing intent, once, and picks only the route:
//
//   PTB: (coin_in, ticket) = begin_swap(..)  ->  <any DEX call>  ->  finish_swap(ticket, coin_out)
//
// `SwapTicket` has no abilities (a hot potato), so the transaction cannot end without
// `finish_swap`, which checks the output against the owner's `min_out` and puts it back
// into the vault. The agent never keeps the proceeds. The sleeve bounds the blast
// radius: the agent can only ever trade what the owner allocated to it.

/// Dynamic-field key: the vault's trading balance of coin type `T` (a `Balance<T>`).
public struct TradingKey<phantom T> has copy, drop, store {}

/// Dynamic-object-field key: an `Intent` held by the vault, found by its ID.
public struct IntentKey has copy, drop, store {
    intent_id: ID,
}

/// An owner-approved trade. Consumed when the agent executes it.
public struct Intent<phantom In, phantom Out> has key, store {
    id: UID,
    amount_in: u64,
    min_out: u64,
    expiry_ms: u64,
}

/// Hot potato returned by `begin_swap`. Only `finish_swap` can consume it.
public struct SwapTicket<phantom In, phantom Out> {
    vault_id: ID,
    intent_id: ID,
    agent_cap_id: ID,
    amount_in: u64,
    min_out: u64,
}

public struct IntentCreated<phantom In, phantom Out> has copy, drop {
    vault_id: ID,
    intent_id: ID,
    amount_in: u64,
    min_out: u64,
    expiry_ms: u64,
}

public struct IntentCancelled<phantom In, phantom Out> has copy, drop {
    vault_id: ID,
    intent_id: ID,
}

public struct Swapped<phantom In, phantom Out> has copy, drop {
    vault_id: ID,
    intent_id: ID,
    agent_cap_id: ID,
    amount_in: u64,
    amount_out: u64,
}

// --- Owner: fund and manage the trading sleeve ---

/// Move SUI from the vault's main balance into the trading sleeve.
public fun allocate_sui_to_trading(cap: &OwnerCap, vault: &mut Vault, amount: u64) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(amount > 0, EZeroAmount);
    assert!(vault.balance.value() >= amount, EInsufficientFunds);
    let taken = vault.balance.split(amount);
    trading_join<SUI>(vault, taken);
}

/// Move SUI from the trading sleeve back to the vault's main balance.
public fun release_sui_from_trading(cap: &OwnerCap, vault: &mut Vault, amount: u64) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(amount > 0, EZeroAmount);
    let taken = trading_split<SUI>(vault, amount);
    vault.balance.join(taken);
}

/// Anyone can add any coin to the trading sleeve.
public fun deposit_trading<T>(vault: &mut Vault, payment: Coin<T>) {
    trading_join<T>(vault, coin::into_balance(payment));
}

/// Take coins back out of the trading sleeve to the owner.
public fun withdraw_trading<T>(
    cap: &OwnerCap,
    vault: &mut Vault,
    amount: u64,
    ctx: &mut TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(amount > 0, EZeroAmount);
    let taken = trading_split<T>(vault, amount);
    transfer::public_transfer(coin::from_balance(taken, ctx), ctx.sender());
}

/// Approve one trade: sell exactly `amount_in` of `In` for at least `min_out` of `Out`,
/// executable by the agent until `expiry_ms`. Returns the intent's ID. Funds are not
/// locked: if the sleeve is short when the agent executes, the swap fails.
public fun create_intent<In, Out>(
    cap: &OwnerCap,
    vault: &mut Vault,
    amount_in: u64,
    min_out: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(amount_in > 0, EZeroAmount);
    assert!(min_out > 0, EZeroAmount);
    assert!(expiry_ms > clock.timestamp_ms(), EBadExpiry);

    let intent = Intent<In, Out> {
        id: object::new(ctx),
        amount_in,
        min_out,
        expiry_ms,
    };
    let intent_id = object::id(&intent);
    dof::add(&mut vault.id, IntentKey { intent_id }, intent);

    event::emit(IntentCreated<In, Out> {
        vault_id: object::id(vault),
        intent_id,
        amount_in,
        min_out,
        expiry_ms,
    });
    intent_id
}

/// Withdraw approval for a trade. Nothing needs refunding: funds never left the sleeve.
public fun cancel_intent<In, Out>(cap: &OwnerCap, vault: &mut Vault, intent_id: ID) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let key = IntentKey { intent_id };
    assert!(dof::exists_with_type<IntentKey, Intent<In, Out>>(&vault.id, key), EIntentNotFound);
    let Intent { id, amount_in: _, min_out: _, expiry_ms: _ } =
        dof::remove<IntentKey, Intent<In, Out>>(&mut vault.id, key);
    id.delete();
    event::emit(IntentCancelled<In, Out> { vault_id: object::id(vault), intent_id });
}

// --- Agent: execute an approved intent ---

/// Start executing an approved intent. Consumes the intent and returns the coins to
/// sell plus a ticket that must be handed to `finish_swap` in the same transaction.
/// Rules: right vault, cap not revoked, vault not paused, intent exists with these
/// coin types, not expired, and the sleeve holds enough.
public fun begin_swap<In, Out>(
    cap: &AgentCap,
    vault: &mut Vault,
    intent_id: ID,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<In>, SwapTicket<In, Out>) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(cap.version == vault.agent_version, ERevoked);
    assert!(!vault.paused, EPaused);

    let key = IntentKey { intent_id };
    assert!(dof::exists_with_type<IntentKey, Intent<In, Out>>(&vault.id, key), EIntentNotFound);
    let Intent { id, amount_in, min_out, expiry_ms } =
        dof::remove<IntentKey, Intent<In, Out>>(&mut vault.id, key);
    id.delete();
    assert!(clock.timestamp_ms() <= expiry_ms, EIntentExpired);

    let coin_in = coin::from_balance(trading_split<In>(vault, amount_in), ctx);
    let ticket = SwapTicket<In, Out> {
        vault_id: object::id(vault),
        intent_id,
        agent_cap_id: object::id(cap),
        amount_in,
        min_out,
    };
    (coin_in, ticket)
}

/// Finish a swap: the output must be at least the intent's `min_out`, and it is
/// deposited into the vault's trading sleeve. It must go back into the same vault
/// the ticket came from.
public fun finish_swap<In, Out>(
    ticket: SwapTicket<In, Out>,
    vault: &mut Vault,
    coin_out: Coin<Out>,
) {
    let SwapTicket { vault_id, intent_id, agent_cap_id, amount_in, min_out } = ticket;
    assert!(vault_id == object::id(vault), EWrongVault);
    let amount_out = coin_out.value();
    assert!(amount_out >= min_out, EBelowMinOut);
    trading_join<Out>(vault, coin::into_balance(coin_out));

    event::emit(Swapped<In, Out> {
        vault_id,
        intent_id,
        agent_cap_id,
        amount_in,
        amount_out,
    });
}

fun trading_join<T>(vault: &mut Vault, amount: Balance<T>) {
    let key = TradingKey<T> {};
    if (df::exists_with_type<TradingKey<T>, Balance<T>>(&vault.id, key)) {
        let existing: &mut Balance<T> = df::borrow_mut(&mut vault.id, key);
        existing.join(amount);
    } else {
        df::add(&mut vault.id, key, amount);
    };
}

fun trading_split<T>(vault: &mut Vault, amount: u64): Balance<T> {
    let key = TradingKey<T> {};
    assert!(df::exists_with_type<TradingKey<T>, Balance<T>>(&vault.id, key), EInsufficientTrading);
    let existing: &mut Balance<T> = df::borrow_mut(&mut vault.id, key);
    assert!(existing.value() >= amount, EInsufficientTrading);
    existing.split(amount)
}

// === Reads ===

/// How much of coin type `T` the trading sleeve holds.
public fun trading_balance<T>(vault: &Vault): u64 {
    let key = TradingKey<T> {};
    if (df::exists_with_type<TradingKey<T>, Balance<T>>(&vault.id, key)) {
        let existing: &Balance<T> = df::borrow(&vault.id, key);
        existing.value()
    } else {
        0
    }
}

public fun has_intent(vault: &Vault, intent_id: ID): bool {
    dof::exists(&vault.id, IntentKey { intent_id })
}

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

// --- Trading: owner-approved swaps. A mock "DEX" burns the input coin and mints the
// output coin, which is all a real DEX looks like to the vault. ---

#[test_only]
use sui::clock;

#[test_only]
public struct USDC has drop {}
#[test_only]
public struct OTHER has drop {}

#[test_only]
const EXPIRY: u64 = 10_000;

/// Owner funds the trading sleeve with `sleeve` SUI and posts an intent to sell
/// `amount_in` SUI for at least `min_out` USDC (expiring at EXPIRY). Returns its ID.
#[test_only]
fun setup_intent(s: &mut ts::Scenario, sleeve: u64, amount_in: u64, min_out: u64): ID {
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    allocate_sui_to_trading(&owner_cap, &mut vault, sleeve);
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(1_000);
    let intent_id = create_intent<SUI, USDC>(&owner_cap, &mut vault, amount_in, min_out, EXPIRY, &clk, s.ctx());
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
    intent_id
}

/// The agent executes `intent_id` at time `now_ms`; the mock DEX pays `out_amount` USDC.
#[test_only]
fun do_swap(s: &mut ts::Scenario, intent_id: ID, now_ms: u64, out_amount: u64) {
    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(now_ms);
    let (coin_in, ticket) = begin_swap<SUI, USDC>(&agent_cap, &mut vault, intent_id, &clk, s.ctx());
    let _ = coin_in.burn_for_testing();
    let coin_out = coin::mint_for_testing<USDC>(out_amount, s.ctx());
    finish_swap(ticket, &mut vault, coin_out);
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(agent_cap);
}

#[test]
fun test_swap_happy_path() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);
    do_swap(&mut s, intent_id, 2_000, 195);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(trading_balance<SUI>(&vault) == 300);
    assert!(trading_balance<USDC>(&vault) == 195);
    assert!(vault.balance() == 500);
    assert!(!has_intent(&vault, intent_id));
    ts::return_shared(vault);
    s.end();
}

#[test]
fun test_swap_pays_exactly_min_out() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);
    do_swap(&mut s, intent_id, EXPIRY, 190);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(trading_balance<USDC>(&vault) == 190);
    ts::return_shared(vault);
    s.end();
}

#[test]
fun test_swap_ignores_per_tx_limit() {
    // The per-spend limit is 100 but the owner approved a 200 swap: the intent is the bound.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 1);
    do_swap(&mut s, intent_id, 2_000, 1);
    s.end();
}

#[test, expected_failure(abort_code = EBelowMinOut)]
fun test_swap_below_min_out_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);
    do_swap(&mut s, intent_id, 2_000, 189);
    abort 999
}

#[test, expected_failure(abort_code = EIntentExpired)]
fun test_swap_after_expiry_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);
    do_swap(&mut s, intent_id, EXPIRY + 1, 195);
    abort 999
}

#[test, expected_failure(abort_code = EIntentNotFound)]
fun test_swap_unknown_intent_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let _intent_id = setup_intent(&mut s, 500, 200, 190);
    do_swap(&mut s, object::id_from_address(@0xDEAD), 2_000, 195);
    abort 999
}

#[test, expected_failure(abort_code = EIntentNotFound)]
fun test_intent_cannot_be_filled_twice() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);
    do_swap(&mut s, intent_id, 2_000, 195);
    do_swap(&mut s, intent_id, 2_000, 195);
    abort 999
}

#[test, expected_failure(abort_code = EIntentNotFound)]
fun test_swap_with_wrong_coin_types_fails() {
    // The intent is SUI -> USDC; asking for SUI -> OTHER must not match it.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    let clk = clock::create_for_testing(s.ctx());
    let (coin_in, ticket) = begin_swap<SUI, OTHER>(&agent_cap, &mut vault, intent_id, &clk, s.ctx());
    let _ = coin_in.burn_for_testing();
    finish_swap(ticket, &mut vault, coin::mint_for_testing<OTHER>(195, s.ctx()));
    abort 999
}

#[test, expected_failure(abort_code = EInsufficientTrading)]
fun test_swap_with_short_sleeve_fails() {
    // Intent sells 200 but the owner only allocated 150.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 150, 200, 190);
    do_swap(&mut s, intent_id, 2_000, 195);
    abort 999
}

#[test, expected_failure(abort_code = EInsufficientTrading)]
fun test_swap_with_empty_sleeve_fails() {
    // Nothing allocated at all: the SUI trading balance does not even exist yet.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    let clk = clock::create_for_testing(s.ctx());
    let intent_id = create_intent<SUI, USDC>(&owner_cap, &mut vault, 10, 1, EXPIRY, &clk, s.ctx());
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    do_swap(&mut s, intent_id, 2_000, 5);
    abort 999
}

#[test, expected_failure(abort_code = EPaused)]
fun test_swap_while_paused_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    set_paused(&owner_cap, &mut vault, true);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    do_swap(&mut s, intent_id, 2_000, 195);
    abort 999
}

#[test, expected_failure(abort_code = ERevoked)]
fun test_swap_after_revoke_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    revoke_all_agents(&owner_cap, &mut vault);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    do_swap(&mut s, intent_id, 2_000, 195);
    abort 999
}

#[test, expected_failure(abort_code = EIntentNotFound)]
fun test_cancelled_intent_cannot_be_filled() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    cancel_intent<SUI, USDC>(&owner_cap, &mut vault, intent_id);
    assert!(!has_intent(&vault, intent_id));
    // Cancelling moved nothing: the sleeve still holds everything.
    assert!(trading_balance<SUI>(&vault) == 500);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    do_swap(&mut s, intent_id, 2_000, 195);
    abort 999
}

#[test, expected_failure(abort_code = EZeroAmount)]
fun test_create_intent_with_zero_min_out_fails() {
    // A zero floor would let the agent hand back nothing.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let _ = setup_intent(&mut s, 500, 200, 0);
    abort 999
}

#[test, expected_failure(abort_code = EZeroAmount)]
fun test_create_intent_with_zero_amount_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let _ = setup_intent(&mut s, 500, 0, 1);
    abort 999
}

#[test, expected_failure(abort_code = EBadExpiry)]
fun test_create_intent_already_expired_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(5_000);
    create_intent<SUI, USDC>(&owner_cap, &mut vault, 10, 1, 5_000, &clk, s.ctx());
    abort 999
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_create_intent_with_other_vaults_cap_fails() {
    let mut s = ts::begin(OWNER);
    create(100, s.ctx());
    create(100, s.ctx());
    s.next_tx(OWNER);

    let mut vault_a = s.take_shared<Vault>();
    let mut vault_b = s.take_shared<Vault>();
    let cap_a = s.take_from_sender<OwnerCap>();
    let cap_b = s.take_from_sender<OwnerCap>();
    let clk = clock::create_for_testing(s.ctx());

    if (cap_a.vault_id == object::id(&vault_a)) {
        create_intent<SUI, USDC>(&cap_a, &mut vault_b, 10, 1, EXPIRY, &clk, s.ctx());
    } else {
        create_intent<SUI, USDC>(&cap_b, &mut vault_b, 10, 1, EXPIRY, &clk, s.ctx());
    };
    abort 999
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_finish_swap_into_other_vault_fails() {
    // Take funds out of vault A, try to deposit the proceeds into vault B.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = setup_intent(&mut s, 500, 200, 190);
    s.next_tx(OWNER);
    let vault_a = s.take_shared<Vault>();
    let vault_a_id = object::id(&vault_a);
    ts::return_shared(vault_a);

    create(100, s.ctx());
    s.next_tx(OWNER);
    let vault_b_id = ts::most_recent_id_shared<Vault>().destroy_some();

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault_a = s.take_shared_by_id<Vault>(vault_a_id);
    let mut vault_b = s.take_shared_by_id<Vault>(vault_b_id);
    let clk = clock::create_for_testing(s.ctx());
    let (coin_in, ticket) = begin_swap<SUI, USDC>(&agent_cap, &mut vault_a, intent_id, &clk, s.ctx());
    let _ = coin_in.burn_for_testing();
    finish_swap(ticket, &mut vault_b, coin::mint_for_testing<USDC>(195, s.ctx()));
    abort 999
}

#[test]
fun test_round_trip_requires_profit_when_min_out_exceeds_input() {
    // In == Out: the "swap" only succeeds if it ends with at least min_out.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    allocate_sui_to_trading(&owner_cap, &mut vault, 500);
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(1_000);
    let intent_id = create_intent<SUI, SUI>(&owner_cap, &mut vault, 200, 205, EXPIRY, &clk, s.ctx());
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    let clk = clock::create_for_testing(s.ctx());
    let (mut coin_in, ticket) = begin_swap<SUI, SUI>(&agent_cap, &mut vault, intent_id, &clk, s.ctx());
    // Pretend the route earned 5 extra SUI.
    coin_in.join(coin::mint_for_testing<SUI>(5, s.ctx()));
    finish_swap(ticket, &mut vault, coin_in);
    assert!(trading_balance<SUI>(&vault) == 505);
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(agent_cap);
    s.end();
}

// --- Sleeve management ---

#[test]
fun test_owner_moves_sui_in_and_out_of_sleeve() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    allocate_sui_to_trading(&owner_cap, &mut vault, 400);
    assert!(vault.balance() == 600);
    assert!(trading_balance<SUI>(&vault) == 400);
    release_sui_from_trading(&owner_cap, &mut vault, 150);
    assert!(vault.balance() == 750);
    assert!(trading_balance<SUI>(&vault) == 250);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
    s.end();
}

#[test]
fun test_owner_withdraws_from_sleeve() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    deposit_trading<USDC>(&mut vault, coin::mint_for_testing<USDC>(300, s.ctx()));
    assert!(trading_balance<USDC>(&vault) == 300);
    withdraw_trading<USDC>(&owner_cap, &mut vault, 120, s.ctx());
    assert!(trading_balance<USDC>(&vault) == 180);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    s.next_tx(OWNER);
    let received = s.take_from_sender<Coin<USDC>>();
    assert!(received.value() == 120);
    s.return_to_sender(received);
    s.end();
}

#[test, expected_failure(abort_code = EInsufficientFunds)]
fun test_allocate_more_than_main_balance_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    allocate_sui_to_trading(&owner_cap, &mut vault, 1_001);
    abort 999
}

#[test, expected_failure(abort_code = EInsufficientTrading)]
fun test_withdraw_more_than_sleeve_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    deposit_trading<USDC>(&mut vault, coin::mint_for_testing<USDC>(10, s.ctx()));
    withdraw_trading<USDC>(&owner_cap, &mut vault, 11, s.ctx());
    abort 999
}
