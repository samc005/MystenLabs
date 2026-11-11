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
///   - optional owner-set policies tighten this further: a per-epoch spending cap, a
///     recipient allowlist, stake size / reserve / position limits, owner-approved
///     one-off spends, and standing trade rules with a price floor
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
use sui_system::staking_pool::{Self, StakedSui};
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
const EDailyCapExceeded: u64 = 13;
const ERecipientNotAllowed: u64 = 14;
const ESpendIntentNotFound: u64 = 15;
const ESpendIntentExpired: u64 = 16;
const EStakeCapExceeded: u64 = 17;
const EBelowReserve: u64 = 18;
const ETooManyPositions: u64 = 19;
const EPolicyNotSet: u64 = 20;
const ENoTradeRule: u64 = 21;
const ETradeRuleExpired: u64 = 22;
const ETradeTooLarge: u64 = 23;
const ETradeEpochCapExceeded: u64 = 24;
const ERateBelowFloor: u64 = 25;
const EBadRule: u64 = 26;

/// `SwapTicket.intent_id` for swaps run under a standing trade rule (no intent object).
const STANDING_RULE_ID: address = @0x0;
const U64_MAX: u128 = 18_446_744_073_709_551_615;

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
    record_unstake(vault, staking_pool::staked_sui_amount(&staked));
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
    // Owner-set spend policy (recipient allowlist + per-epoch cap), if configured.
    enforce_spend_policy(vault, recipient, amount, ctx);

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
    // Owner-set stake policy (size cap, liquid reserve, position limit), if configured.
    enforce_stake_policy(vault, amount);
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
    record_stake(vault, amount);

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

// === Owner policies: tighter spending, staking and standing trade rules ===
//
// Everything below is optional and off until the owner sets it, so existing vaults keep
// working unchanged. Policy state lives in dynamic fields on the vault's UID (the `Vault`
// struct itself is untouched, which keeps the package upgrade-compatible). Only the
// `OwnerCap` can change a policy; the agent's `AgentCap` cannot.
//
//   spend policy   per-epoch cap (an epoch is about 24 hours) and an optional recipient
//                  allowlist. `spend` enforces both. Anything outside them needs a
//                  `SpendIntent`: a single-use, owner-signed approval.
//   stake policy   cap on total staked, a liquid reserve that must stay in the vault, and
//                  a maximum number of open positions.
//   trade rules    per coin pair: max per trade, max per epoch, a price floor and an
//                  expiry. Inside the rule the agent swaps without a per-trade intent.
//
// The per-epoch counters use `ctx.epoch()`, so a cap resets at an epoch boundary. A
// burst across a boundary can therefore reach twice the cap in a short time.

// --- Keys and values ---

public struct SpendPolicyKey has copy, drop, store {}

public struct SpendPolicy has drop, store {
    /// Most the agent may spend through `spend` per epoch (0 blocks direct spends).
    daily_cap: u64,
    /// If true, `spend` only pays recipients added with `allow_recipient`.
    enforce_recipients: bool,
    window_epoch: u64,
    spent_in_window: u64,
}

/// Dynamic-field key: an address the agent may pay through `spend`.
public struct AllowedRecipient has copy, drop, store {
    recipient: address,
}

public struct StakePolicyKey has copy, drop, store {}

public struct StakePolicy has drop, store {
    /// Most principal that may be staked at once.
    max_staked: u64,
    /// Liquid balance that must remain in the vault after a stake.
    min_reserve: u64,
    /// Most open staking positions at once.
    max_positions: u64,
    /// Running totals kept by `stake` / `unstake`. Use `sync_stake_counters` to correct
    /// them for positions opened before the policy existed.
    staked_total: u64,
    positions: u64,
}

/// Dynamic-object-field key: a `SpendIntent` held by the vault, found by its ID.
public struct SpendIntentKey has copy, drop, store {
    intent_id: ID,
}

/// An owner-approved one-off payment. Consumed when the agent executes it.
public struct SpendIntent has key, store {
    id: UID,
    recipient: address,
    amount: u64,
    expiry_ms: u64,
}

public struct TradeRuleKey<phantom In, phantom Out> has copy, drop, store {}

/// A standing permission to sell `In` for `Out` within limits, with a price floor:
/// the agent must receive at least `amount_in * rate_num / rate_den` (rounded up).
public struct TradeRule has drop, store {
    max_per_trade: u64,
    max_per_epoch: u64,
    rate_num: u64,
    rate_den: u64,
    expiry_ms: u64,
    window_epoch: u64,
    spent_in_window: u64,
}

// --- Events ---

public struct SpendPolicySet has copy, drop {
    vault_id: ID,
    daily_cap: u64,
    enforce_recipients: bool,
}

public struct RecipientChanged has copy, drop {
    vault_id: ID,
    recipient: address,
    allowed: bool,
}

public struct StakePolicySet has copy, drop {
    vault_id: ID,
    max_staked: u64,
    min_reserve: u64,
    max_positions: u64,
}

public struct SpendIntentCreated has copy, drop {
    vault_id: ID,
    intent_id: ID,
    recipient: address,
    amount: u64,
    expiry_ms: u64,
}

public struct SpendIntentCancelled has copy, drop {
    vault_id: ID,
    intent_id: ID,
}

public struct SpendApproved has copy, drop {
    vault_id: ID,
    intent_id: ID,
    agent_cap_id: ID,
    recipient: address,
    amount: u64,
}

public struct TradeRuleSet<phantom In, phantom Out> has copy, drop {
    vault_id: ID,
    max_per_trade: u64,
    max_per_epoch: u64,
    rate_num: u64,
    rate_den: u64,
    expiry_ms: u64,
}

public struct TradeRuleRemoved<phantom In, phantom Out> has copy, drop {
    vault_id: ID,
}

// --- Owner: spend policy ---

/// Turn on (or update) the spend policy. Updating keeps the current epoch's running
/// total, so raising the cap mid-epoch does not reset what was already spent.
public fun set_spend_policy(
    cap: &OwnerCap,
    vault: &mut Vault,
    daily_cap: u64,
    enforce_recipients: bool,
    ctx: &TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    if (df::exists(&vault.id, SpendPolicyKey {})) {
        let p: &mut SpendPolicy = df::borrow_mut(&mut vault.id, SpendPolicyKey {});
        p.daily_cap = daily_cap;
        p.enforce_recipients = enforce_recipients;
    } else {
        df::add(
            &mut vault.id,
            SpendPolicyKey {},
            SpendPolicy { daily_cap, enforce_recipients, window_epoch: ctx.epoch(), spent_in_window: 0 },
        );
    };
    event::emit(SpendPolicySet { vault_id: object::id(vault), daily_cap, enforce_recipients });
}

