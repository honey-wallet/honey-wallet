/**
 * Real jar buys through NEAR Intents. The server fetches live quotes, each with a
 * one-time deposit address; this device signs one USDC transfer on Base per leg and
 * sends it. Funds go straight from the wallet to NEAR Intents, never to Honey's
 * server, and a swap that can't fill refunds to the same wallet.
 *
 * The server is not trusted with where money goes: every quote is checked here
 * (amounts, payout and refund addresses, slippage, deadline, cap) and each deposit
 * address is confirmed with 1Click directly before anything is signed.
 */
import {
  fetchOneClickStatus,
  type JarBuyLeg,
  type JarBuyQuote,
  type JarBuyState,
} from '@honey-wallet/api-client';
import { evmAddressOfKey, evmNetwork, signEvmTransaction } from '@honey-wallet/keyring';
import { createPublicClient, encodeFunctionData, erc20Abi, type Hex, http, isAddress } from 'viem';
import { api } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import { prepareEvmSend } from '@/lib/dapp-sign';
import type { Route } from '@/lib/jar-routes';
import { TEST_MODE } from '@/lib/test-mode';
import { privateKeyOf } from '@/lib/vault';
import { wallets } from '@/lib/wallets';

/** Jars are paid in USDC on Base. */
export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_BASE_ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const USDC_DECIMALS = 6;

/** Highest slippage the app ever asks for or accepts, matching the server. */
export const MAX_SLIPPAGE_BPS = 300;
/** A quote must leave at least this long to sign and land the deposit. */
const DEADLINE_MARGIN_MS = 60_000;
/** The server asks for 15-minute quotes; anything far longer was not ours. */
const MAX_DEADLINE_MS = 30 * 60_000;
/** Hard client-side ceiling, whatever cap the server reports. */
export const MAX_BUY_USD = 1_000;

export type BuyLeg = {
  symbol: string;
  chain: string;
  usd: number;
  destinationAsset: string;
  depositAddress: string;
  amountIn: string;
  minAmountOut: string;
  deadline: string;
  txHash?: string;
  status: JarBuyState | 'NOT_SENT';
};

export type AskedLeg = {
  symbol: string;
  chain: string;
  /** Integer micro-USDC. */
  micro: bigint;
  assetId: string;
  recipient: string;
};

/** Your address on each chain a jar can deliver to. */
function recipientOn(chain: string, addresses: { evm?: string; solana?: string; near?: string }) {
  if (chain === 'Solana') return addresses.solana;
  if (chain === 'NEAR') return addresses.near;
  return addresses.evm;
}

/** Dollars to integer micro-USDC. Every sum happens on these, never on floats. */
export const toMicro = (usd: number) => BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
const fromMicro = (micro: bigint) => Number(micro) / 10 ** USDC_DECIMALS;
const atomic = (s: unknown) =>
  typeof s === 'string' && /^[0-9]{1,38}$/.test(s) ? BigInt(s) : null;
const sameAddress = (a: unknown, b: string) =>
  typeof a === 'string' &&
  (a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b);
const changed = () => new Error('The quote changed. Review again.');

/** The active wallet, if it can pay: keys on this device and not a demo or watch. */
function payer() {
  const state = wallets.get();
  const wallet = state.added.find((w) => w.id === state.activeId);
  if (TEST_MODE) throw new Error('Test mode uses sample money. Turn it off to buy for real.');
  if (!wallet?.addresses?.evm || wallet.watchOnly || wallet.demo)
    throw new Error('Pick a wallet with keys on this device to pay.');
  return { id: wallet.id, addresses: wallet.addresses };
}

