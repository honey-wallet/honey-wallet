//! Solana swap transactions: the v0 message of a Jupiter `/order`, the shape Honey's fee
//! payer accepts for it, and associated token account derivation (to read the taker's
//! output balance in the simulation).

use alloy_primitives::U256;
use sha2::{Digest, Sha256};

use super::chains::JUPITER_V6;
use crate::solana_relayer::{
    ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, LAMPORTS_PER_SIGNATURE, SYSTEM_PROGRAM,
    TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
};

/// Most compute units a sponsored swap may ask for (Solana's per-transaction maximum).
pub const MAX_SWAP_COMPUTE_UNITS: u32 = 1_400_000;
/// Most priority fee Honey pays on one swap: 100,000 lamports (0.0001 SOL).
pub const MAX_SWAP_PRIORITY_LAMPORTS: u64 = 100_000;
const MAX_STATIC_KEYS: usize = 64;
const MAX_INSTRUCTIONS: usize = 16;
const MAX_LOOKUPS: usize = 8;

/// A compiled instruction of a v0 message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instruction {
    pub program: usize,
    pub accounts: Vec<usize>,
    pub data: Vec<u8>,
}

/// A v0 message (address lookup tables are kept as counts: their addresses can't be
/// signers, and the runtime refuses an address loaded twice).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageV0 {
    pub required_signatures: u8,
    pub readonly_signed: u8,
    pub readonly_unsigned: u8,
    pub keys: Vec<[u8; 32]>,
    pub blockhash: [u8; 32],
    pub instructions: Vec<Instruction>,
    /// Addresses loaded from lookup tables (writable + readonly).
    pub loaded: usize,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.at.checked_add(n).ok_or("truncated")?;
        let out = self.bytes.get(self.at..end).ok_or("truncated")?;
        self.at = end;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }
    fn short_vec(&mut self) -> Result<usize, &'static str> {
        let mut value = 0usize;
        for i in 0..3 {
            let byte = self.u8()?;
            value |= usize::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                if i > 0 && byte == 0 {
                    return Err("bad length");
                }
                return Ok(value);
            }
        }
        Err("bad length")
    }
    fn key(&mut self) -> Result<[u8; 32], &'static str> {
        self.take(32)?.try_into().map_err(|_| "truncated")
    }
}

impl MessageV0 {
    pub fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        let mut r = Reader { bytes, at: 0 };
        if r.u8()? != 0x80 {
            return Err("a v0 transaction was expected");
        }
        let required_signatures = r.u8()?;
        let readonly_signed = r.u8()?;
        let readonly_unsigned = r.u8()?;
        let count = r.short_vec()?;
        if count == 0 || count > MAX_STATIC_KEYS {
            return Err("wrong number of accounts");
        }
        let keys = (0..count).map(|_| r.key()).collect::<Result<Vec<_>, _>>()?;
        let blockhash = r.key()?;
        let n = r.short_vec()?;
        if n == 0 || n > MAX_INSTRUCTIONS {
            return Err("wrong number of instructions");
        }
        let mut instructions = Vec::with_capacity(n);
        for _ in 0..n {
            let program = usize::from(r.u8()?);
            let len = r.short_vec()?;
            let accounts = r.take(len)?.iter().map(|&i| usize::from(i)).collect();
            let len = r.short_vec()?;
            let data = r.take(len)?.to_vec();
            instructions.push(Instruction {
                program,
                accounts,
                data,
            });
        }
        let lookups = r.short_vec()?;
        if lookups > MAX_LOOKUPS {
            return Err("too many lookup tables");
        }
        let mut loaded = 0usize;
        for _ in 0..lookups {
            r.key()?;
            for _ in 0..2 {
                let len = r.short_vec()?;
                r.take(len)?;
                loaded += len;
            }
        }
        if r.at != bytes.len() {
            return Err("trailing bytes");
        }
        Ok(Self {
            required_signatures,
            readonly_signed,
            readonly_unsigned,
            keys,
            blockhash,
            instructions,
            loaded,
        })
    }
}

/// What a checked sponsored swap costs Honey.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapChecked {
    pub blockhash: [u8; 32],
    /// Both signatures plus the priority fee.
    pub fee_lamports: u64,
}