/// Remove the spend policy: `spend` goes back to only the per-spend limit.
public fun clear_spend_policy(cap: &OwnerCap, vault: &mut Vault) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    if (df::exists(&vault.id, SpendPolicyKey {})) {
        let _: SpendPolicy = df::remove(&mut vault.id, SpendPolicyKey {});
    };
}

public fun allow_recipient(cap: &OwnerCap, vault: &mut Vault, recipient: address) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let key = AllowedRecipient { recipient };
    if (!df::exists(&vault.id, key)) {
        df::add(&mut vault.id, key, true);
    };
    event::emit(RecipientChanged { vault_id: object::id(vault), recipient, allowed: true });
}

public fun disallow_recipient(cap: &OwnerCap, vault: &mut Vault, recipient: address) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let key = AllowedRecipient { recipient };
    if (df::exists(&vault.id, key)) {
        let _: bool = df::remove(&mut vault.id, key);
    };
    event::emit(RecipientChanged { vault_id: object::id(vault), recipient, allowed: false });
}

// --- Owner: stake policy ---

/// Turn on (or update) the stake policy. Updating keeps the running counters.
public fun set_stake_policy(
    cap: &OwnerCap,
    vault: &mut Vault,
    max_staked: u64,
    min_reserve: u64,
    max_positions: u64,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    if (df::exists(&vault.id, StakePolicyKey {})) {
        let p: &mut StakePolicy = df::borrow_mut(&mut vault.id, StakePolicyKey {});
        p.max_staked = max_staked;
        p.min_reserve = min_reserve;
        p.max_positions = max_positions;
    } else {
        df::add(
            &mut vault.id,
            StakePolicyKey {},
            StakePolicy { max_staked, min_reserve, max_positions, staked_total: 0, positions: 0 },
        );
    };
    event::emit(StakePolicySet { vault_id: object::id(vault), max_staked, min_reserve, max_positions });
}

public fun clear_stake_policy(cap: &OwnerCap, vault: &mut Vault) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    if (df::exists(&vault.id, StakePolicyKey {})) {
        let _: StakePolicy = df::remove(&mut vault.id, StakePolicyKey {});
    };
}

/// Set the running stake counters, for positions opened before the policy existed.
/// Read the real values from the vault's stake receipts before calling this.
public fun sync_stake_counters(cap: &OwnerCap, vault: &mut Vault, staked_total: u64, positions: u64) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(df::exists(&vault.id, StakePolicyKey {}), EPolicyNotSet);
    let p: &mut StakePolicy = df::borrow_mut(&mut vault.id, StakePolicyKey {});
    p.staked_total = staked_total;
    p.positions = positions;
}

// --- Owner: approve a one-off spend ---

/// Approve one payment of exactly `amount` SUI to `recipient`, executable by the agent
/// until `expiry_ms`. It bypasses the per-spend limit, the per-epoch cap and the
/// recipient allowlist: the owner's signature is the approval. Returns its ID.
public fun create_spend_intent(
    cap: &OwnerCap,
    vault: &mut Vault,
    recipient: address,
    amount: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(amount > 0, EZeroAmount);
    assert!(expiry_ms > clock.timestamp_ms(), EBadExpiry);

    let intent = SpendIntent { id: object::new(ctx), recipient, amount, expiry_ms };
    let intent_id = object::id(&intent);
    dof::add(&mut vault.id, SpendIntentKey { intent_id }, intent);

    event::emit(SpendIntentCreated { vault_id: object::id(vault), intent_id, recipient, amount, expiry_ms });
    intent_id
}

public fun cancel_spend_intent(cap: &OwnerCap, vault: &mut Vault, intent_id: ID) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let key = SpendIntentKey { intent_id };
    assert!(dof::exists_with_type<SpendIntentKey, SpendIntent>(&vault.id, key), ESpendIntentNotFound);
    let SpendIntent { id, recipient: _, amount: _, expiry_ms: _ } =
        dof::remove<SpendIntentKey, SpendIntent>(&mut vault.id, key);
    id.delete();
    event::emit(SpendIntentCancelled { vault_id: object::id(vault), intent_id });
}

// --- Agent: execute an approved spend ---

/// Pay out a `SpendIntent` the owner approved. Consumes it. The recipient and amount are
/// fixed by the owner; the agent only chooses when to run it. Rules: right vault, cap not
/// revoked, vault not paused, intent exists, not expired, vault holds enough.
public fun spend_approved(
    cap: &AgentCap,
    vault: &mut Vault,
    intent_id: ID,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(cap.version == vault.agent_version, ERevoked);
    assert!(!vault.paused, EPaused);

    let key = SpendIntentKey { intent_id };
    assert!(dof::exists_with_type<SpendIntentKey, SpendIntent>(&vault.id, key), ESpendIntentNotFound);
    let SpendIntent { id, recipient, amount, expiry_ms } =
        dof::remove<SpendIntentKey, SpendIntent>(&mut vault.id, key);
    id.delete();
    assert!(clock.timestamp_ms() <= expiry_ms, ESpendIntentExpired);
    assert!(vault.balance.value() >= amount, EInsufficientFunds);

    let payment = coin::take(&mut vault.balance, amount, ctx);
    vault.total_spent = vault.total_spent + amount;

    event::emit(SpendApproved {
        vault_id: object::id(vault),
        intent_id,
        agent_cap_id: object::id(cap),
        recipient,
        amount,
    });
    transfer::public_transfer(payment, recipient);
}

// --- Owner: standing trade rules ---