/** Live quotes for every routed leg. Nothing is signed yet. */
export async function quoteJarBuy(routes: Route[], slippage: number) {
  const { addresses } = payer();
  const token = backendSessionToken();
  if (!token) throw new Error('Sign in to buy.');
  const slippageBps = Math.round(slippage * 10_000);
  if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS)
    throw new Error(`Slippage must be between 0.01% and ${MAX_SLIPPAGE_BPS / 100}%.`);
  // NEAR Intents finds its own liquidity, so pools on the same chain merge into one
  // swap per asset; the split that remains is across chains.
  const legs: AskedLeg[] = [];
  for (const r of routes)
    for (const l of r.legs) {
      if (!l.assetId || !(l.usd > 0)) continue;
      const recipient = recipientOn(l.chain, addresses);
      if (!recipient) throw new Error(`This wallet has no ${l.chain} address.`);
      const same = legs.find((x) => x.assetId === l.assetId);
      if (same) same.micro += toMicro(l.usd);
      else
        legs.push({
          symbol: r.symbol,
          chain: l.chain,
          micro: toMicro(l.usd),
          assetId: l.assetId,
          recipient,
        });
    }
  if (!legs.length) throw new Error('No live routes yet. Try again in a moment.');
  const refundTo = addresses.evm as string;
  const quote = await api.jarBuyQuote(token, {
    originAsset: USDC_BASE_ASSET,
    refundTo,
    slippageBps,
    legs: legs.map((l) => ({
      destinationAsset: l.assetId,
      amount: l.micro.toString(),
      recipient: l.recipient,
    })),
  });
  checkQuote(quote, legs, { refundTo, slippageBps });
  // Don't take the server's word for where a deposit address pays out: ask 1Click.
  await Promise.all(quote.legs.map((q) => verifyWithOneClick(q, refundTo)));
  return {
    quote,
    legs: legs.map(
      (l, i): BuyLeg => ({
        symbol: l.symbol,
        chain: l.chain,
        usd: fromMicro(l.micro),
        destinationAsset: l.assetId,
        depositAddress: quote.legs[i]?.depositAddress as string,
        amountIn: quote.legs[i]?.amountIn as string,
        minAmountOut: quote.legs[i]?.minAmountOut as string,
        deadline: quote.legs[i]?.deadline as string,
        status: 'NOT_SENT',
      }),
    ),
  };
}

/** Throws unless the deadline leaves time to pay and is not implausibly far off. */
export function checkDeadline(deadline: string, now = Date.now()) {
  const at = Date.parse(deadline);
  if (!Number.isFinite(at) || at < now + DEADLINE_MARGIN_MS || at > now + MAX_DEADLINE_MS)
    throw new Error('The quote expired. Review again.');
}

/**
 * The server's answer must match what was asked, leg for leg, before anything is
 * signed: same assets and amounts, payout and refund to this wallet, a minimum
 * within the slippage asked for, a live deadline, and a total under the cap.
 */
export function checkQuote(
  quote: JarBuyQuote,
  legs: Pick<AskedLeg, 'micro' | 'assetId' | 'recipient'>[],
  opts: { refundTo: string; slippageBps: number; now?: number },
): void {
  if (quote.originAsset !== USDC_BASE_ASSET || quote.legs.length !== legs.length) throw changed();
  if (opts.slippageBps < 1 || opts.slippageBps > MAX_SLIPPAGE_BPS) throw changed();
  let total = 0n;
  quote.legs.forEach((q, i) => {
    const asked = legs[i];
    const out = atomic(q.amountOut);
    const min = atomic(q.minAmountOut);
    if (
      !asked ||
      q.destinationAsset !== asked.assetId ||
      q.amountIn !== asked.micro.toString() ||
      !isAddress(q.depositAddress) ||
      q.depositMemo ||
      !sameAddress(q.recipient, asked.recipient) ||
      !sameAddress(q.refundTo, opts.refundTo) ||
      q.slippageBps !== opts.slippageBps ||
      out === null ||
      min === null ||
      min <= 0n ||
      min > out ||
      min * 10_000n < out * BigInt(10_000 - opts.slippageBps)
    )
      throw changed();
    checkDeadline(q.deadline, opts.now);
    total += asked.micro;
  });
  const capUsd = Math.min(quote.capUsd, MAX_BUY_USD);
  if (!(capUsd > 0) || total > toMicro(capUsd))
    throw new Error(`Buys are capped at $${capUsd.toFixed(0)} for now.`);
}