fn b58(key: &[u8; 32]) -> String {
    bs58::encode(key).into_string()
}

/// The shape Honey's fee payer accepts for a Jupiter swap (on top of the message being
/// byte-for-byte the one Honey quoted):
/// - a v0 message with exactly two signers: the relayer (fee payer, account 0) and the
///   taker (account 1); no duplicate static keys; programs are static keys;
/// - top-level programs: Compute Budget (unit limit ≤ 1.4M, priority fee ≤ 0.0001 SOL),
///   Jupiter v6 (at least once), Associated Token `CreateIdempotent` for the taker's own
///   account and paid for by the taker, and SPL Token `SyncNative` / `CloseAccount`
///   (authority the taker). Nothing else;
/// - the relayer is in no instruction at all, so no program can move its SOL other than
///   the fee (the simulation checks the outflow too). Honey never pays a new token
///   account's rent in a swap: the taker owns that account and could close it to
///   themselves, turning the rent into cash (docs/routing/AUDIT.md finding 4).
pub fn check_swap(
    message: &[u8],
    relayer: &[u8; 32],
    taker: &[u8; 32],
) -> Result<SwapChecked, &'static str> {
    let msg = MessageV0::decode(message)?;
    if msg.required_signatures != 2 {
        return Err("Honey pays fees only for swaps you and Honey sign");
    }
    let keys = &msg.keys;
    for (i, key) in keys.iter().enumerate() {
        if keys[..i].contains(key) {
            return Err("duplicate account");
        }
    }
    if &keys[0] != relayer || &keys[1] != taker {
        return Err("Honey's fee payer must pay the fee and you must sign");
    }
    if msg.readonly_signed > 1 || usize::from(msg.readonly_unsigned) >= keys.len() - 1 {
        return Err("bad account header");
    }
    let total = keys.len() + msg.loaded;
    let mut unit_limit: Option<u32> = None;
    let mut unit_price: Option<u64> = None;
    let mut jupiter = 0usize;
    for ix in &msg.instructions {
        if ix.program == 0 || ix.program >= keys.len() || ix.accounts.iter().any(|&a| a >= total) {
            return Err("bad instruction");
        }
        let program = b58(&keys[ix.program]);
        let relayer_at: Vec<usize> = ix
            .accounts
            .iter()
            .enumerate()
            .filter(|(_, a)| **a == 0)
            .map(|(i, _)| i)
            .collect();
        match program.as_str() {
            COMPUTE_BUDGET_PROGRAM => {
                if !ix.accounts.is_empty() {
                    return Err("bad compute budget");
                }
                match ix.data.first() {
                    Some(2) if ix.data.len() == 5 && unit_limit.is_none() => {
                        let units =
                            u32::from_le_bytes(ix.data[1..5].try_into().unwrap_or_default());
                        if units > MAX_SWAP_COMPUTE_UNITS {
                            return Err("too many compute units");
                        }
                        unit_limit = Some(units);
                    }
                    Some(3) if ix.data.len() == 9 && unit_price.is_none() => {
                        unit_price = Some(u64::from_le_bytes(
                            ix.data[1..9].try_into().unwrap_or_default(),
                        ));
                    }
                    _ => return Err("bad compute budget"),
                }
            }
            JUPITER_V6 => {
                if !relayer_at.is_empty() {
                    return Err("the swap may not use Honey's fee payer");
                }
                jupiter += 1;
            }
            ATA_PROGRAM => {
                // CreateIdempotent: [funder, ata, wallet, mint, system, token program].
                if ix.data != [1] || ix.accounts.len() != 6 {
                    return Err("only idempotent token account creation");
                }
                match (ix.accounts[0], relayer_at.as_slice()) {
                    (1, []) => {}
                    (0, _) => return Err("Honey doesn't pay to open token accounts in a swap"),
                    _ => return Err("bad token account creation"),
                }
                if ix.accounts[2] != 1 {
                    return Err("Honey only opens your own token accounts");
                }
            }
            // TOKEN_PROGRAM => {
            // 15 Nov: Token-2022 too (tokenized stocks), under the same two instructions.
            TOKEN_PROGRAM | TOKEN_2022_PROGRAM => {
                if !relayer_at.is_empty() {
                    return Err("the swap may not use Honey's fee payer");
                }
                match (ix.data.as_slice(), ix.accounts.len()) {
                    // SyncNative: [account].
                    ([17], 1) => {}
                    // CloseAccount: [account, destination, owner], owned by the taker.
                    ([9], 3) if ix.accounts[2] == 1 => {}
                    _ => return Err("Honey doesn't pay for that token instruction"),
                }
            }
            SYSTEM_PROGRAM => return Err("Honey doesn't pay for SOL moves in a swap"),
            _ => return Err("Honey doesn't pay fees for that program"),
        }
    }
    if jupiter == 0 {
        return Err("not a Jupiter swap");
    }
    if unit_price.is_some() && unit_limit.is_none() {
        return Err("a priority fee needs a compute unit limit");
    }
    let priority = match (unit_limit, unit_price) {
        (Some(units), Some(price)) => (u128::from(units) * u128::from(price)).div_ceil(1_000_000),
        _ => 0,
    };
    let priority = u64::try_from(priority).map_err(|_| "priority fee too high")?;
    if priority > MAX_SWAP_PRIORITY_LAMPORTS {
        return Err("priority fee too high");
    }
    Ok(SwapChecked {
        blockhash: msg.blockhash,
        fee_lamports: LAMPORTS_PER_SIGNATURE * 2 + priority,
    })
}