/// Let the agent sell `In` for `Out` without a per-trade intent, within these limits:
/// at most `max_per_trade` per swap, `max_per_epoch` per epoch, and it must receive at
/// least `amount_in * rate_num / rate_den` (rounded up) of `Out`. Expires at `expiry_ms`.
/// Raw units on both sides. The floor is a price the owner sets, not an oracle: refresh
/// it as the market moves, or let it expire.
public fun set_trade_rule<In, Out>(
    cap: &OwnerCap,
    vault: &mut Vault,
    max_per_trade: u64,
    max_per_epoch: u64,
    rate_num: u64,
    rate_den: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(max_per_trade > 0 && max_per_epoch >= max_per_trade, EBadRule);
    assert!(rate_num > 0 && rate_den > 0, EBadRule);
    assert!(expiry_ms > clock.timestamp_ms(), EBadExpiry);

    let key = TradeRuleKey<In, Out> {};
    if (df::exists_with_type<TradeRuleKey<In, Out>, TradeRule>(&vault.id, key)) {
        // Keep the current epoch's running total, like `set_spend_policy`.
        let r: &mut TradeRule = df::borrow_mut(&mut vault.id, key);
        r.max_per_trade = max_per_trade;
        r.max_per_epoch = max_per_epoch;
        r.rate_num = rate_num;
        r.rate_den = rate_den;
        r.expiry_ms = expiry_ms;
    } else {
        df::add(
            &mut vault.id,
            key,
            TradeRule {
                max_per_trade,
                max_per_epoch,
                rate_num,
                rate_den,
                expiry_ms,
                window_epoch: ctx.epoch(),
                spent_in_window: 0,
            },
        );
    };
    event::emit(TradeRuleSet<In, Out> {
        vault_id: object::id(vault),
        max_per_trade,
        max_per_epoch,
        rate_num,
        rate_den,
        expiry_ms,
    });
}

public fun remove_trade_rule<In, Out>(cap: &OwnerCap, vault: &mut Vault) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    let key = TradeRuleKey<In, Out> {};
    if (df::exists_with_type<TradeRuleKey<In, Out>, TradeRule>(&vault.id, key)) {
        let _: TradeRule = df::remove(&mut vault.id, key);
    };
    event::emit(TradeRuleRemoved<In, Out> { vault_id: object::id(vault) });
}

// --- Agent: swap under a standing rule ---

/// Start a swap that a standing `TradeRule` allows, with no per-trade intent. The agent
/// chooses `amount_in` and `min_out`, but the rule bounds both: the size, the running
/// total for the epoch, and a price floor on `min_out`. Returns the coins to sell and a
/// ticket for `finish_swap`, exactly like `begin_swap`.
public fun begin_swap_auto<In, Out>(
    cap: &AgentCap,
    vault: &mut Vault,
    amount_in: u64,
    min_out: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<In>, SwapTicket<In, Out>) {
    assert!(cap.vault_id == object::id(vault), EWrongVault);
    assert!(cap.version == vault.agent_version, ERevoked);
    assert!(!vault.paused, EPaused);
    assert!(amount_in > 0, EZeroAmount);
    assert!(min_out > 0, EZeroAmount);

    let key = TradeRuleKey<In, Out> {};
    assert!(df::exists_with_type<TradeRuleKey<In, Out>, TradeRule>(&vault.id, key), ENoTradeRule);
    let rule: &mut TradeRule = df::borrow_mut(&mut vault.id, key);
    assert!(clock.timestamp_ms() <= rule.expiry_ms, ETradeRuleExpired);
    assert!(amount_in <= rule.max_per_trade, ETradeTooLarge);

    let epoch = ctx.epoch();
    if (rule.window_epoch != epoch) {
        rule.window_epoch = epoch;
        rule.spent_in_window = 0;
    };
    assert!(rule.spent_in_window + amount_in <= rule.max_per_epoch, ETradeEpochCapExceeded);

    // Price floor, rounded up so the owner's rate is never undercut by truncation.
    let den = (rule.rate_den as u128);
    let floor = ((amount_in as u128) * (rule.rate_num as u128) + den - 1) / den;
    assert!(floor <= U64_MAX && (min_out as u128) >= floor, ERateBelowFloor);
    rule.spent_in_window = rule.spent_in_window + amount_in;

    let coin_in = coin::from_balance(trading_split<In>(vault, amount_in), ctx);
    let ticket = SwapTicket<In, Out> {
        vault_id: object::id(vault),
        intent_id: object::id_from_address(STANDING_RULE_ID),
        agent_cap_id: object::id(cap),
        amount_in,
        min_out,
    };
    (coin_in, ticket)
}

// --- Policy enforcement helpers ---

/// Recipient allowlist and per-epoch cap for `spend`. A no-op when no policy is set.
fun enforce_spend_policy(vault: &mut Vault, recipient: address, amount: u64, ctx: &TxContext) {
    if (!df::exists(&vault.id, SpendPolicyKey {})) return;

    let enforce = {
        let p: &SpendPolicy = df::borrow(&vault.id, SpendPolicyKey {});
        p.enforce_recipients
    };
    if (enforce) {
        assert!(df::exists(&vault.id, AllowedRecipient { recipient }), ERecipientNotAllowed);
    };

    let epoch = ctx.epoch();
    let p: &mut SpendPolicy = df::borrow_mut(&mut vault.id, SpendPolicyKey {});
    if (p.window_epoch != epoch) {
        p.window_epoch = epoch;
        p.spent_in_window = 0;
    };
    assert!(p.spent_in_window + amount <= p.daily_cap, EDailyCapExceeded);
    p.spent_in_window = p.spent_in_window + amount;
}

/// Size cap, liquid reserve and position limit for `stake`. A no-op when no policy is set.
/// Callers have already checked the vault holds at least `amount`.
fun enforce_stake_policy(vault: &Vault, amount: u64) {
    if (!df::exists(&vault.id, StakePolicyKey {})) return;
    let p: &StakePolicy = df::borrow(&vault.id, StakePolicyKey {});
    assert!(p.staked_total + amount <= p.max_staked, EStakeCapExceeded);
    assert!(p.positions + 1 <= p.max_positions, ETooManyPositions);
    assert!(vault.balance.value() - amount >= p.min_reserve, EBelowReserve);
}

fun record_stake(vault: &mut Vault, amount: u64) {
    if (!df::exists(&vault.id, StakePolicyKey {})) return;
    let p: &mut StakePolicy = df::borrow_mut(&mut vault.id, StakePolicyKey {});
    p.staked_total = p.staked_total + amount;
    p.positions = p.positions + 1;
}

