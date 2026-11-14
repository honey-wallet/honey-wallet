/**
 * Honey's copy fee (since 2026-11-14, the owner's decision): Honey keeps the cut of a
 * copier's profit instead of paying it to the jar's creator. The server adds one 1Click
 * `appFees` entry for Honey's own account to the copier's sell; the phone shows it as the
 * "Honey fee" and checks 1Click's record takes exactly that (lib/intents-quote). The
 * creator-side helpers below (payout, earnings, withdraw) are no longer shown.
 *
 * Before, kept for the record:
 *
 * Creators' copy fees (2026-11-14): a cut of a copier's profit, taken by NEAR Intents
 * 1Click (`appFees`) from the copier's sell. The server works out every fee from its own
 * records (the jar's fee, what the copy cost, the creator's signed-in wallet); the phone
 * only says which published jar a sell's holdings were copied from, shows the fee the
 * server put on the quote, and checks 1Click's own record takes exactly that
 * (lib/intents-quote `checkOneClickFees`).
 */
import type { DeclaredCopyFee } from '@/lib/intents-quote';
import { formatUsd } from '@/lib/mock-wallet';
import { SOCIAL_JAR_PREFIX } from '@/lib/share-links';
import type { ThesisJar } from '@/lib/thesis';

/** The published jar (its server id) a copied jar came from, when it came from one. */
export function copiedJarId(jar: Pick<ThesisJar, 'copiedFrom'>): string | undefined {
  const id = jar.copiedFrom?.jarId;
  return id?.startsWith(SOCIAL_JAR_PREFIX) ? id.slice(SOCIAL_JAR_PREFIX.length) : undefined;
}

/** A sell's creator fee across its swaps: dollars together, at the jar's percentage. */
export type SellCopyFee = { usd: number; pct: number };

export function sellCopyFee(fees: (DeclaredCopyFee | null | undefined)[]): SellCopyFee | null {
  const charged = fees.filter((f): f is DeclaredCopyFee => !!f);
  if (!charged.length) return null;
  return {
    usd: charged.reduce((s, f) => s + f.usd, 0),
    pct: Math.max(...charged.map((f) => f.pct)),
  };
}

/** The sell review's row: "$0.12 (10% of profit)", or "None" when there's no profit to share. */
export function copyFeeText(fee: SellCopyFee | null) {
  // return fee ? `${formatUsd(fee.usd)} (${fee.pct}% of profit)` : 'None';
  if (!fee) return 'None';
  // A fee under a cent is still a fee: never "$0.00" (audit L6).
  const usd = fee.usd > 0 && fee.usd < 0.01 ? '<$0.01' : formatUsd(fee.usd);
  return `${usd} (${fee.pct}% of profit)`;
}

/**
 * A jar buy paid with tokens copied from someone's jar pays their creators' fees (the
 * server puts them on the quote, 1Click's record must match): the line it shows before
 * Face ID, or '' when there's none (audit H3).
 */
export function buyCopyFeeLine(fee: SellCopyFee | null) {
  // return fee ? `Creator's fee: ${copyFeeText(fee)}, on the copied tokens paying for this` : '';
  // Honey keeps the copy fee (2026-11-14).
  return fee ? `Honey fee: ${copyFeeText(fee)}, on the copied tokens paying for this` : '';
}

const short = (account: string) =>
  account.length > 14 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;

/**
 * Where a creator's fees go, for their own screens: their NEAR Intents account, or why
 * there's none. Empty while it loads.
 */
export function copyFeePayoutText(account: string | null | undefined) {
  if (account === undefined) return '';
  if (account === null)
    return 'You have no NEAR account Honey can pay, so no fee is collected on copies.';
  // return `Paid to your NEAR Intents account ${short(account)} when a copier sells at a profit. NEAR Intents keeps half of each fee.`;
  // Copiers see that wallet on their sell (it's who 1Click pays): say so (audit M3).
  return `Paid to your NEAR Intents account ${short(account)} when a copier sells at a profit. NEAR Intents keeps half of each fee. Copiers can see the wallet your fees are paid to.`;
}

/** Where copy fees land and how to get them out, in one plain line. */
export function withdrawLine(account: string | null | undefined) {
  if (!account) return '';
  return `Fees land in your NEAR Intents account ${short(account)}. Withdraw them in a NEAR Intents app with this wallet.`;
}

/** One jar's copies and earnings from the server's list; zeros when it isn't there. */
export function jarEarnings(
  earnings: { jars: { id: string; earnedUsd: number; copies: number }[] } | undefined,
  serverId: string | null | undefined,
) {
  const jar = serverId ? earnings?.jars.find((j) => j.id === serverId) : undefined;
  return { earnedUsd: jar?.earnedUsd ?? 0, copies: jar?.copies ?? 0, known: !!jar };
}