/// Whether the message opens a token account paid for by its fee payer (account 0).
pub fn payer_opens_accounts(message: &[u8]) -> bool {
    let Ok(msg) = MessageV0::decode(message) else {
        return false;
    };
    msg.instructions.iter().any(|ix| {
        msg.keys
            .get(ix.program)
            .is_some_and(|p| b58(p) == ATA_PROGRAM)
            && ix.accounts.first() == Some(&0)
    })
}

// Jupiter v6 route instructions

/// `route` (v1): `route_plan, in_amount: u64, quoted_out_amount: u64, slippage_bps: u16,
/// platform_fee_bps: u8` (the amounts are the last 19 bytes).
pub const JUPITER_ROUTE: [u8; 8] = [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a];
/// `shared_accounts_route` (v1): `id: u8` first, then as `route`.
pub const JUPITER_SHARED_ROUTE: [u8; 8] = [0xc1, 0x20, 0x9b, 0x33, 0x41, 0xd6, 0x9c, 0x81];
/// `route_v2`: `in_amount: u64, quoted_out_amount: u64, slippage_bps: u16,
/// platform_fee_bps: u16, positive_slippage_bps: u16, route_plan`.
pub const JUPITER_ROUTE_V2: [u8; 8] = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
/// `shared_accounts_route_v2`: `id: u8` first, then as `route_v2` (the live `/order`
/// transaction of 2026-11-13 uses it).
pub const JUPITER_SHARED_ROUTE_V2: [u8; 8] = [0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9];

/// What a Jupiter exact-in route instruction makes the program enforce.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JupiterRoute {
    pub in_amount: u64,
    pub quoted_out_amount: u64,
    pub slippage_bps: u16,
    pub platform_fee_bps: u16,
    pub positive_slippage_bps: u16,
}

fn le_u64(b: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(..8)?.try_into().ok()?))
}

fn le_u16(b: &[u8]) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(..2)?.try_into().ok()?))
}

/// An exact-in Jupiter v6 route instruction's amounts; None for any other instruction
/// (exact-out and token-ledger routes included).
pub fn decode_jupiter_route(data: &[u8]) -> Option<JupiterRoute> {
    let disc: [u8; 8] = data.get(..8)?.try_into().ok()?;
    let v2 = |args: &[u8]| -> Option<JupiterRoute> {
        // Then at least the route plan's length.
        (args.len() >= 22 + 4).then_some(())?;
        Some(JupiterRoute {
            in_amount: le_u64(args)?,
            quoted_out_amount: le_u64(&args[8..])?,
            slippage_bps: le_u16(&args[16..])?,
            platform_fee_bps: le_u16(&args[18..])?,
            positive_slippage_bps: le_u16(&args[20..])?,
        })
    };
    let v1 = |args: &[u8]| -> Option<JupiterRoute> {
        // The route plan's length, then the 19 trailing bytes.
        (args.len() >= 4 + 19).then_some(())?;
        let tail = &args[args.len() - 19..];
        Some(JupiterRoute {
            in_amount: le_u64(tail)?,
            quoted_out_amount: le_u64(&tail[8..])?,
            slippage_bps: le_u16(&tail[16..])?,
            platform_fee_bps: u16::from(tail[18]),
            positive_slippage_bps: 0,
        })
    };
    match disc {
        JUPITER_ROUTE_V2 => v2(&data[8..]),
        JUPITER_SHARED_ROUTE_V2 => v2(data.get(9..)?),
        JUPITER_ROUTE => v1(&data[8..]),
        JUPITER_SHARED_ROUTE => v1(data.get(9..)?),
        _ => None,
    }
}

