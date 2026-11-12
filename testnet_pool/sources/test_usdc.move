/// Module: test_usdc
///
/// TESTNET ONLY. A fixed-rate stand-in for a DEX, so the spending vault's swap flow
/// can be exercised end to end without depending on real testnet liquidity.
///
///   - `TEST_USDC` is a worthless 6-decimal coin the pool can mint on demand.
///   - The pool quotes SUI <-> TEST_USDC at an owner-set price with a fee.
///   - The owner can move the price (`set_price`) to simulate the market moving.
///
/// To the vault this looks like any DEX: a function that takes `Coin<In>` and returns
/// `Coin<Out>`.
module testnet_pool::test_usdc;

use sui::balance::Balance;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::sui::SUI;

// === Errors ===
const EZeroPrice: u64 = 0;
const EInsufficientReserve: u64 = 1;
const EZeroOutput: u64 = 2;
const EBadFee: u64 = 3;

const MIST_PER_SUI: u128 = 1_000_000_000;
const BPS: u128 = 10_000;
const MAX_FEE_BPS: u64 = 1_000;

/// One-time witness and coin type.
public struct TEST_USDC has drop {}

public struct Pool has key {
    id: UID,
    /// SUI the pool pays out when someone sells TEST_USDC for SUI.
    sui_reserve: Balance<SUI>,
    /// TEST_USDC is minted on demand, so the pool never runs out of it.
    treasury: TreasuryCap<TEST_USDC>,
    /// Micro-TEST_USDC (6 decimals) per 1 SUI. 2_000_000 means 1 SUI = 2.00 TEST_USDC.
    price: u64,
    fee_bps: u64,
}

public struct AdminCap has key, store {
    id: UID,
}

