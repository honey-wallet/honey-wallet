import { createConfidentialIntents } from '@honey-wallet/api-client';
import { type MemberSigner, type StealthJar, signerFromSecretKey } from '@honey-wallet/keyring';
import { getRandomBytes } from 'expo-crypto';
import { api, resolveBaseUrl } from '@/lib/api';
import { confirmOwner } from '@/lib/auth';
import { backendSessionToken } from '@/lib/backend-session';
import { getItemAsync, setItemAsync } from '@/lib/secure-store';
import type { FlowDeps } from '@/lib/stealth-jar-flow';
import { privateKeyOf } from '@/lib/vault';

/**
 * Stealth jars (private group jars): a FROST threshold key over a fresh NEAR implicit
 * account, made by DKG through Honey's blind relay, spending through NEAR Confidential
 * Intents. Off unless EXPO_PUBLIC_STEALTH_JARS=1. Public jars stay on Sputnik DAO.
 */
export const stealthJarsEnabled = process.env.EXPO_PUBLIC_STEALTH_JARS === '1';

const INDEX_KEY = 'stealth-jars';
const jarKey = (accountId: string) => `stealth-jar.${accountId}`;

export type StoredJarRef = { accountId: string; label: string; walletId: string };

function token() {
  if (!stealthJarsEnabled) throw new Error('Private jars are not enabled');
  const value = backendSessionToken();
  if (!value) throw new Error('Sign in to use private jars');
  return value;
}

export function flowDeps(): FlowDeps {
  return {
    api,
    // Partner-key calls go through Honey's signed-in proxy; the key never ships in the app.
    oneClick: createConfidentialIntents({ apiBaseUrl: resolveBaseUrl(), token }),
    token,
    random: getRandomBytes,
    now: Date.now,
    poll: { intervalMs: 1500, timeoutMs: 10 * 60 * 1000 },
  };
}

/**
 * Runs `fn` with this wallet's long-term NEAR key as the member signer, after the
 * device-owner check. The key is wiped afterwards.
 */
export async function withMemberSigner<T>(
  walletId: string,
  reason: string,
  fn: (signer: MemberSigner) => Promise<T>,
): Promise<T> {
  if (!(await confirmOwner(reason, true))) throw new Error('Cancelled');
  const key = await privateKeyOf(walletId, 'near');
  try {
    return await fn(signerFromSecretKey(key));
  } finally {
    key.fill(0);
  }
}

export async function listStealthJars(): Promise<StoredJarRef[]> {
  const raw = await getItemAsync(INDEX_KEY);
  return raw ? (JSON.parse(raw) as StoredJarRef[]) : [];
}

export async function saveStealthJar(jar: StealthJar, label: string, walletId: string) {
  await setItemAsync(jarKey(jar.accountId), JSON.stringify(jar));
  const refs = (await listStealthJars()).filter((r) => r.accountId !== jar.accountId);
  await setItemAsync(
    INDEX_KEY,
    JSON.stringify([...refs, { accountId: jar.accountId, label, walletId }]),
  );
}

export async function loadStealthJar(accountId: string): Promise<StealthJar | null> {
  const raw = await getItemAsync(jarKey(accountId));
  return raw ? (JSON.parse(raw) as StealthJar) : null;
}