/**
 * Asks 1Click itself which quote a deposit address belongs to, and refuses unless it
 * pays this wallet, refunds this wallet, and matches the asset and amount.
 */
export async function verifyWithOneClick(
  leg: JarBuyLeg,
  refundTo: string,
  fetcher: typeof fetch = fetch,
) {
  const record = await fetchOneClickStatus(leg.depositAddress, fetcher);
  if (!record) throw new Error("Couldn't confirm the swap with NEAR Intents. Try again.");
  const { quoteRequest: req, quote: q } = record;
  if (
    !sameAddress(q.depositAddress, leg.depositAddress) ||
    !sameAddress(req.recipient, leg.recipient) ||
    !sameAddress(req.refundTo, refundTo) ||
    req.originAsset !== USDC_BASE_ASSET ||
    req.destinationAsset !== leg.destinationAsset ||
    String(req.amount) !== leg.amountIn ||
    String(q.amountIn) !== leg.amountIn
  )
    throw changed();
}

/**
 * Pays every leg: one USDC transfer on Base to its deposit address, signed here after
 * you confirm. Returns each leg with its transaction hash; a leg that fails to send
 * stops the rest, and already-sent legs still complete or refund on their own.
 */
export async function payJarBuy(legs: BuyLeg[], onLeg?: (legs: BuyLeg[]) => void) {
  const { id, addresses } = payer();
  const from = addresses.evm as Hex;
  const total = legs.reduce((s, l) => s + BigInt(l.amountIn), 0n);
  if (total > toMicro(MAX_BUY_USD)) throw new Error(`Buys are capped at $${MAX_BUY_USD}.`);
  for (const l of legs) checkDeadline(l.deadline);
  if (
    !(await confirmOwner(`Buy $${fromMicro(total).toFixed(2)} across ${legs.length} swaps`, true))
  )
    throw new Error('Buy cancelled.');
  const network = evmNetwork(BASE_CHAIN_ID);
  if (!network) throw new Error('Base is not available.');
  const client = createPublicClient({ transport: http(network.rpc) });
  const key = await privateKeyOf(id, 'evm');
  const out = legs.map((l) => ({ ...l }));
  try {
    if (evmAddressOfKey(key).toLowerCase() !== from.toLowerCase())
      throw new Error('Wallet key does not match.');
    const firstNonce = await client.getTransactionCount({ address: from, blockTag: 'pending' });
    for (const [i, leg] of out.entries()) {
      // The confirm prompt may have sat open; never pay into an expiring quote.
      checkDeadline(leg.deadline);
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [leg.depositAddress as Hex, BigInt(leg.amountIn)],
      });
      const prepared = await prepareEvmSend(
        { from, to: USDC_BASE, value: '0x0', data },
        BASE_CHAIN_ID,
      );
      // Each leg takes the next nonce, so legs never replace one another.
      const signed = await signEvmTransaction(key, {
        ...prepared.unsigned,
        nonce: firstNonce + i,
      });
      leg.txHash = await client.sendRawTransaction({ serializedTransaction: signed });
      leg.status = 'KNOWN_DEPOSIT_TX';
      onLeg?.(out.map((l) => ({ ...l })));
      const token = backendSessionToken();
      if (token)
        await api
          .jarBuyDeposit(token, { depositAddress: leg.depositAddress, txHash: leg.txHash })
          .catch(() => undefined); // NEAR Intents also sees the deposit on its own.
    }
  } finally {
    key.fill(0);
  }
  return out;
}

/** Latest state of each sent leg. */
export async function refreshJarBuy(legs: BuyLeg[]) {
  const token = backendSessionToken();
  if (!token) return legs;
  return Promise.all(
    legs.map(async (l) => {
      if (!l.txHash || l.status === 'SUCCESS' || l.status === 'REFUNDED' || l.status === 'FAILED')
        return l;
      const s = await api.jarBuyStatus(token, l.depositAddress).catch(() => null);
      return s ? { ...l, status: s.status } : l;
    }),
  );
}