/// Never aborts: a position opened before the policy existed is not in the counters, and
/// the owner must always be able to unstake it.
fun record_unstake(vault: &mut Vault, principal: u64) {
    if (!df::exists(&vault.id, StakePolicyKey {})) return;
    let p: &mut StakePolicy = df::borrow_mut(&mut vault.id, StakePolicyKey {});
    p.staked_total = if (p.staked_total >= principal) { p.staked_total - principal } else { 0 };
    p.positions = if (p.positions >= 1) { p.positions - 1 } else { 0 };
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

public fun is_recipient_allowed(vault: &Vault, recipient: address): bool {
    df::exists(&vault.id, AllowedRecipient { recipient })
}

public fun has_spend_intent(vault: &Vault, intent_id: ID): bool {
    dof::exists(&vault.id, SpendIntentKey { intent_id })
}

public fun has_trade_rule<In, Out>(vault: &Vault): bool {
    df::exists_with_type<TradeRuleKey<In, Out>, TradeRule>(&vault.id, TradeRuleKey<In, Out> {})
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

// === Tests: owner policies ===

#[test_only]
fun owner_sets_spend_policy(s: &mut ts::Scenario, daily_cap: u64, enforce: bool) {
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    set_spend_policy(&owner_cap, &mut vault, daily_cap, enforce, s.ctx());
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
}

#[test_only]
fun owner_allows_recipient(s: &mut ts::Scenario, recipient: address) {
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    allow_recipient(&owner_cap, &mut vault, recipient);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
}

#[test_only]
fun agent_spends(s: &mut ts::Scenario, recipient: address, amount: u64) {
    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    spend(&agent_cap, &mut vault, recipient, amount, s.ctx());
    ts::return_shared(vault);
    s.return_to_sender(agent_cap);
}

#[test_only]
fun spent_in_window(vault: &Vault): u64 {
    let p: &SpendPolicy = df::borrow(&vault.id, SpendPolicyKey {});
    p.spent_in_window
}

#[test_only]
fun next_epoch(s: &mut ts::Scenario) {
    let _ = ts::next_epoch(s, OWNER);
}

// --- Spend policy: per-epoch cap ---

#[test]
fun test_spend_cap_allows_spending_up_to_the_cap() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 150, false);
    agent_spends(&mut s, RECIPIENT, 100);
    agent_spends(&mut s, RECIPIENT, 50); // exactly 150

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(spent_in_window(&vault) == 150);
    assert!(vault.balance() == 850);
    ts::return_shared(vault);
    s.end();
}

#[test, expected_failure(abort_code = EDailyCapExceeded)]
fun test_spend_over_the_cap_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 150, false);
    agent_spends(&mut s, RECIPIENT, 100);
    agent_spends(&mut s, RECIPIENT, 51);
    abort 999
}

#[test, expected_failure(abort_code = EDailyCapExceeded)]
fun test_many_small_spends_cannot_drain_past_the_cap() {
    // The per-spend limit alone would allow this forever; the cap stops it.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 250, false);
    agent_spends(&mut s, RECIPIENT, 100);
    agent_spends(&mut s, RECIPIENT, 100);
    agent_spends(&mut s, RECIPIENT, 50);
    agent_spends(&mut s, RECIPIENT, 1);
    abort 999
}

#[test]
fun test_spend_cap_resets_next_epoch() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 150, false);
    agent_spends(&mut s, RECIPIENT, 100);
    agent_spends(&mut s, RECIPIENT, 50);
    next_epoch(&mut s);
    agent_spends(&mut s, RECIPIENT, 100);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(spent_in_window(&vault) == 100);
    ts::return_shared(vault);
    s.end();
}

#[test, expected_failure(abort_code = EDailyCapExceeded)]
fun test_zero_cap_blocks_direct_spends() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 0, false);
    agent_spends(&mut s, RECIPIENT, 1);
    abort 999
}

#[test]
fun test_raising_the_cap_keeps_what_was_already_spent() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 100, false);
    agent_spends(&mut s, RECIPIENT, 100);
    owner_sets_spend_policy(&mut s, 150, false);
    agent_spends(&mut s, RECIPIENT, 50);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(spent_in_window(&vault) == 150);
    ts::return_shared(vault);
    s.end();
}

#[test, expected_failure(abort_code = EDailyCapExceeded)]
fun test_raising_the_cap_does_not_reset_the_window() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 100, false);
    agent_spends(&mut s, RECIPIENT, 100);
    owner_sets_spend_policy(&mut s, 150, false);
    agent_spends(&mut s, RECIPIENT, 51);
    abort 999
}

#[test, expected_failure(abort_code = EDailyCapExceeded)]
fun test_lowering_the_cap_below_spent_blocks_further_spends() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 200, false);
    agent_spends(&mut s, RECIPIENT, 100);
    owner_sets_spend_policy(&mut s, 50, false);
    agent_spends(&mut s, RECIPIENT, 1);
    abort 999
}

#[test]
fun test_clearing_the_spend_policy_restores_plain_limit() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 0, true);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    clear_spend_policy(&owner_cap, &mut vault);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_spends(&mut s, RECIPIENT, 100);
    s.end();
}

#[test, expected_failure(abort_code = EOverLimit)]
fun test_per_spend_limit_still_applies_under_a_cap() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 10_000, false);
    agent_spends(&mut s, RECIPIENT, 101);
    abort 999
}

// --- Spend policy: recipient allowlist ---

#[test, expected_failure(abort_code = ERecipientNotAllowed)]
fun test_spend_to_unlisted_recipient_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 500, true);
    agent_spends(&mut s, RECIPIENT, 10);
    abort 999
}

#[test]
fun test_spend_to_allowed_recipient_works() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 500, true);
    owner_allows_recipient(&mut s, RECIPIENT);
    agent_spends(&mut s, RECIPIENT, 10);

    s.next_tx(RECIPIENT);
    let received = s.take_from_sender<Coin<SUI>>();
    assert!(received.value() == 10);
    s.return_to_sender(received);
    s.end();
}

#[test, expected_failure(abort_code = ERecipientNotAllowed)]
fun test_spend_after_recipient_removed_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 500, true);
    owner_allows_recipient(&mut s, RECIPIENT);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    assert!(is_recipient_allowed(&vault, RECIPIENT));
    disallow_recipient(&owner_cap, &mut vault, RECIPIENT);
    assert!(!is_recipient_allowed(&vault, RECIPIENT));
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_spends(&mut s, RECIPIENT, 10);
    abort 999
}

