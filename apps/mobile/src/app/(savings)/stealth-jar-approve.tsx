import type { ConfidentialBalance } from '@honey-wallet/api-client';
import type { SigningRequest, StealthJar } from '@honey-wallet/keyring';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetScreen, SheetSection, SheetText } from '@/components/sheets/Sheet';
import { isWeb } from '@/lib/platform';
import {
  flowDeps,
  listStealthJars,
  loadStealthJar,
  stealthJarsEnabled,
  withMemberSigner,
} from '@/lib/stealth-jar';
import {
  approveRequest,
  describeRequest,
  pendingRequests,
  requestBalances,
} from '@/lib/stealth-jar-flow';
import { showErrorToast, showToast } from '@/lib/toast';

const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;
const POLL_MS = 3000;

/** Approve-signing prompt for one private jar, plus its private balance. */
export default function StealthJarApproveScreen() {
  if (isWeb || !stealthJarsEnabled) return <Redirect href="/home" />;
  return <ApproveContent />;
}

function ApproveContent() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const [jar, setJar] = useState<StealthJar | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [requests, setRequests] = useState<(SigningRequest & { id: string })[]>([]);
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [balances, setBalances] = useState<ConfidentialBalance[] | null>(null);

  useEffect(() => {
    if (!accountId) return;
    loadStealthJar(accountId).then(setJar, () => {});
    listStealthJars().then(
      (refs) => setWalletId(refs.find((r) => r.accountId === accountId)?.walletId ?? null),
      () => {},
    );
  }, [accountId]);

  const refresh = useCallback(async () => {
    if (!jar) return;
    try {
      setRequests(await pendingRequests(flowDeps(), jar));
    } catch {
      // Offline or signed out: keep the last list.
    }
  }, [jar]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!jar || !walletId) return <SheetScreen title="Private jar">{null}</SheetScreen>;

  const approve = async (request: SigningRequest & { id: string }) => {
    setBusy(request.id);
    try {
      await withMemberSigner(walletId, 'Approve private jar request', (signer) =>
        approveRequest(flowDeps(), jar, signer, request),
      );
      showToast('Approved');
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : 'Could not approve');
    } finally {
      setHandled((h) => new Set(h).add(request.id));
      setBusy(null);
    }
  };

  const readBalance = async () => {
    setBusy('balance');
    try {
      const result = await withMemberSigner(walletId, 'Read private jar balance', (signer) =>
        requestBalances(flowDeps(), jar, signer),
      );
      setBalances(result);
    } catch (error) {
      showErrorToast(error instanceof Error ? error.message : 'Could not read the balance');
    } finally {
      setBusy(null);
    }
  };

  const open = requests.filter((r) => !handled.has(r.id));
  return (
    <SheetScreen title="Private jar" size="fill" scroll>
      <SheetText>
        {`${jar.threshold.min} of ${jar.threshold.max} members must approve. Account ${short(jar.accountId)}.`}
      </SheetText>

      <SheetSection title="Waiting for you" />
      {open.length === 0 ? <SheetText>No requests right now.</SheetText> : null}
      {open.map((request) => (
        <SheetRow
          key={request.id}
          title={request.summary || (request.kind === 'auth' ? 'Read balance' : 'Spend')}
          subtitle={describeRequest(request).join(' · ')}
          value={busy === request.id ? 'Signing…' : 'Approve'}
          onPress={busy ? undefined : () => approve(request)}
        />
      ))}

      <SheetSection title="Balance" />
      {balances?.map((b) => (
        <SheetRow key={b.tokenId} title={b.tokenId.replace(/^nep141:/, '')} value={b.available} />
      ))}
      <PillButton
        label={busy === 'balance' ? 'Waiting for approvals…' : 'Read private balance'}
        variant="secondary"
        disabled={!!busy}
        onPress={readBalance}
      />
    </SheetScreen>
  );
}