fun init(witness: TEST_USDC, ctx: &mut TxContext) {
    let (treasury, metadata) = coin::create_currency(
        witness,
        6,
        b"tUSDC",
        b"Test USDC",
        b"Worthless testnet coin issued by the mock pool.",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::share_object(Pool {
        id: object::new(ctx),
        sui_reserve: sui::balance::zero(),
        treasury,
        price: 2_000_000,
        fee_bps: 30,
    });
    transfer::public_transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
}

// === Swaps ===

/// Sell SUI, receive TEST_USDC (minted by the pool).
public fun swap_sui_for_usdc(
    pool: &mut Pool,
    payment: Coin<SUI>,
    ctx: &mut TxContext,
): Coin<TEST_USDC> {
    let out = quote_sui_for_usdc(pool, payment.value());
    assert!(out > 0, EZeroOutput);
    pool.sui_reserve.join(coin::into_balance(payment));
    coin::mint(&mut pool.treasury, out, ctx)
}

/// Sell TEST_USDC, receive SUI from the pool's reserve.
public fun swap_usdc_for_sui(
    pool: &mut Pool,
    payment: Coin<TEST_USDC>,
    ctx: &mut TxContext,
): Coin<SUI> {
    let out = quote_usdc_for_sui(pool, payment.value());
    assert!(out > 0, EZeroOutput);
    assert!(pool.sui_reserve.value() >= out, EInsufficientReserve);
    coin::burn(&mut pool.treasury, payment);
    coin::from_balance(pool.sui_reserve.split(out), ctx)
}

// === Quotes ===

/// TEST_USDC you would receive for `amount_mist` of SUI, after the fee.
public fun quote_sui_for_usdc(pool: &Pool, amount_mist: u64): u64 {
    let out =
        (amount_mist as u128) * (pool.price as u128) * (BPS - (pool.fee_bps as u128)) /
        (MIST_PER_SUI * BPS);
    out as u64
}

/// SUI (in MIST) you would receive for `amount` micro-TEST_USDC, after the fee.
public fun quote_usdc_for_sui(pool: &Pool, amount: u64): u64 {
    let out =
        (amount as u128) * MIST_PER_SUI * (BPS - (pool.fee_bps as u128)) /
        ((pool.price as u128) * BPS);
    out as u64
}

// === Admin ===

/// Anyone can add SUI liquidity, which the pool pays out on USDC -> SUI swaps.
public fun fund(pool: &mut Pool, payment: Coin<SUI>) {
    pool.sui_reserve.join(coin::into_balance(payment));
}

/// Move the market. Micro-TEST_USDC per 1 SUI.
public fun set_price(_: &AdminCap, pool: &mut Pool, price: u64) {
    assert!(price > 0, EZeroPrice);
    pool.price = price;
}

public fun set_fee_bps(_: &AdminCap, pool: &mut Pool, fee_bps: u64) {
    assert!(fee_bps <= MAX_FEE_BPS, EBadFee);
    pool.fee_bps = fee_bps;
}

#[allow(lint(self_transfer))]
public fun withdraw_sui(_: &AdminCap, pool: &mut Pool, amount: u64, ctx: &mut TxContext) {
    assert!(pool.sui_reserve.value() >= amount, EInsufficientReserve);
    transfer::public_transfer(coin::from_balance(pool.sui_reserve.split(amount), ctx), ctx.sender());
}

// === Reads ===

public fun price(pool: &Pool): u64 { pool.price }

public fun fee_bps(pool: &Pool): u64 { pool.fee_bps }

public fun sui_reserve(pool: &Pool): u64 { pool.sui_reserve.value() }

// === Tests ===

#[test_only]
use sui::test_scenario as ts;

#[test_only]
const ADMIN: address = @0xA;

#[test_only]
fun setup(s: &mut ts::Scenario) {
    init(TEST_USDC {}, s.ctx());
    s.next_tx(ADMIN);
}

#[test]
fun test_quotes_apply_price_and_fee() {
    let mut s = ts::begin(ADMIN);
    setup(&mut s);
    let pool = s.take_shared<Pool>();
    // 1 SUI at 2.00 with a 0.30% fee: 1.994 TEST_USDC.
    assert!(quote_sui_for_usdc(&pool, 1_000_000_000) == 1_994_000);
    // 2 TEST_USDC at 2.00 with a 0.30% fee: 0.997 SUI.
    assert!(quote_usdc_for_sui(&pool, 2_000_000) == 997_000_000);
    ts::return_shared(pool);
    s.end();
}

#[test]
fun test_swap_round_trip_loses_the_fee() {
    let mut s = ts::begin(ADMIN);
    setup(&mut s);
    let mut pool = s.take_shared<Pool>();
    fund(&mut pool, coin::mint_for_testing<SUI>(5_000_000_000, s.ctx()));

    let usdc = swap_sui_for_usdc(&mut pool, coin::mint_for_testing<SUI>(1_000_000_000, s.ctx()), s.ctx());
    assert!(usdc.value() == 1_994_000);
    let sui_back = swap_usdc_for_sui(&mut pool, usdc, s.ctx());
    assert!(sui_back.value() < 1_000_000_000);
    sui_back.burn_for_testing();
    ts::return_shared(pool);
    s.end();
}

#[test]
fun test_set_price_moves_the_quote() {
    let mut s = ts::begin(ADMIN);
    setup(&mut s);
    let admin = s.take_from_sender<AdminCap>();
    let mut pool = s.take_shared<Pool>();
    set_price(&admin, &mut pool, 4_000_000);
    assert!(quote_sui_for_usdc(&pool, 1_000_000_000) == 3_988_000);
    ts::return_shared(pool);
    s.return_to_sender(admin);
    s.end();
}

#[test, expected_failure(abort_code = EInsufficientReserve)]
fun test_sell_usdc_with_empty_reserve_fails() {
    let mut s = ts::begin(ADMIN);
    setup(&mut s);
    let mut pool = s.take_shared<Pool>();
    let usdc = coin::mint_for_testing<TEST_USDC>(2_000_000, s.ctx());
    let _sui = swap_usdc_for_sui(&mut pool, usdc, s.ctx());
    abort 999
}

#[test, expected_failure(abort_code = EZeroOutput)]
fun test_dust_swap_fails() {
    let mut s = ts::begin(ADMIN);
    setup(&mut s);
    let mut pool = s.take_shared<Pool>();
    let _usdc = swap_sui_for_usdc(&mut pool, coin::mint_for_testing<SUI>(1, s.ctx()), s.ctx());
    abort 999
}