/// The amounts the Jupiter program itself will enforce, read from the signed message:
/// exactly one exact-in route instruction, selling exactly `sell_amount`, whose own
/// slippage floor (`quoted_out_amount × (10000 − slippage_bps) / 10000`) is at least
/// `min_buy`, with no platform fee and no positive-slippage fee
/// (docs/routing/AUDIT.md finding 6).
pub fn check_jupiter_amounts(
    message: &[u8],
    sell_amount: u64,
    min_buy: u64,
) -> Result<JupiterRoute, &'static str> {
    let msg = MessageV0::decode(message)?;
    let mut found = None;
    for ix in &msg.instructions {
        let Some(program) = msg.keys.get(ix.program) else {
            return Err("bad instruction");
        };
        if b58(program) != JUPITER_V6 {
            continue;
        }
        let route = decode_jupiter_route(&ix.data).ok_or("not an exact-in Jupiter route")?;
        if found.replace(route).is_some() {
            return Err("more than one Jupiter route");
        }
    }
    let route = found.ok_or("not a Jupiter swap")?;
    if route.in_amount != sell_amount {
        return Err("the swap sells another amount");
    }
    if route.platform_fee_bps != 0 || route.positive_slippage_bps != 0 {
        return Err("the swap takes a fee");
    }
    if route.slippage_bps > 10_000 {
        return Err("bad slippage");
    }
    let floor =
        u128::from(route.quoted_out_amount) * u128::from(10_000 - route.slippage_bps) / 10_000;
    if floor < u128::from(min_buy) {
        return Err("the swap's own minimum is below the quote's");
    }
    Ok(route)
}

/// Where each exact-in route instruction names, by account position: the user transfer
/// authority, the user's source token account, its destination token account(s), and the
/// source and destination mints when it has them (Jupiter v6's on-chain IDL, read
/// 2026-11-14). `route` (v1) names no source mint.
struct RouteAccounts {
    authority: usize,
    source: usize,
    destination: usize,
    source_mint: Option<usize>,
    destination_mint: Option<usize>,
    /// The optional `destination_token_account` (`route` 4, `route_v2` 7): the Jupiter
    /// program's own id when unused, else where the output goes.
    optional_destination: Option<usize>,
}

fn route_accounts(data: &[u8]) -> Option<RouteAccounts> {
    let disc: [u8; 8] = data.get(..8)?.try_into().ok()?;
    // Replaced (review): the optional destination account is named too.
    // let at = |authority, source, destination, source_mint, destination_mint| RouteAccounts {
    //     authority,
    //     source,
    //     destination,
    //     source_mint,
    //     destination_mint,
    // };
    // match disc {
    //     JUPITER_SHARED_ROUTE_V2 => Some(at(1, 2, 5, Some(6), Some(7))),
    //     JUPITER_ROUTE_V2 => Some(at(0, 1, 2, Some(3), Some(4))),
    //     JUPITER_ROUTE => Some(at(1, 2, 3, None, Some(5))),
    //     JUPITER_SHARED_ROUTE => Some(at(2, 3, 6, Some(7), Some(8))),
    //     _ => None,
    // }
    let at =
        |authority, source, destination, source_mint, destination_mint, optional| RouteAccounts {
            authority,
            source,
            destination,
            source_mint,
            destination_mint,
            optional_destination: optional,
        };
    match disc {
        JUPITER_SHARED_ROUTE_V2 => Some(at(1, 2, 5, Some(6), Some(7), None)),
        JUPITER_ROUTE_V2 => Some(at(0, 1, 2, Some(3), Some(4), Some(7))),
        JUPITER_ROUTE => Some(at(1, 2, 3, None, Some(5), Some(4))),
        JUPITER_SHARED_ROUTE => Some(at(2, 3, 6, Some(7), Some(8), None)),
        _ => None,
    }
}

