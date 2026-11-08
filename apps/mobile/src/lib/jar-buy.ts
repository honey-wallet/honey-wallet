/**
 * Real jar buys through NEAR Intents. The server fetches live quotes, each with a
 * one-time deposit address; this device signs one USDC transfer on Base per leg and
 * sends it. Funds go straight from the wallet to NEAR Intents, never to Honey's
 * server, and a swap that can't fill refunds to the same wallet.
 */
import type { JarBuyQuote, JarBuyState } from '@honey-wallet/api-client';
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

export type BuyLeg = {
  symbol: string;
  chain: string;
  usd: number;
  destinationAsset: string;
  depositAddress: string;
  amountIn: string;
  minAmountOut: string;
  txHash?: string;
  status: JarBuyState | 'NOT_SENT';
};

/** Your address on each chain a jar can deliver to. */
function recipientOn(chain: string, addresses: { evm?: string; solana?: string; near?: string }) {
  if (chain === 'Solana') return addresses.solana;
  if (chain === 'NEAR') return addresses.near;
  return addresses.evm;
}

const toAtomic = (usd: number) => BigInt(Math.round(usd * 10 ** USDC_DECIMALS)).toString();

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
  // NEAR Intents finds its own liquidity, so pools on the same chain merge into one
  // swap per asset; the split that remains is across chains.
  const legs: { symbol: string; chain: string; usd: number; assetId: string }[] = [];
  for (const r of routes)
    for (const l of r.legs) {
      if (!l.assetId || l.usd <= 0) continue;
      const same = legs.find((x) => x.assetId === l.assetId);
      if (same) same.usd = +(same.usd + l.usd).toFixed(2);
      else legs.push({ symbol: r.symbol, chain: l.chain, usd: l.usd, assetId: l.assetId });
    }
  if (!legs.length) throw new Error('No live routes yet. Try again in a moment.');
  const missing = legs.find((l) => !recipientOn(l.chain, addresses));
  if (missing) throw new Error(`This wallet has no ${missing.chain} address.`);
  const quote = await api.jarBuyQuote(token, {
    originAsset: USDC_BASE_ASSET,
    refundTo: addresses.evm as string,
    slippageBps: Math.max(1, Math.round(slippage * 10_000)),
    legs: legs.map((l) => ({
      destinationAsset: l.assetId,
      amount: toAtomic(l.usd),
      recipient: recipientOn(l.chain, addresses) as string,
    })),
  });
  checkQuote(quote, legs);
  return {
    quote,
    legs: legs.map(
      (l, i): BuyLeg => ({
        symbol: l.symbol,
        chain: l.chain,
        usd: l.usd,
        destinationAsset: l.assetId,
        depositAddress: quote.legs[i]?.depositAddress as string,
        amountIn: quote.legs[i]?.amountIn as string,
        minAmountOut: quote.legs[i]?.minAmountOut as string,
        status: 'NOT_SENT',
      }),
    ),
  };
}

/** The server's answer must match what was asked, leg for leg, before anything is signed. */
export function checkQuote(quote: JarBuyQuote, legs: { usd: number; assetId: string }[]): void {
  if (quote.originAsset !== USDC_BASE_ASSET || quote.legs.length !== legs.length)
    throw new Error('The quote changed. Review again.');
  quote.legs.forEach((q, i) => {
    const asked = legs[i];
    if (
      !asked ||
      q.destinationAsset !== asked.assetId ||
      q.amountIn !== toAtomic(asked.usd) ||
      !isAddress(q.depositAddress) ||
      q.depositMemo
    )
      throw new Error('The quote changed. Review again.');
  });
}

/**
 * Pays every leg: one USDC transfer on Base to its deposit address, signed here after
 * you confirm. Returns each leg with its transaction hash; a leg that fails to send
 * stops the rest, and already-sent legs still complete or refund on their own.
 */
export async function payJarBuy(legs: BuyLeg[], onLeg?: (legs: BuyLeg[]) => void) {
  const { id, addresses } = payer();
  const from = addresses.evm as Hex;
  const total = legs.reduce((s, l) => s + l.usd, 0);
  if (!(await confirmOwner(`Buy $${total.toFixed(2)} across ${legs.length} swaps`, true)))
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