#[test]
fun test_any_recipient_works_when_allowlist_not_enforced() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 500, false);
    agent_spends(&mut s, @0x123, 10);
    s.end();
}

#[test, expected_failure(abort_code = EDailyCapExceeded)]
fun test_allowed_recipient_is_still_subject_to_the_cap() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_spend_policy(&mut s, 50, true);
    owner_allows_recipient(&mut s, RECIPIENT);
    agent_spends(&mut s, RECIPIENT, 51);
    abort 999
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_spend_policy_with_other_vaults_cap_fails() {
    let mut s = ts::begin(OWNER);
    create(100, s.ctx());
    create(100, s.ctx());
    s.next_tx(OWNER);
    let mut vault_a = s.take_shared<Vault>();
    let mut vault_b = s.take_shared<Vault>();
    let cap_a = s.take_from_sender<OwnerCap>();
    let cap_b = s.take_from_sender<OwnerCap>();
    if (cap_a.vault_id == object::id(&vault_a)) {
        set_spend_policy(&cap_a, &mut vault_b, 1, true, s.ctx());
    } else {
        set_spend_policy(&cap_b, &mut vault_b, 1, true, s.ctx());
    };
    abort 999
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_allow_recipient_with_other_vaults_cap_fails() {
    let mut s = ts::begin(OWNER);
    create(100, s.ctx());
    create(100, s.ctx());
    s.next_tx(OWNER);
    let mut vault_a = s.take_shared<Vault>();
    let mut vault_b = s.take_shared<Vault>();
    let cap_a = s.take_from_sender<OwnerCap>();
    let cap_b = s.take_from_sender<OwnerCap>();
    if (cap_a.vault_id == object::id(&vault_a)) {
        allow_recipient(&cap_a, &mut vault_b, RECIPIENT);
    } else {
        allow_recipient(&cap_b, &mut vault_b, RECIPIENT);
    };
    abort 999
}

// --- Owner-approved one-off spends ---

#[test_only]
fun owner_approves_spend(s: &mut ts::Scenario, recipient: address, amount: u64, expiry_ms: u64): ID {
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(1_000);
    let intent_id = create_spend_intent(&owner_cap, &mut vault, recipient, amount, expiry_ms, &clk, s.ctx());
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
    intent_id
}

#[test_only]
fun agent_runs_spend(s: &mut ts::Scenario, intent_id: ID, now_ms: u64) {
    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(now_ms);
    spend_approved(&agent_cap, &mut vault, intent_id, &clk, s.ctx());
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(agent_cap);
}

#[test]
fun test_approved_spend_goes_past_limit_cap_and_allowlist() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    // Tight policy: cap 10, only listed recipients. The approval overrides all of it.
    owner_sets_spend_policy(&mut s, 10, true);
    let intent_id = owner_approves_spend(&mut s, RECIPIENT, 500, EXPIRY);
    agent_runs_spend(&mut s, intent_id, 2_000);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(vault.balance() == 500);
    assert!(vault.total_spent() == 500);
    assert!(!has_spend_intent(&vault, intent_id));
    // The one-off payment does not eat into the per-epoch cap.
    assert!(spent_in_window(&vault) == 0);
    ts::return_shared(vault);

    s.next_tx(RECIPIENT);
    let received = s.take_from_sender<Coin<SUI>>();
    assert!(received.value() == 500);
    s.return_to_sender(received);
    s.end();
}

#[test]
fun test_approved_spend_pays_the_owners_recipient_and_amount() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = owner_approves_spend(&mut s, @0x123, 7, EXPIRY);
    agent_runs_spend(&mut s, intent_id, EXPIRY); // exactly at expiry still works

    s.next_tx(@0x123);
    let received = s.take_from_sender<Coin<SUI>>();
    assert!(received.value() == 7);
    s.return_to_sender(received);
    s.end();
}

#[test, expected_failure(abort_code = ESpendIntentNotFound)]
fun test_approved_spend_cannot_run_twice() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = owner_approves_spend(&mut s, RECIPIENT, 50, EXPIRY);
    agent_runs_spend(&mut s, intent_id, 2_000);
    agent_runs_spend(&mut s, intent_id, 2_000);
    abort 999
}

#[test, expected_failure(abort_code = ESpendIntentExpired)]
fun test_approved_spend_after_expiry_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = owner_approves_spend(&mut s, RECIPIENT, 50, EXPIRY);
    agent_runs_spend(&mut s, intent_id, EXPIRY + 1);
    abort 999
}

#[test, expected_failure(abort_code = ESpendIntentNotFound)]
fun test_unapproved_spend_intent_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    agent_runs_spend(&mut s, object::id_from_address(@0x123), 2_000);
    abort 999
}

#[test, expected_failure(abort_code = ESpendIntentNotFound)]
fun test_cancelled_spend_intent_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = owner_approves_spend(&mut s, RECIPIENT, 50, EXPIRY);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    assert!(has_spend_intent(&vault, intent_id));
    cancel_spend_intent(&owner_cap, &mut vault, intent_id);
    assert!(!has_spend_intent(&vault, intent_id));
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_runs_spend(&mut s, intent_id, 2_000);
    abort 999
}

#[test, expected_failure(abort_code = ESpendIntentNotFound)]
fun test_cancel_unknown_spend_intent_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    cancel_spend_intent(&owner_cap, &mut vault, object::id_from_address(@0x123));
    abort 999
}

#[test, expected_failure(abort_code = EInsufficientFunds)]
fun test_approved_spend_with_empty_vault_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = owner_approves_spend(&mut s, RECIPIENT, 2_000, EXPIRY);
    agent_runs_spend(&mut s, intent_id, 2_000);
    abort 999
}

#[test, expected_failure(abort_code = EPaused)]
fun test_approved_spend_while_paused_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = owner_approves_spend(&mut s, RECIPIENT, 50, EXPIRY);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    set_paused(&owner_cap, &mut vault, true);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_runs_spend(&mut s, intent_id, 2_000);
    abort 999
}

#[test, expected_failure(abort_code = ERevoked)]
fun test_approved_spend_after_revoke_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let intent_id = owner_approves_spend(&mut s, RECIPIENT, 50, EXPIRY);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    revoke_all_agents(&owner_cap, &mut vault);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_runs_spend(&mut s, intent_id, 2_000);
    abort 999
}