/// The route sells `sell_mint` from the taker's own associated token account (classic
/// token program), signed by the taker, into the taker's own account for `buy_mint`
/// (money audit 11, 2026-11-14): `check_jupiter_amounts` alone would pass the same amount
/// of another token. Mints loaded from a lookup table aren't readable here; the two
/// accounts, derived from the mints, already fix both tokens.
pub fn check_jupiter_accounts(
    message: &[u8],
    taker: &[u8; 32],
    sell_mint: &[u8; 32],
    buy_mint: &[u8; 32],
) -> Result<(), &'static str> {
    let token = decode_key(TOKEN_PROGRAM).ok_or("bad token program")?;
    check_jupiter_accounts_with(message, taker, (sell_mint, &token), (buy_mint, &token))
}

/// [`check_jupiter_accounts`] with each side's `(mint, token program)` (15 Nov): a
/// Token-2022 mint's associated account is derived under Token-2022, so a classic
/// derivation names an account the route never touches.
pub fn check_jupiter_accounts_with(
    message: &[u8],
    taker: &[u8; 32],
    sell: (&[u8; 32], &[u8; 32]),
    buy: (&[u8; 32], &[u8; 32]),
) -> Result<(), &'static str> {
    let msg = MessageV0::decode(message)?;
    // let token = decode_key(TOKEN_PROGRAM).ok_or("bad token program")?;
    // let source = associated_token_address(taker, sell_mint, &token).ok_or("no source account")?;
    // let output = associated_token_address(taker, buy_mint, &token).ok_or("no output account")?;
    let ((sell_mint, sell_program), (buy_mint, buy_program)) = (sell, buy);
    for program in [sell_program, buy_program] {
        if b58(program) != TOKEN_PROGRAM && b58(program) != TOKEN_2022_PROGRAM {
            return Err("bad token program");
        }
    }
    let source =
        associated_token_address(taker, sell_mint, sell_program).ok_or("no source account")?;
    let output =
        associated_token_address(taker, buy_mint, buy_program).ok_or("no output account")?;
    let jupiter = decode_key(JUPITER_V6).ok_or("bad Jupiter program")?;
    let mut routes = 0usize;
    for ix in &msg.instructions {
        let Some(program) = msg.keys.get(ix.program) else {
            return Err("bad instruction");
        };
        if b58(program) != JUPITER_V6 {
            continue;
        }
        let at = route_accounts(&ix.data).ok_or("not an exact-in Jupiter route")?;
        let key = |i: usize| ix.accounts.get(i).and_then(|&k| msg.keys.get(k));
        if key(at.authority) != Some(taker) {
            return Err("the swap isn't signed by you");
        }
        if key(at.source) != Some(&source) {
            return Err("the swap sells from another account");
        }
        if key(at.destination) != Some(&output) {
            return Err("the swap pays another account");
        }
        // As the phone checks: unused (the program's id) or the same output account.
        if let Some(i) = at.optional_destination
            && !matches!(key(i), Some(k) if *k == jupiter || *k == output)
        {
            return Err("the swap pays another account");
        }
        let mint_ok = |i: Option<usize>, mint: &[u8; 32]| match i.and_then(|i| ix.accounts.get(i)) {
            Some(&k) if k < msg.keys.len() => &msg.keys[k] == mint,
            _ => true,
        };
        if !mint_ok(at.source_mint, sell_mint) || !mint_ok(at.destination_mint, buy_mint) {
            return Err("the swap trades another token");
        }
        routes += 1;
    }
    if routes != 1 {
        return Err("not one Jupiter route");
    }
    Ok(())
}

// Program derived addresses

/// Whether 32 bytes are a point on ed25519 (the check `Pubkey::is_on_curve` makes:
/// curve25519-dalek's decompression, which reduces y mod p and succeeds when
/// (y² − 1) / (d·y² + 1) is a square).
pub fn on_curve(bytes: &[u8; 32]) -> bool {
    let p = (U256::from(1) << 255) - U256::from(19);
    let mut le = *bytes;
    le[31] &= 0x7f;
    let y = U256::from_le_bytes(le).reduce_mod(p);
    let d = {
        // d = −121665 / 121666 mod p.
        let inv = U256::from(121_666u32).pow_mod(p - U256::from(2), p);
        (p - U256::from(121_665u32)).mul_mod(inv, p)
    };
    let yy = y.mul_mod(y, p);
    let u = yy.add_mod(p - U256::from(1), p);
    let v = d.mul_mod(yy, p).add_mod(U256::from(1), p);
    if v.is_zero() {
        return u.is_zero();
    }
    let x2 = u.mul_mod(v.pow_mod(p - U256::from(2), p), p);
    x2.is_zero() || x2.pow_mod((p - U256::from(1)) >> 1, p) == U256::from(1)
}

/// `Pubkey::find_program_address(seeds, program)`.
pub fn find_program_address(seeds: &[&[u8]], program: &[u8; 32]) -> Option<[u8; 32]> {
    for bump in (0..=255u8).rev() {
        let mut hasher = Sha256::new();
        for seed in seeds {
            hasher.update(seed);
        }
        hasher.update([bump]);
        hasher.update(program);
        hasher.update(b"ProgramDerivedAddress");
        let hash: [u8; 32] = hasher.finalize().into();
        if !on_curve(&hash) {
            return Some(hash);
        }
    }
    None
}

pub fn decode_key(text: &str) -> Option<[u8; 32]> {
    bs58::decode(text.trim()).into_vec().ok()?.try_into().ok()
}

/// The associated token account of `wallet` for `mint` under `token_program`.
pub fn associated_token_address(
    wallet: &[u8; 32],
    mint: &[u8; 32],
    token_program: &[u8; 32],
) -> Option<[u8; 32]> {
    let program = decode_key(ATA_PROGRAM)?;
    find_program_address(&[wallet, token_program, mint], &program)
}