#[test, expected_failure(abort_code = EZeroAmount)]
fun test_zero_amount_spend_intent_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let _ = owner_approves_spend(&mut s, RECIPIENT, 0, EXPIRY);
    abort 999
}

#[test, expected_failure(abort_code = EBadExpiry)]
fun test_spend_intent_already_expired_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    let _ = owner_approves_spend(&mut s, RECIPIENT, 50, 1_000); // clock is 1_000: not in the future
    abort 999
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_spend_intent_with_other_vaults_cap_fails() {
    let mut s = ts::begin(OWNER);
    create(100, s.ctx());
    create(100, s.ctx());
    s.next_tx(OWNER);
    let mut vault_a = s.take_shared<Vault>();
    let mut vault_b = s.take_shared<Vault>();
    let cap_a = s.take_from_sender<OwnerCap>();
    let cap_b = s.take_from_sender<OwnerCap>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(1_000);
    if (cap_a.vault_id == object::id(&vault_a)) {
        let _ = create_spend_intent(&cap_a, &mut vault_b, RECIPIENT, 5, EXPIRY, &clk, s.ctx());
    } else {
        let _ = create_spend_intent(&cap_b, &mut vault_b, RECIPIENT, 5, EXPIRY, &clk, s.ctx());
    };
    abort 999
}

// --- Stake policy. `stake` needs a live SuiSystemState, so these test `assert_can_stake`
// plus the counter helpers `stake` / `unstake` call. ---

#[test_only]
fun owner_sets_stake_policy(s: &mut ts::Scenario, max_staked: u64, reserve: u64, max_positions: u64) {
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    set_stake_policy(&owner_cap, &mut vault, max_staked, reserve, max_positions);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
}

/// Runs `assert_can_stake` as the agent, then records `record_amount` as staked (if > 0),
/// the way `stake` does after the checks pass.
#[test_only]
fun agent_checks_stake(s: &mut ts::Scenario, amount: u64) {
    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let vault = s.take_shared<Vault>();
    assert_can_stake(&agent_cap, &vault, VALIDATOR, amount);
    ts::return_shared(vault);
    s.return_to_sender(agent_cap);
}

#[test_only]
fun record_stake_as_owner(s: &mut ts::Scenario, amount: u64) {
    s.next_tx(OWNER);
    let mut vault = s.take_shared<Vault>();
    record_stake(&mut vault, amount);
    ts::return_shared(vault);
}

#[test_only]
fun stake_counters(vault: &Vault): (u64, u64) {
    let p: &StakePolicy = df::borrow(&vault.id, StakePolicyKey {});
    (p.staked_total, p.positions)
}

#[test]
fun test_stake_up_to_the_cap_passes() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 500, 0, 5);
    agent_checks_stake(&mut s, 500);
    s.end();
}

#[test, expected_failure(abort_code = EStakeCapExceeded)]
fun test_stake_over_the_cap_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 500, 0, 5);
    agent_checks_stake(&mut s, 501);
    abort 999
}

#[test, expected_failure(abort_code = EStakeCapExceeded)]
fun test_second_stake_counts_against_the_cap() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 500, 0, 5);
    record_stake_as_owner(&mut s, 300);
    agent_checks_stake(&mut s, 201);
    abort 999
}

#[test]
fun test_second_stake_up_to_the_remaining_cap_passes() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 500, 0, 5);
    record_stake_as_owner(&mut s, 300);
    agent_checks_stake(&mut s, 200);
    s.end();
}

#[test]
fun test_stake_leaving_exactly_the_reserve_passes() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 10_000, 200, 5);
    agent_checks_stake(&mut s, 800);
    s.end();
}

#[test, expected_failure(abort_code = EBelowReserve)]
fun test_stake_dipping_into_the_reserve_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 10_000, 200, 5);
    agent_checks_stake(&mut s, 801);
    abort 999
}

#[test, expected_failure(abort_code = EInsufficientFunds)]
fun test_stake_more_than_balance_fails_before_reserve_math() {
    // Must abort cleanly with EInsufficientFunds, not underflow in the reserve check.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 10_000, 200, 5);
    agent_checks_stake(&mut s, 1_001);
    abort 999
}

#[test, expected_failure(abort_code = ETooManyPositions)]
fun test_stake_beyond_the_position_limit_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 10_000, 0, 2);
    record_stake_as_owner(&mut s, 10);
    record_stake_as_owner(&mut s, 10);
    agent_checks_stake(&mut s, 10);
    abort 999
}

#[test]
fun test_stake_counters_track_stakes_and_unstakes() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_stake_policy(&mut s, 10_000, 0, 5);
    record_stake_as_owner(&mut s, 300);
    record_stake_as_owner(&mut s, 200);

    s.next_tx(OWNER);
    let mut vault = s.take_shared<Vault>();
    let (total, positions) = stake_counters(&vault);
    assert!(total == 500 && positions == 2);
    record_unstake(&mut vault, 300);
    let (total, positions) = stake_counters(&vault);
    assert!(total == 200 && positions == 1);
    ts::return_shared(vault);
    s.end();
}

#[test]
fun test_unstaking_an_untracked_position_never_aborts() {
    // A position opened before the policy existed is not in the counters. The owner must
    // still be able to unstake it, so the counters floor at zero instead of underflowing.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_stake_policy(&mut s, 10_000, 0, 5);

    s.next_tx(OWNER);
    let mut vault = s.take_shared<Vault>();
    record_unstake(&mut vault, 1_000_000_000);
    let (total, positions) = stake_counters(&vault);
    assert!(total == 0 && positions == 0);
    ts::return_shared(vault);
    s.end();
}

#[test]
fun test_counter_helpers_are_no_ops_without_a_policy() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    s.next_tx(OWNER);
    let mut vault = s.take_shared<Vault>();
    record_stake(&mut vault, 500);
    record_unstake(&mut vault, 500);
    assert!(!df::exists(&vault.id, StakePolicyKey {}));
    ts::return_shared(vault);
    s.end();
}

#[test, expected_failure(abort_code = ETooManyPositions)]
fun test_sync_counters_account_for_existing_positions() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 10_000, 0, 2);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    sync_stake_counters(&owner_cap, &mut vault, 50, 2);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_checks_stake(&mut s, 10);
    abort 999
}

#[test, expected_failure(abort_code = EPolicyNotSet)]
fun test_sync_counters_without_a_policy_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    sync_stake_counters(&owner_cap, &mut vault, 1, 1);
    abort 999
}

#[test]
fun test_updating_the_stake_policy_keeps_counters() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_stake_policy(&mut s, 500, 0, 5);
    record_stake_as_owner(&mut s, 300);
    owner_sets_stake_policy(&mut s, 900, 50, 7);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    let (total, positions) = stake_counters(&vault);
    assert!(total == 300 && positions == 1);
    ts::return_shared(vault);
    s.end();
}

#[test]
fun test_clearing_the_stake_policy_removes_the_limits() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_allows_validator(&mut s, VALIDATOR);
    owner_sets_stake_policy(&mut s, 1, 1_000, 0);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    clear_stake_policy(&owner_cap, &mut vault);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_checks_stake(&mut s, 900);
    s.end();
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_stake_policy_with_other_vaults_cap_fails() {
    let mut s = ts::begin(OWNER);
    create(100, s.ctx());
    create(100, s.ctx());
    s.next_tx(OWNER);
    let mut vault_a = s.take_shared<Vault>();
    let mut vault_b = s.take_shared<Vault>();
    let cap_a = s.take_from_sender<OwnerCap>();
    let cap_b = s.take_from_sender<OwnerCap>();
    if (cap_a.vault_id == object::id(&vault_a)) {
        set_stake_policy(&cap_a, &mut vault_b, 1, 1, 1);
    } else {
        set_stake_policy(&cap_b, &mut vault_b, 1, 1, 1);
    };
    abort 999
}

#[test, expected_failure(abort_code = EValidatorNotAllowed)]
fun test_stake_policy_does_not_replace_the_validator_allowlist() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_stake_policy(&mut s, 10_000, 0, 5);
    agent_checks_stake(&mut s, 10); // VALIDATOR was never allowed
    abort 999
}

// --- Standing trade rules ---

#[test_only]
fun owner_funds_sleeve(s: &mut ts::Scenario, amount: u64) {
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    allocate_sui_to_trading(&owner_cap, &mut vault, amount);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
}

/// Owner sets a SUI -> USDC rule expiring at EXPIRY.
#[test_only]
fun owner_sets_rule(s: &mut ts::Scenario, max_trade: u64, max_epoch: u64, num: u64, den: u64) {
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(1_000);
    set_trade_rule<SUI, USDC>(&owner_cap, &mut vault, max_trade, max_epoch, num, den, EXPIRY, &clk, s.ctx());
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);
}

/// The agent swaps `amount_in` SUI under the standing rule, asking for `min_out`, at time
/// `now_ms`; the mock DEX pays `out_amount` USDC.
#[test_only]
fun agent_auto_swap(s: &mut ts::Scenario, amount_in: u64, min_out: u64, now_ms: u64, out_amount: u64) {
    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(now_ms);
    let (coin_in, ticket) =
        begin_swap_auto<SUI, USDC>(&agent_cap, &mut vault, amount_in, min_out, &clk, s.ctx());
    let _ = coin_in.burn_for_testing();
    finish_swap(ticket, &mut vault, coin::mint_for_testing<USDC>(out_amount, s.ctx()));
    clk.destroy_for_testing();
    ts::return_shared(vault);
    s.return_to_sender(agent_cap);
}

#[test_only]
fun rule_spent(vault: &Vault): u64 {
    let r: &TradeRule = df::borrow(&vault.id, TradeRuleKey<SUI, USDC> {});
    r.spent_in_window
}

#[test]
fun test_auto_swap_happy_path() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 205);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(has_trade_rule<SUI, USDC>(&vault));
    assert!(trading_balance<SUI>(&vault) == 400);
    assert!(trading_balance<USDC>(&vault) == 205);
    assert!(rule_spent(&vault) == 100);
    ts::return_shared(vault);
    s.end();
}

#[test]
fun test_auto_swap_at_exactly_the_floor_passes() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    s.end();
}

#[test, expected_failure(abort_code = ERateBelowFloor)]
fun test_auto_swap_asking_below_the_floor_fails() {
    // The agent picks min_out, so the floor is what stops it asking for almost nothing.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 199, 2_000, 199);
    abort 999
}

#[test, expected_failure(abort_code = ERateBelowFloor)]
fun test_auto_swap_asking_for_one_unit_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 1, 2_000, 1);
    abort 999
}

#[test]
fun test_floor_rounds_up_in_the_owners_favour() {
    // Rate 1/3, selling 10: the exact floor is 3.33, so 4 is required.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 1, 3);
    agent_auto_swap(&mut s, 10, 4, 2_000, 4);
    s.end();
}

#[test, expected_failure(abort_code = ERateBelowFloor)]
fun test_floor_does_not_round_down() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 1, 3);
    agent_auto_swap(&mut s, 10, 3, 2_000, 3);
    abort 999
}

#[test, expected_failure(abort_code = EBelowMinOut)]
fun test_auto_swap_output_below_the_agents_min_out_fails() {
    // The ticket still enforces min_out in finish_swap: a bad pool cannot underpay.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 199);
    abort 999
}

#[test, expected_failure(abort_code = ETradeTooLarge)]
fun test_auto_swap_over_the_per_trade_max_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 101, 202, 2_000, 202);
    abort 999
}

#[test]
fun test_auto_swaps_up_to_the_epoch_cap_pass() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    agent_auto_swap(&mut s, 50, 100, 2_000, 100);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(rule_spent(&vault) == 250);
    ts::return_shared(vault);
    s.end();
}

#[test, expected_failure(abort_code = ETradeEpochCapExceeded)]
fun test_auto_swaps_past_the_epoch_cap_fail() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    agent_auto_swap(&mut s, 51, 102, 2_000, 102);
    abort 999
}

#[test]
fun test_epoch_cap_resets_next_epoch() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    next_epoch(&mut s);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(rule_spent(&vault) == 100);
    ts::return_shared(vault);
    s.end();
}

#[test, expected_failure(abort_code = ETradeRuleExpired)]
fun test_auto_swap_after_the_rule_expires_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, EXPIRY + 1, 200);
    abort 999
}

#[test]
fun test_auto_swap_exactly_at_expiry_passes() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, EXPIRY, 200);
    s.end();
}

#[test, expected_failure(abort_code = ENoTradeRule)]
fun test_auto_swap_without_a_rule_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    abort 999
}