/// An SPL token account's amount (bytes 64..72, little endian).
pub fn token_amount(data: &[u8]) -> Option<u64> {
    data.get(64..72)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};

    /// The live `/swap/v2/order` transaction (USDC → JUP, 10 USDC, payer set) of
    /// 2026-11-13; docs/routing/LIVE-CHECK.md.
    fn live() -> Vec<u8> {
        STANDARD
            .decode(include_str!("fixtures/jupiter_order_tx.b64").trim())
            .unwrap()
    }
    const PAYER: &str = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
    const TAKER: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    fn message() -> Vec<u8> {
        let wire = crate::solana_relayer::Wire::decode(&live()).unwrap();
        assert_eq!(wire.signatures.len(), 2);
        wire.message
    }

    #[test]
    fn the_live_jupiter_order_passes() {
        let checked = check_swap(
            &message(),
            &decode_key(PAYER).unwrap(),
            &decode_key(TAKER).unwrap(),
        )
        .unwrap();
        // 345,950 units at 19,865 micro-lamports: 6,873 lamports, plus two signatures
        // (the order said prioritizationFeeLamports 6873, signatureFeeLamports 10000).
        assert_eq!(checked.fee_lamports, 10_000 + 6_873);
    }

    #[test]
    fn other_payers_takers_and_shapes_are_refused() {
        let payer = decode_key(PAYER).unwrap();
        let taker = decode_key(TAKER).unwrap();
        let m = message();
        assert!(check_swap(&m, &taker, &payer).is_err());
        assert!(check_swap(&m, &[7; 32], &taker).is_err());
        // A legacy message or trailing bytes.
        assert!(check_swap(&m[1..], &payer, &taker).is_err());
        let mut longer = m.clone();
        longer.push(0);
        assert!(check_swap(&longer, &payer, &taker).is_err());
        // The relayer named in the Jupiter instruction (its first account → index 0).
        let decoded = MessageV0::decode(&m).unwrap();
        assert_eq!(decoded.instructions[2].program, 13);
        let at = find_instruction_accounts(&m, 2);
        let mut uses_payer = m.clone();
        uses_payer[at] = 0;
        assert!(check_swap(&uses_payer, &payer, &taker).is_err());
        // A unit limit above the cap (data of instruction 0: 0x02 + u32).
        let mut units = m.clone();
        let limit = find_instruction_data(&m, 0);
        units[limit + 1..limit + 5].copy_from_slice(&1_400_001u32.to_le_bytes());
        assert!(check_swap(&units, &payer, &taker).is_err());
        // A priority price that makes the fee exceed 0.0001 SOL.
        let mut price = m.clone();
        let p = find_instruction_data(&m, 1);
        price[p + 1..p + 9].copy_from_slice(&1_000_000u64.to_le_bytes());
        assert!(check_swap(&price, &payer, &taker).is_err());
    }

    /// Byte offset of instruction `n`'s first account index in a v0 message.
    fn find_instruction_accounts(m: &[u8], n: usize) -> usize {
        walk(m, n).0
    }
    fn find_instruction_data(m: &[u8], n: usize) -> usize {
        walk(m, n).1
    }
    fn walk(m: &[u8], n: usize) -> (usize, usize) {
        let mut r = Reader { bytes: m, at: 4 };
        let keys = r.short_vec().unwrap();
        r.at += 32 * keys + 32;
        let count = r.short_vec().unwrap();
        assert!(n < count);
        for i in 0..count {
            r.u8().unwrap();
            let len = r.short_vec().unwrap();
            let accounts = r.at;
            r.at += len;
            let dlen = r.short_vec().unwrap();
            let data = r.at;
            r.at += dlen;
            if i == n {
                return (accounts, data);
            }
        }
        unreachable!()
    }

    #[test]
    fn the_live_jupiter_route_instruction_decodes() {
        let route = check_jupiter_amounts(&message(), 10_000_000, 38_218_540).unwrap();
        assert_eq!(
            route,
            JupiterRoute {
                in_amount: 10_000_000,
                quoted_out_amount: 38_410_593,
                slippage_bps: 50,
                platform_fee_bps: 0,
                positive_slippage_bps: 0,
            }
        );
        // Another amount sold, or a minimum above what the instruction enforces.
        assert!(check_jupiter_amounts(&message(), 10_000_001, 38_218_540).is_err());
        assert!(check_jupiter_amounts(&message(), 10_000_000, 38_218_541).is_err());
    }

    #[test]
    fn jupiter_routes_with_fees_or_looser_slippage_are_refused() {
        let m = message();
        let data = find_instruction_data(&m, 2);
        // shared_accounts_route_v2: disc(8) id(1) in(8) out(8) slippage(2) fee(2) positive(2).
        assert_eq!(m[data..data + 8], JUPITER_SHARED_ROUTE_V2);
        let at = data + 9;
        let mut fee = m.clone();
        fee[at + 18..at + 20].copy_from_slice(&50u16.to_le_bytes());
        assert!(check_jupiter_amounts(&fee, 10_000_000, 38_218_540).is_err());
        let mut positive = m.clone();
        positive[at + 20..at + 22].copy_from_slice(&50u16.to_le_bytes());
        assert!(check_jupiter_amounts(&positive, 10_000_000, 38_218_540).is_err());
        // 5% slippage in the instruction while the quote promised 0.5%.
        let mut loose = m.clone();
        loose[at + 16..at + 18].copy_from_slice(&500u16.to_le_bytes());
        assert!(check_jupiter_amounts(&loose, 10_000_000, 38_218_540).is_err());
        // An exact-out route (or anything else) isn't decoded at all.
        let mut exact_out = m.clone();
        exact_out[data..data + 8]
            .copy_from_slice(&[0x9d, 0x8a, 0xb8, 0x52, 0x15, 0xf4, 0xf3, 0x24]);
        assert!(check_jupiter_amounts(&exact_out, 10_000_000, 38_218_540).is_err());
        // v1 layouts: the amounts are the last 19 bytes.
        let mut v1 = JUPITER_ROUTE.to_vec();
        v1.extend_from_slice(&0u32.to_le_bytes());
        v1.extend_from_slice(&7u64.to_le_bytes());
        v1.extend_from_slice(&100u64.to_le_bytes());
        v1.extend_from_slice(&100u16.to_le_bytes());
        v1.push(0);
        assert_eq!(
            decode_jupiter_route(&v1),
            Some(JupiterRoute {
                in_amount: 7,
                quoted_out_amount: 100,
                slippage_bps: 100,
                platform_fee_bps: 0,
                positive_slippage_bps: 0,
            })
        );
    }

    #[test]
    fn the_live_route_sells_the_takers_own_usdc_into_its_own_account() {
        let taker = decode_key(TAKER).unwrap();
        let usdc = decode_key(super::super::chains::USDC_SOLANA).unwrap();
        let jup = decode_key("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN").unwrap();
        let m = message();
        assert_eq!(check_jupiter_accounts(&m, &taker, &usdc, &jup), Ok(()));
        // The same message read as selling or buying another token: refused.
        assert!(check_jupiter_accounts(&m, &taker, &jup, &jup).is_err());
        assert!(check_jupiter_accounts(&m, &taker, &usdc, &usdc).is_err());
        // Another wallet's account as the source: refused.
        let other = decode_key(PAYER).unwrap();
        assert!(check_jupiter_accounts(&m, &other, &usdc, &jup).is_err());
        // The source account index pointed at another static key: refused.
        let mut moved = m.clone();
        let accounts = find_instruction_accounts(&m, 2);
        moved[accounts + 2] = moved[accounts + 5];
        assert!(check_jupiter_accounts(&moved, &taker, &usdc, &jup).is_err());
    }

    /// The live shared-accounts route rewritten as `route_v2`, its accounts moved to
    /// that layout, with `optional` (an index into the message's keys) at position 7.
    fn as_route_v2(optional: Option<u8>) -> Vec<u8> {
        let m = message();
        let accounts = find_instruction_accounts(&m, 2);
        let data = find_instruction_data(&m, 2);
        let shared: Vec<u8> = m[accounts..accounts + 8].to_vec();
        let mut out = m.clone();
        out[data..data + 8].copy_from_slice(&JUPITER_ROUTE_V2);
        // authority, source, destination, source mint, destination mint.
        for (to, from) in [(0, 1), (1, 2), (2, 5), (3, 6), (4, 7)] {
            out[accounts + to] = shared[from];
        }
        // Positions 5 and 6 aren't checked; 7 is the optional destination.
        let jupiter_at = MessageV0::decode(&m).unwrap().instructions[2].program as u8;
        out[accounts + 7] = optional.unwrap_or(jupiter_at);
        out
    }

    #[test]
    fn the_optional_destination_is_unused_or_the_takers_own() {
        let taker = decode_key(TAKER).unwrap();
        let usdc = decode_key(super::super::chains::USDC_SOLANA).unwrap();
        let jup = decode_key("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN").unwrap();
        let m = message();
        let shared = find_instruction_accounts(&m, 2);
        let (output_at, source_at) = (m[shared + 5], m[shared + 2]);
        // Unused (the program's id) or the same output account: fine.
        assert_eq!(
            check_jupiter_accounts(&as_route_v2(None), &taker, &usdc, &jup),
            Ok(())
        );
        assert_eq!(
            check_jupiter_accounts(&as_route_v2(Some(output_at)), &taker, &usdc, &jup),
            Ok(())
        );
        // Any other account (here the taker's USDC account) would receive the output.
        assert_eq!(
            check_jupiter_accounts(&as_route_v2(Some(source_at)), &taker, &usdc, &jup),
            Err("the swap pays another account")
        );
    }

    #[test]
    fn curve_points_and_pdas() {
        // Real wallets are on the curve; the ATA of the taker for USDC (classic token
        // program) is one of the live order's static keys.
        assert!(on_curve(&decode_key(TAKER).unwrap()));
        // The fixture's stand-in payer is Raydium's AMM v4 authority, itself a PDA.
        assert!(!on_curve(&decode_key(PAYER).unwrap()));
        let ata = associated_token_address(
            &decode_key(TAKER).unwrap(),
            &decode_key(super::super::chains::USDC_SOLANA).unwrap(),
            &decode_key(TOKEN_PROGRAM).unwrap(),
        )
        .unwrap();
        assert!(!on_curve(&ata));
        let keys = MessageV0::decode(&message()).unwrap().keys;
        assert!(keys.contains(&ata), "{}", b58(&ata));
    }

    #[test]
    fn token_amounts() {
        let mut data = vec![0u8; 165];
        data[64..72].copy_from_slice(&38_377_222u64.to_le_bytes());
        assert_eq!(token_amount(&data), Some(38_377_222));
        assert_eq!(token_amount(&data[..70]), None);
    }
}