#[test, expected_failure(abort_code = ENoTradeRule)]
fun test_rule_for_one_pair_does_not_cover_another() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1); // SUI -> USDC only

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(2_000);
    let (_coin, _ticket) =
        begin_swap_auto<SUI, OTHER>(&agent_cap, &mut vault, 10, 20, &clk, s.ctx());
    abort 999
}

#[test, expected_failure(abort_code = ENoTradeRule)]
fun test_rule_does_not_cover_the_reverse_direction() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1); // SUI -> USDC only

    s.next_tx(AGENT);
    let agent_cap = s.take_from_sender<AgentCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(2_000);
    let (_coin, _ticket) =
        begin_swap_auto<USDC, SUI>(&agent_cap, &mut vault, 10, 5, &clk, s.ctx());
    abort 999
}

#[test, expected_failure(abort_code = ENoTradeRule)]
fun test_removed_rule_stops_auto_swaps() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    remove_trade_rule<SUI, USDC>(&owner_cap, &mut vault);
    assert!(!has_trade_rule<SUI, USDC>(&vault));
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_auto_swap(&mut s, 10, 20, 2_000, 20);
    abort 999
}

#[test, expected_failure(abort_code = EInsufficientTrading)]
fun test_auto_swap_cannot_exceed_the_sleeve() {
    // The rule allows 100 but the owner only put 50 in the sleeve: the sleeve is the bound.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 50);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    abort 999
}

#[test, expected_failure(abort_code = EZeroAmount)]
fun test_auto_swap_zero_amount_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 0, 1, 2_000, 1);
    abort 999
}

#[test, expected_failure(abort_code = EZeroAmount)]
fun test_auto_swap_zero_min_out_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 10, 0, 2_000, 0);
    abort 999
}

#[test, expected_failure(abort_code = EPaused)]
fun test_auto_swap_while_paused_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    set_paused(&owner_cap, &mut vault, true);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_auto_swap(&mut s, 10, 20, 2_000, 20);
    abort 999
}

#[test, expected_failure(abort_code = ERevoked)]
fun test_auto_swap_after_revoke_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);

    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    revoke_all_agents(&owner_cap, &mut vault);
    ts::return_shared(vault);
    s.return_to_sender(owner_cap);

    agent_auto_swap(&mut s, 10, 20, 2_000, 20);
    abort 999
}

#[test]
fun test_updating_a_rule_keeps_the_epoch_total() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200);
    owner_sets_rule(&mut s, 100, 300, 3, 1); // raise the cap and the floor

    s.next_tx(OWNER);
    let vault = s.take_shared<Vault>();
    assert!(rule_spent(&vault) == 100);
    ts::return_shared(vault);

    agent_auto_swap(&mut s, 100, 300, 2_000, 300); // new floor 3 per unit
    s.end();
}

#[test, expected_failure(abort_code = ERateBelowFloor)]
fun test_updated_floor_applies_immediately() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_funds_sleeve(&mut s, 500);
    owner_sets_rule(&mut s, 100, 250, 2, 1);
    owner_sets_rule(&mut s, 100, 250, 3, 1);
    agent_auto_swap(&mut s, 100, 200, 2_000, 200); // old floor no longer enough
    abort 999
}

#[test, expected_failure(abort_code = EBadRule)]
fun test_rule_with_epoch_cap_below_trade_max_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_rule(&mut s, 100, 99, 2, 1);
    abort 999
}

#[test, expected_failure(abort_code = EBadRule)]
fun test_rule_with_zero_rate_numerator_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_rule(&mut s, 100, 250, 0, 1);
    abort 999
}

#[test, expected_failure(abort_code = EBadRule)]
fun test_rule_with_zero_rate_denominator_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_rule(&mut s, 100, 250, 1, 0);
    abort 999
}

#[test, expected_failure(abort_code = EBadRule)]
fun test_rule_with_zero_trade_max_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    owner_sets_rule(&mut s, 0, 0, 2, 1);
    abort 999
}

#[test, expected_failure(abort_code = EBadExpiry)]
fun test_rule_that_is_already_expired_fails() {
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault = s.take_shared<Vault>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(5_000);
    set_trade_rule<SUI, USDC>(&owner_cap, &mut vault, 10, 10, 1, 1, 5_000, &clk, s.ctx());
    abort 999
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_trade_rule_with_other_vaults_cap_fails() {
    let mut s = ts::begin(OWNER);
    create(100, s.ctx());
    create(100, s.ctx());
    s.next_tx(OWNER);
    let mut vault_a = s.take_shared<Vault>();
    let mut vault_b = s.take_shared<Vault>();
    let cap_a = s.take_from_sender<OwnerCap>();
    let cap_b = s.take_from_sender<OwnerCap>();
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(1_000);
    if (cap_a.vault_id == object::id(&vault_a)) {
        set_trade_rule<SUI, USDC>(&cap_a, &mut vault_b, 10, 10, 1, 1, EXPIRY, &clk, s.ctx());
    } else {
        set_trade_rule<SUI, USDC>(&cap_b, &mut vault_b, 10, 10, 1, 1, EXPIRY, &clk, s.ctx());
    };
    abort 999
}

#[test, expected_failure(abort_code = EWrongVault)]
fun test_auto_swap_with_other_vaults_agent_cap_fails() {
    // An agent cap for vault A cannot trade vault B's sleeve under B's rule.
    let mut s = ts::begin(OWNER);
    setup(&mut s, 100, 1_000);
    s.next_tx(OWNER);
    let owner_cap = s.take_from_sender<OwnerCap>();
    let mut vault_a = s.take_shared<Vault>();
    create(100, s.ctx());
    s.next_tx(OWNER);
    // Vault B is the newer shared object; issue its agent cap to AGENT too.
    let vault_b_id = ts::most_recent_id_shared<Vault>().destroy_some();
    let mut vault_b = s.take_shared_by_id<Vault>(vault_b_id);
    let agent_cap_a = s.take_from_address<AgentCap>(AGENT);
    let mut clk = clock::create_for_testing(s.ctx());
    clk.set_for_testing(2_000);
    let _ = &mut vault_a;
    let _ = &owner_cap;
    let (_coin, _ticket) =
        begin_swap_auto<SUI, USDC>(&agent_cap_a, &mut vault_b, 10, 20, &clk, s.ctx());
    abort 999
}

